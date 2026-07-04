import type { TaskStatus, TaskVerdict } from "./types.js";

// Legal transitions keyed by current status
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  DRAFT:              ["PLANNING", "CANCELLED"],
  PLANNING:           ["AWAITING_APPROVAL", "BLOCKED", "CANCELLED"],
  AWAITING_APPROVAL:  ["READY", "PLANNING", "CANCELLED"],
  READY:              ["IN_PROGRESS", "AWAITING_EVIDENCE", "CANCELLED"],
  IN_PROGRESS:        ["AWAITING_EVIDENCE", "REWORK_REQUIRED", "BLOCKED", "CANCELLED"],
  AWAITING_EVIDENCE:  ["VERIFYING", "IN_PROGRESS", "BLOCKED"],
  VERIFYING:          ["COMPLETE", "REWORK_REQUIRED", "BLOCKED", "CANCELLED"],
  COMPLETE:           [],
  REWORK_REQUIRED:    ["IN_PROGRESS", "CANCELLED"],
  BLOCKED:            ["PLANNING", "READY", "CANCELLED"],
  CANCELLED:          [],
};

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid task transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStatusFromVerdict(verdict: TaskVerdict): TaskStatus {
  switch (verdict) {
    case "COMPLETE":        return "COMPLETE";
    case "REWORK_REQUIRED": return "REWORK_REQUIRED";
    case "BLOCKED":         return "BLOCKED";
    case "CANCELLED":       return "CANCELLED";
  }
}

// Guards that must hold before specific transitions are allowed

export interface ReadinessContext {
  contractValid: boolean;
  dependenciesComplete: boolean;
  approvalsComplete: boolean;
  contextPacketAvailable: boolean;
}

export function assertReady(ctx: ReadinessContext): void {
  const errors: string[] = [];
  if (!ctx.contractValid)          errors.push("Contract validation must pass");
  if (!ctx.dependenciesComplete)   errors.push("All task dependencies must be COMPLETE");
  if (!ctx.approvalsComplete)      errors.push("All required approvals must be recorded");
  if (!ctx.contextPacketAvailable) errors.push("Context packet must be available");
  if (errors.length) throw new Error(`Task cannot become READY:\n${errors.map(e => `  - ${e}`).join("\n")}`);
}

export interface CompletionContext {
  allCriteriaHaveVerdicts: boolean;
  allRequiredEvidenceExists: boolean;
  ciChecksPassed: boolean;
  independentVerificationPassed: boolean;
  requiredHumanApprovalsRecorded: boolean;
}

export function assertComplete(ctx: CompletionContext): void {
  const errors: string[] = [];
  if (!ctx.allCriteriaHaveVerdicts)          errors.push("All acceptance criteria must have verdicts");
  if (!ctx.allRequiredEvidenceExists)         errors.push("All required evidence must exist");
  if (!ctx.ciChecksPassed)                    errors.push("Deterministic CI checks must pass");
  if (!ctx.independentVerificationPassed)     errors.push("Independent verification must find no blocker");
  if (!ctx.requiredHumanApprovalsRecorded)    errors.push("Required human approvals must be recorded");
  if (errors.length) throw new Error(`Task cannot become COMPLETE:\n${errors.map(e => `  - ${e}`).join("\n")}`);
}
