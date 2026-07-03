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
