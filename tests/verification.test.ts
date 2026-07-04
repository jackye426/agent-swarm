import test from "node:test";
import assert from "node:assert/strict";
import type { EvidenceRecord, TaskContract } from "../src/core/types.js";
import { TaskContractSchema } from "../src/core/schemas.js";
import {
  computeEffectiveMissingEvidence,
  deriveTaskVerdict,
  routeVerdictByFailureOwner,
} from "../src/core/verification.js";

const baseContract = TaskContractSchema.parse({
  id: "T-900",
  title: "Verification reconciliation",
  goal: "Test effective missing evidence.",
  status: "READY",
  owner: { product: "Product", engineering: "Engineering" },
  scope: { in: ["src"], out: [] },
  dependencies: [],
  constraints: [],
  acceptance_criteria: [
    {
      id: "AC-1",
      requirement: "Tests pass.",
      verification: ["npm test"],
    },
    {
      id: "AC-2",
      requirement: "Diff shows the change.",
      verification: ["Inspect PR diff for expected files"],
    },
  ],
  risks: [{ risk: "False rework", mitigation: "Reconcile diff verdicts." }],
  rollback: ["Revert"],
  approvals_required: ["Engineering"],
});

function evidence(partial: Partial<EvidenceRecord> & Pick<EvidenceRecord, "evidence_id" | "acceptance_criteria" | "type" | "status">): EvidenceRecord {
  return {
    task_id: "T-900",
    source: "https://example.com/ci/1",
    timestamp: "2026-07-01T12:00:00Z",
    summary: "test evidence",
    ...partial,
  };
}

test("PASS on diff AC with inconclusive evidence yields COMPLETE", () => {
  const records: EvidenceRecord[] = [
    evidence({
      evidence_id: "E-1",
      acceptance_criteria: ["AC-1"],
      type: "ci_run",
      status: "pass",
      command: "npm test",
    }),
    evidence({
      evidence_id: "E-2",
      acceptance_criteria: ["AC-2"],
      type: "ci_run",
      status: "inconclusive",
      summary: "Diff inspection deferred to verifier",
    }),
  ];

  const criterionVerdicts = { "AC-1": "PASS" as const, "AC-2": "PASS" as const };
  const missing = computeEffectiveMissingEvidence(baseContract, records, criterionVerdicts);

  assert.deepEqual(missing, []);
  assert.equal(
    deriveTaskVerdict({ criterionVerdicts, missingEvidence: missing, blockingDefects: [] }),
    "COMPLETE",
  );
});

test("INCONCLUSIVE diff AC verdict yields BLOCKED", () => {
  const records: EvidenceRecord[] = [
    evidence({
      evidence_id: "E-1",
      acceptance_criteria: ["AC-1"],
      type: "ci_run",
      status: "pass",
    }),
    evidence({
      evidence_id: "E-2",
      acceptance_criteria: ["AC-2"],
      type: "ci_run",
      status: "inconclusive",
    }),
  ];

  const criterionVerdicts = { "AC-1": "PASS" as const, "AC-2": "INCONCLUSIVE" as const };
  const missing = computeEffectiveMissingEvidence(baseContract, records, criterionVerdicts);

  assert.equal(missing.length, 1);
  assert.equal(
    deriveTaskVerdict({ criterionVerdicts, missingEvidence: missing, blockingDefects: [] }),
    "BLOCKED",
  );
});

test("missing command evidence with FAIL verdict yields REWORK_REQUIRED", () => {
  const records: EvidenceRecord[] = [
    evidence({
      evidence_id: "E-1",
      acceptance_criteria: ["AC-1"],
      type: "ci_run",
      status: "fail",
    }),
  ];

  const criterionVerdicts = { "AC-1": "FAIL" as const, "AC-2": "INCONCLUSIVE" as const };
  const missing = computeEffectiveMissingEvidence(baseContract, records, criterionVerdicts);

  assert.equal(
    deriveTaskVerdict({ criterionVerdicts, missingEvidence: missing, blockingDefects: [] }),
    "REWORK_REQUIRED",
  );
});

test("blocking defects yield REWORK_REQUIRED regardless of verdicts", () => {
  const criterionVerdicts = { "AC-1": "PASS" as const, "AC-2": "PASS" as const };
  assert.equal(
    deriveTaskVerdict({
      criterionVerdicts,
      missingEvidence: [],
      blockingDefects: ["Scope violation in src/foo.ts"],
    }),
    "REWORK_REQUIRED",
  );
});

test("verification routing sends implementation defects to rework", () => {
  assert.equal(routeVerdictByFailureOwner("BLOCKED", "implementation"), "REWORK_REQUIRED");
});

test("verification routing sends contract ambiguity to blocked planning route", () => {
  assert.equal(routeVerdictByFailureOwner("BLOCKED", "contract"), "BLOCKED");
});
