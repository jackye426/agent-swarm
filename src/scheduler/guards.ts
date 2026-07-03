import type { TaskStatus } from "../core/types.js";

/** Planning jobs are stale when the task is no longer DRAFT or PLANNING. */
export function isStalePlanningJob(status: TaskStatus): boolean {
  return status !== "DRAFT" && status !== "PLANNING";
}

/** Execution jobs are stale when the task is not READY. */
export function isStaleExecutionJob(status: TaskStatus): boolean {
  return status !== "READY";
}

/** Rework jobs are stale when the task is not REWORK_REQUIRED. */
export function isStaleReworkJob(status: TaskStatus): boolean {
  return status !== "REWORK_REQUIRED";
}

/** Verification jobs are stale when the task is not awaiting or running verification. */
export function isStaleVerificationJob(status: TaskStatus): boolean {
  return status !== "AWAITING_EVIDENCE" && status !== "VERIFYING";
}
