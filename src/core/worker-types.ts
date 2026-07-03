/** Shared worker_type strings for agent_runs — must stay in sync across scheduler and DB queries. */

export const WORKER_TYPE_PLANNING = "planning-cell";
export const WORKER_TYPE_ENGINEERING = "engineering-cell";
export const WORKER_TYPE_VERIFICATION = "verification-cell";
export const WORKER_TYPE_DESIGN = "design-cell";
export const WORKER_TYPE_RELEASE = "release-cell";
export const WORKER_TYPE_REWORK = "rework-cell";

export const WORKER_TYPE_BY_QUEUE = {
  "task.plan.requested": WORKER_TYPE_PLANNING,
  "task.execution.requested": WORKER_TYPE_ENGINEERING,
  "task.verification.requested": WORKER_TYPE_VERIFICATION,
  "task.design.requested": WORKER_TYPE_DESIGN,
  "task.release.requested": WORKER_TYPE_RELEASE,
  "task.rework.requested": WORKER_TYPE_REWORK,
} as const;
