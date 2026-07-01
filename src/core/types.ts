export type TaskStatus =
  | "DRAFT"
  | "PLANNING"
  | "AWAITING_APPROVAL"
  | "READY"
  | "IN_PROGRESS"
  | "AWAITING_EVIDENCE"
  | "VERIFYING"
  | "COMPLETE"
  | "REWORK_REQUIRED"
  | "BLOCKED"
  | "CANCELLED";

export type TaskVerdict =
  | "COMPLETE"
  | "REWORK_REQUIRED"
  | "BLOCKED"
  | "CANCELLED";

export type CriterionVerdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT_APPLICABLE";

export type EvidenceType =
  | "integration_test"
  | "unit_test"
  | "browser_test"
  | "ci_run"
  | "migration_dry_run"
  | "security_check"
  | "model_review"
  | "human_approval"
  | "audit_log_assertion"
  | "other";

export type EvidenceStatus = "pass" | "fail" | "inconclusive";

export type CellType = "planning" | "design" | "engineering" | "verification" | "release";

export type QueueJobType =
  | "task.plan.requested"
  | "task.design.requested"
  | "task.execution.requested"
  | "task.verification.requested"
  | "task.release.requested"
  | "task.rework.requested";

// --- Contract types (mirrors contract.yaml) ---

export interface AcceptanceCriterion {
  id: string;
  requirement: string;
  verification: string[];
}

export interface Risk {
  risk: string;
  mitigation: string;
}

export interface TaskOwner {
  product: string;
  engineering: string;
}

export interface TaskScope {
  in: string[];
  out: string[];
}

export interface TaskContract {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  owner: TaskOwner;
  scope: TaskScope;
  dependencies: string[];
  constraints: string[];
  acceptance_criteria: AcceptanceCriterion[];
  risks: Risk[];
  rollback: string[];
  approvals_required: string[];
}

// --- Evidence record type (mirrors evidence YAML) ---

export interface EvidenceRecord {
  evidence_id: string;
  task_id: string;
  acceptance_criteria: string[];
  type: EvidenceType;
  status: EvidenceStatus;
  commit_sha?: string;
  source: string;
  command?: string;
  timestamp: string;
  summary: string;
}

// --- DB row types ---

export interface Goal {
  id: string;
  title: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  goal_id: string | null;
  title: string;
  status: TaskStatus;
  cell: CellType;
  contract_version: number;
  repo_url: string | null;
  repo_full_name: string | null;
  source: string | null;
  source_context: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRun {
  id: string;
  task_id: string;
  cell: CellType;
  worker_type: string;
  started_at: string;
  completed_at: string | null;
  status: "running" | "complete" | "failed";
  context_packet_id: string | null;
}

export interface VerificationRecord {
  id: string;
  task_id: string;
  agent_run_id: string;
  verdict: TaskVerdict;
  blocking_defects: string[];
  missing_evidence: string[];
  regression_risks: string[];
  created_at: string;
}

export interface ApprovalRecord {
  id: string;
  task_id: string;
  approver: string;
  role: string;
  approved_at: string;
  notes: string | null;
}

export interface QueueJob {
  job_type: QueueJobType;
  task_id: string;
  payload: Record<string, unknown>;
}
