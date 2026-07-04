import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNotification } from "../src/intake/notifications.js";

test("formatNotification formats contract_validation_failed with errors", () => {
  const message = formatNotification({
    type: "contract_validation_failed",
    task_id: "T-008",
    contract_title: "Healthcheck negative path",
    errors: [
      'AC-1: verification methods are vague or unclassifiable (Works as expected)',
      "AC-2: only human verification methods — not pipeline-executable",
    ],
  });

  assert.match(message, /contract validation failed/);
  assert.match(message, /\*T-008\*/);
  assert.match(message, /Healthcheck negative path/);
  assert.match(message, /Works as expected/);
  assert.match(message, /contract_validation_failed artifact/);
});

test("formatNotification formats contract_auto_approved", () => {
  const message = formatNotification({
    type: "contract_auto_approved",
    task_id: "T-003",
    contract_title: "Engineering cell",
  });
  assert.match(message, /contract auto-approved/);
  assert.match(message, /READY for engineering/);
});

test("formatNotification formats human input requests", () => {
  const message = formatNotification({
    type: "human_input_required",
    task_id: "T-011",
    message: "AC-10 is ambiguous.",
    question: "Should runtime data be ignored and created on startup?",
  });

  assert.match(message, /INPUT NEEDED/);
  assert.match(message, /AC-10 is ambiguous/);
  assert.match(message, /runtime data/);
});

test("formatNotification formats contract revision routing", () => {
  const message = formatNotification({
    type: "contract_revision_requested",
    task_id: "T-011",
    failed_ac_ids: ["AC-10"],
    message: "Planning will repair the contract.",
  });

  assert.match(message, /contract revision requested/);
  assert.match(message, /AC-10/);
});

test("formatNotification teaches /answer on human input requests", () => {
  const message = formatNotification({
    type: "human_input_required",
    task_id: "T-011",
    question: "Which behavior do you want?",
  });
  assert.match(message, /\/answer <your decision>/);
});

test("formatNotification formats dependency_unblocked", () => {
  const message = formatNotification({
    type: "dependency_unblocked",
    task_id: "T-012",
    message: "T-012 was waiting on T-011, which is now COMPLETE.",
  });
  assert.match(message, /dependency cleared/);
  assert.match(message, /T-011/);
});

test("formatNotification formats work_integrated", () => {
  const message = formatNotification({
    type: "work_integrated",
    task_id: "T-013",
    message: "T-013's changes were merged into the default branch.",
  });

  assert.match(message, /work integrated/);
  assert.match(message, /default branch/);
});

test("formatNotification formats integration_conflict", () => {
  const message = formatNotification({
    type: "integration_conflict",
    task_id: "T-014",
    message: "T-014 is COMPLETE but could not be merged automatically.",
  });

  assert.match(message, /integration needs attention/);
  assert.match(message, /could not be merged/);
});
