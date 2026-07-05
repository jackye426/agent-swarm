import test from "node:test";
import assert from "node:assert/strict";
import { ReworkRequestedPayloadSchema, normalizeTextList } from "../src/core/queue-schemas.js";

test("normalizeTextList converts structured verifier defects into strings", () => {
  assert.deepEqual(
    normalizeTextList([
      { id: "AC-3", description: "Manual test report is missing." },
      "Plain defect",
    ]),
    ["AC-3: Manual test report is missing.", "Plain defect"],
  );
});

test("ReworkRequestedPayloadSchema accepts legacy object-shaped blocking defects", () => {
  const parsed = ReworkRequestedPayloadSchema.parse({
    task_id: "T-013",
    blocking_defects: [{ id: "AC-3", description: "Manual test report is missing." }],
    missing_evidence: [],
    rework_attempt: 2,
  });

  assert.deepEqual(parsed.blocking_defects, ["AC-3: Manual test report is missing."]);
});
