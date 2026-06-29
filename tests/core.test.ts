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
import { modelForRole } from "../src/core/model-router.js";

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
