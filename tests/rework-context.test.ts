import test from "node:test";
import assert from "node:assert/strict";
import { formatReworkContextForEngineering } from "../src/core/rework-context.js";
import type { TaskContract } from "../src/core/types.js";

const contract: TaskContract = {
  id: "T-008",
  title: "Healthcheck self-test",
  goal: "Add self-test to healthcheck.js",
  scope: { in: ["scripts/healthcheck.js", "README.md"], out: ["package-lock.json", ".gitignore"] },
  acceptance_criteria: [
    { id: "AC-5", requirement: "Only allowed files in diff", verification: ["diff"] },
    { id: "AC-6", requirement: "README documents usage", verification: ["diff"] },
    { id: "AC-7", requirement: "Positive self-test exits 0", verification: ["command"] },
  ],
  approvals_required: [],
  dependencies: [],
  constraints: [],
  version: 1,
};

test("formatReworkContextForEngineering includes full contract and preserve guidance", () => {
  const text = formatReworkContextForEngineering({
    contract,
    baseContext: "Repo context here.",
    reworkAttempt: 2,
    blockingDefects: ["AC-6: README missing usage docs"],
    missingEvidence: ["AC-6: no passing evidence record found"],
    verdict: "BLOCKED",
    criterionVerdicts: { "AC-5": "PASS", "AC-6": "FAIL", "AC-7": "PASS" },
  });

  assert.match(text, /Repo context here/);
  assert.match(text, /Contract: T-008/);
  assert.match(text, /AC-5: PASS \(preserve\)/);
  assert.match(text, /AC-6: FAIL \(fix\)/);
  assert.match(text, /AC-7: PASS \(preserve\)/);
  assert.match(text, /without regressing any criterion currently marked PASS/);
  assert.match(text, /AC-6: README missing usage docs/);
});
