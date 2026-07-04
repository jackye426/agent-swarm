import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  AlertDeduper,
  evaluateDiskFree,
  evaluateQueueDepth,
  findCredentialFailures,
  findStaleRunningAgentRuns,
  findStuckTasks,
} from "../scripts/lib/watchdog-checks.js";

const NOW = Date.parse("2026-07-03T12:00:00Z");
const minutesAgo = (min: number) => new Date(NOW - min * 60_000).toISOString();

test("findStuckTasks flags active tasks past the threshold", () => {
  const alerts = findStuckTasks(
    [
      { id: "T-010", status: "IN_PROGRESS", updated_at: minutesAgo(50) },
      { id: "T-011", status: "VERIFYING", updated_at: minutesAgo(10) },
    ],
    NOW,
    45 * 60_000,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.key, "stuck:T-010:IN_PROGRESS");
  assert.match(alerts[0]!.message, /50 min/);
  assert.match(alerts[0]!.message, /recover:verdict -- T-010/);
});

test("findStuckTasks ignores non-active statuses regardless of age", () => {
  const alerts = findStuckTasks(
    [
      { id: "T-001", status: "COMPLETE", updated_at: minutesAgo(10_000) },
      { id: "T-002", status: "BLOCKED", updated_at: minutesAgo(10_000) },
      { id: "T-003", status: "AWAITING_APPROVAL", updated_at: minutesAgo(10_000) },
    ],
    NOW,
    45 * 60_000,
  );
  assert.equal(alerts.length, 0);
});

test("findStaleRunningAgentRuns flags old running agent runs", () => {
  const alerts = findStaleRunningAgentRuns(
    [
      {
        id: "run-old",
        task_id: "T-012",
        worker_type: "rework-cell",
        status: "running",
        started_at: minutesAgo(50),
      },
      {
        id: "run-new",
        task_id: "T-013",
        worker_type: "engineering-cell",
        status: "running",
        started_at: minutesAgo(10),
      },
      {
        id: "run-complete",
        task_id: "T-014",
        worker_type: "engineering-cell",
        status: "complete",
        started_at: minutesAgo(90),
      },
    ],
    NOW,
    45 * 60_000,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.key, "stale_run:run-old");
  assert.match(alerts[0]!.message, /T-012/);
  assert.match(alerts[0]!.message, /recover:stale-rework/);
});

test("findCredentialFailures matches 402 and fetch failed, one alert, deduped by task", () => {
  const alerts = findCredentialFailures([
    { task_id: "T-010", payload: { reason: "OpenRouter returned 402 Payment Required" } },
    { task_id: "T-010", payload: { reason: "TypeError: fetch failed" } },
    { task_id: "T-011", payload: { reason: "TypeError: fetch failed" } },
    { task_id: "T-012", payload: { reason: "assertion failed in tests" } },
    { task_id: "T-013", payload: null },
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.key, "credential_failures");
  assert.match(alerts[0]!.message, /T-010/);
  assert.match(alerts[0]!.message, /T-011/);
  assert.doesNotMatch(alerts[0]!.message, /T-012/);
});

test("findCredentialFailures returns nothing for benign failures", () => {
  assert.deepEqual(
    findCredentialFailures([{ task_id: "T-012", payload: { reason: "tests failed" } }]),
    [],
  );
});

test("evaluateQueueDepth alerts only above threshold", () => {
  const alerts = evaluateQueueDepth(
    [
      { queue: "task_plan_requested", length: 11 },
      { queue: "task_execution_requested", length: 10 },
    ],
    10,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.key, "queue_depth:task_plan_requested");
});

test("evaluateDiskFree alerts under the minimum", () => {
  const gb = 1024 ** 3;
  assert.equal(evaluateDiskFree(10 * gb, 5, "C:\\tmp").length, 0);
  const alerts = evaluateDiskFree(2 * gb, 5, "C:\\tmp");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!.message, /2\.0 GB free/);
});

test("AlertDeduper suppresses repeats until realert window passes", () => {
  const deduper = new AlertDeduper(60_000);
  assert.equal(deduper.shouldSend("k", NOW), true);
  assert.equal(deduper.shouldSend("k", NOW + 30_000), false);
  assert.equal(deduper.shouldSend("k", NOW + 61_000), true);
});

test("AlertDeduper re-alerts immediately after a condition clears and returns", () => {
  const deduper = new AlertDeduper(60_000);
  assert.equal(deduper.shouldSend("k", NOW), true);
  deduper.clearExcept(new Set()); // condition cleared this cycle
  assert.equal(deduper.shouldSend("k", NOW + 1_000), true); // returns → alert again
});
