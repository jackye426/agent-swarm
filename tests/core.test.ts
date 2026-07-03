import test from "node:test";
import assert from "node:assert/strict";
import {
  EvidenceRecordSchema,
  TaskContractSchema,
  checkCriteriaFullyCovered,
  validateEvidenceAgainstContract,
} from "../src/core/schemas.js";
import { assertComplete, assertTransition, canTransition } from "../src/core/state-machine.js";
import { physicalQueueName } from "../src/core/queue-names.js";
import { deriveTaskVerdict, findMissingEvidence } from "../src/core/verification.js";
import { maxTokensForRole, modelForRole } from "../src/core/model-router.js";
import {
  classifyVerificationMethod,
  primaryAcKind,
  validateContractExecutability,
  resolveTestCommandsFromPacket,
  formatContextForEngineering,
  formatCompactContextForReview,
} from "../src/core/contract-executability.js";

const contract = TaskContractSchema.parse({
  id: "T-999",
  title: "Test contract",
  goal: "Prove contract and evidence behavior.",
  status: "READY",
  owner: {
    product: "Product",
    engineering: "Engineering",
  },
  scope: {
    in: ["Validation"],
    out: [],
  },
  dependencies: [],
  constraints: ["No placeholder evidence"],
  acceptance_criteria: [
    {
      id: "AC-1",
      requirement: "First criterion is covered.",
      verification: ["Unit test"],
    },
    {
      id: "AC-2",
      requirement: "Second criterion is covered.",
      verification: ["Unit test"],
    },
  ],
  risks: [
    {
      risk: "False completion",
      mitigation: "Require passing evidence for each criterion.",
    },
  ],
  rollback: ["Remove invalid evidence"],
  approvals_required: ["Engineering"],
});

test("contract schema rejects duplicate acceptance criterion IDs", () => {
  const result = TaskContractSchema.safeParse({
    ...contract,
    acceptance_criteria: [
      contract.acceptance_criteria[0],
      contract.acceptance_criteria[0],
    ],
  });

  assert.equal(result.success, false);
});

test("evidence schema rejects placeholder and non-hex commit SHAs", () => {
  const result = EvidenceRecordSchema.safeParse({
    evidence_id: "E-999",
    task_id: "T-999",
    acceptance_criteria: ["AC-1"],
    type: "integration_test",
    status: "pass",
    commit_sha: "placeholder-replace-with-real-sha",
    source: "https://github.com/your-org/taskgraph-os/actions/runs/1",
    command: "npm run validate:evidence",
    timestamp: "2026-06-29T12:00:00Z",
    summary: "placeholder evidence",
  });

  assert.equal(result.success, false);
});

test("evidence cross-validation rejects unknown criteria", () => {
  const evidence = EvidenceRecordSchema.parse({
    evidence_id: "E-999",
    task_id: "T-999",
    acceptance_criteria: ["AC-404"],
    type: "unit_test",
    status: "pass",
    commit_sha: "abcdef1234567890abcdef1234567890abcdef12",
    source: "https://github.com/taskgraph-os/taskgraph-os/actions/runs/999",
    command: "npm test",
    timestamp: "2026-06-29T12:00:00Z",
    summary: "Valid shape, invalid criterion reference.",
  });

  assert.deepEqual(validateEvidenceAgainstContract(evidence, contract), [
    "Evidence E-999 references unknown criterion AC-404 (not in contract T-999)",
  ]);
});

test("coverage check requires passing evidence for every criterion", () => {
  const evidence = EvidenceRecordSchema.parse({
    evidence_id: "E-001",
    task_id: "T-999",
    acceptance_criteria: ["AC-1"],
    type: "unit_test",
    status: "pass",
    commit_sha: "abcdef1234567890abcdef1234567890abcdef12",
    source: "https://github.com/taskgraph-os/taskgraph-os/actions/runs/1",
    command: "npm test",
    timestamp: "2026-06-29T12:00:00Z",
    summary: "AC-1 is covered.",
  });

  const result = checkCriteriaFullyCovered(contract, [evidence]);
  assert.deepEqual(result.missing, ["AC-2"]);
});

test("state machine allows only legal transitions", () => {
  assert.equal(canTransition("READY", "IN_PROGRESS"), true);
  assert.equal(canTransition("READY", "COMPLETE"), false);
  assert.throws(() => assertTransition("READY", "COMPLETE"), /Invalid task transition/);
});

test("completion guard rejects missing evidence and approvals", () => {
  assert.throws(
    () =>
      assertComplete({
        allCriteriaHaveVerdicts: true,
        allRequiredEvidenceExists: false,
        ciChecksPassed: true,
        independentVerificationPassed: true,
        requiredHumanApprovalsRecorded: false,
      }),
    /Task cannot become COMPLETE/
  );
});

test("queue names are mapped to SQL-safe physical names", () => {
  assert.equal(physicalQueueName("task.verification.requested"), "task_verification_requested");
});

test("verification helpers require passing evidence for completion", () => {
  assert.deepEqual(findMissingEvidence(contract, []), [
    "AC-1: no passing evidence record found",
    "AC-2: no passing evidence record found",
  ]);

  assert.equal(
    deriveTaskVerdict({
      criterionVerdicts: { "AC-1": "PASS", "AC-2": "INCONCLUSIVE" },
      missingEvidence: [],
      blockingDefects: [],
    }),
    "BLOCKED"
  );
});

test("verification method taxonomy classifies command, diff, and human methods", () => {
  assert.equal(classifyVerificationMethod("npm test"), "command");
  assert.equal(classifyVerificationMethod("Inspect workflow steps in diff"), "diff_inspection");
  assert.equal(classifyVerificationMethod("Manual review by Engineering Owner"), "human");
  assert.equal(classifyVerificationMethod("Works as expected"), "unknown");
});

test("executability rejects human-only acceptance criteria", () => {
  const humanOnly = {
    ...contract,
    acceptance_criteria: [
      {
        id: "AC-1",
        requirement: "Someone looks at it.",
        verification: ["Manual review by Engineering Owner"],
      },
    ],
  };
  const result = validateContractExecutability(humanOnly);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("AC-1")));
});

test("executability accepts diff-inspection criteria (T-003 style)", () => {
  const diffContract = {
    ...contract,
    acceptance_criteria: [
      {
        id: "AC-1",
        requirement: ".github/workflows/ci.yml exists.",
        verification: ["File presence check in PR diff"],
      },
      {
        id: "AC-2",
        requirement: "Tests pass in CI.",
        verification: ["npm test"],
      },
    ],
  };
  const result = validateContractExecutability(diffContract);
  assert.equal(result.ok, true);
  assert.equal(primaryAcKind(result.acClassifications["AC-1"]!), "diff_inspection");
});

test("executability warns on command mismatch against seed test commands", () => {
  const cmdContract = {
    ...contract,
    acceptance_criteria: [
      {
        id: "AC-1",
        requirement: "Custom script passes.",
        verification: ["npm run custom:check"],
      },
    ],
  };
  const result = validateContractExecutability(cmdContract, {
    testCommands: ["npm test"],
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("custom:check")));
  assert.equal(result.errors.length, 0);
});

test("resolveTestCommandsFromPacket prefers payload then packet then seed", () => {
  const packet = {
    test_commands: ["npm run typecheck"],
    seed: { test_commands: ["npm test"] },
  };
  assert.deepEqual(resolveTestCommandsFromPacket(packet, ["npm run validate"]), ["npm run validate"]);
  assert.deepEqual(resolveTestCommandsFromPacket(packet), ["npm run typecheck"]);
  assert.deepEqual(resolveTestCommandsFromPacket({ seed: { test_commands: ["npm test"] } }), ["npm test"]);
});

test("executability accepts diff-only contracts (T-003 reference)", () => {
  const t003Style = {
    ...contract,
    acceptance_criteria: [
      {
        id: "AC-1",
        requirement: ".github/workflows/ci.yml exists.",
        verification: ["File presence check in PR diff"],
      },
      {
        id: "AC-2",
        requirement: "Workflow triggers on push and pull_request.",
        verification: ["Inspect workflow on/push/branches fields in diff"],
      },
    ],
  };
  const result = validateContractExecutability(t003Style, { requireCommandAc: true });
  assert.equal(result.ok, true);
});

test("formatContextForEngineering uses planning_context when present", () => {
  const formatted = formatContextForEngineering({
    planning_context: "User goal context\n--- Seed repo context ---",
  });
  assert.match(formatted, /User goal context/);
});

test("formatCompactContextForReview keeps goal, test commands, and README under budget", () => {
  const fileTree = Array.from({ length: 120 }, (_, i) => `file-${i}.ts`).join("\n");
  const readme = "A".repeat(2_000);
  const planningContext = [
    "Add negative-path healthcheck test.",
    "",
    "--- Seed repo context ---",
    "Repository: owner/repo",
    "",
    "File tree (top levels):",
    fileTree,
    "",
    "README excerpt:",
    readme,
    "",
    "Package manifest (package.json):",
    '{"name":"repo"}',
    "",
    "Detected test commands:",
    "- npm test",
    "- npm run test:negative",
    "",
    "Recent commits:",
    "- abc123 initial",
  ].join("\n");

  const compact = formatCompactContextForReview(planningContext, 3_000);
  assert.match(compact, /Add negative-path healthcheck test/);
  assert.match(compact, /npm test/);
  assert.match(compact, /README excerpt:/);
  assert.ok(compact.length <= 3_050);
  assert.ok(!compact.includes("Recent commits:"));
  assert.ok(!compact.includes("Package manifest"));
  const treeLines = compact.split("\n").filter((line) => line.startsWith("file-"));
  assert.ok(treeLines.length <= 80);
});

test("model router resolves role-specific model overrides", () => {
  const previous = process.env.MODEL_VERIFICATION;
  process.env.MODEL_VERIFICATION = "openai/test-verifier";

  try {
    assert.equal(modelForRole("verification"), "openai/test-verifier");
  } finally {
    if (previous === undefined) {
      delete process.env.MODEL_VERIFICATION;
    } else {
      process.env.MODEL_VERIFICATION = previous;
    }
  }
});

test("model router caps verification max tokens by default", () => {
  const previous = process.env.MODEL_VERIFICATION_MAX_TOKENS;
  delete process.env.MODEL_VERIFICATION_MAX_TOKENS;

  try {
    assert.equal(maxTokensForRole("verification"), 8192);
  } finally {
    if (previous !== undefined) {
      process.env.MODEL_VERIFICATION_MAX_TOKENS = previous;
    }
  }
});
