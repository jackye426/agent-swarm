import test from "node:test";
import assert from "node:assert/strict";
import type { TaskStatus } from "../src/core/types.js";
import {
  isStaleExecutionJob,
  isStalePlanningJob,
  isStaleReworkJob,
  isStaleVerificationJob,
} from "../src/scheduler/guards.js";

test("stale planning job when status is not DRAFT or PLANNING", () => {
  assert.equal(isStalePlanningJob("READY" as TaskStatus), true);
  assert.equal(isStalePlanningJob("DRAFT" as TaskStatus), false);
  assert.equal(isStalePlanningJob("PLANNING" as TaskStatus), false);
});

test("rework only when REWORK_REQUIRED", () => {
  assert.equal(isStaleReworkJob("REWORK_REQUIRED" as TaskStatus), false);
  assert.equal(isStaleReworkJob("AWAITING_EVIDENCE" as TaskStatus), true);
});

test("execution stale when not READY", () => {
  assert.equal(isStaleExecutionJob("READY" as TaskStatus), false);
  assert.equal(isStaleExecutionJob("IN_PROGRESS" as TaskStatus), true);
});

test("verification accepts AWAITING_EVIDENCE and VERIFYING", () => {
  assert.equal(isStaleVerificationJob("AWAITING_EVIDENCE" as TaskStatus), false);
  assert.equal(isStaleVerificationJob("VERIFYING" as TaskStatus), false);
  assert.equal(isStaleVerificationJob("COMPLETE" as TaskStatus), true);
});
