import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatTaskStatusMessage } from "../src/intake/status-format.js";

test("formatTaskStatusMessage uses plain text safe for Markdown-sensitive statuses", () => {
  const message = formatTaskStatusMessage({
    id: "T-013",
    title: "Add AI analysis endpoint to the backend",
    status: "AWAITING_APPROVAL",
    repo_full_name: "jackye426/swarm-sandbox",
    updated_at: "2026-07-05T07:41:01.228766+00:00",
  });

  assert.match(message, /T-013 - AWAITING_APPROVAL/);
  assert.match(message, /Repo: jackye426\/swarm-sandbox/);
  assert.doesNotMatch(message, /[*`]/);
});
