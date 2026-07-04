import { db } from "./client.js";
import type {
  AgentRun,
  CellType,
  CriterionVerdict,
  EvidenceRecord,
  TaskContract,
  TaskVerdict,
  VerificationFailureOwner,
} from "../core/types.js";
import {
  buildExecutionReadyPacket,
  type ExecutabilityResult,
} from "../core/contract-executability.js";
import type { SeedRepoContext } from "../intake/repo-scanner.js";
import { WORKER_TYPE_REWORK } from "../core/worker-types.js";

type JsonObject = Record<string, unknown>;

function assertNoError(error: { message: string } | null, message: string): void {
  if (error) throw new Error(`${message}: ${error.message}`);
}

export interface CreateAgentRunInput {
  taskId: string;
  cell: CellType;
  workerType: string;
  contextPacketId?: string | null;
}

export async function createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
  const { data, error } = await db
    .from("agent_runs")
    .insert({
      task_id: input.taskId,
      cell: input.cell,
      worker_type: input.workerType,
      context_packet_id: input.contextPacketId ?? null,
    })
    .select("*")
    .single();

  assertNoError(error, `Failed to create agent run for ${input.taskId}`);
  return data as AgentRun;
}

export async function completeAgentRun(agentRunId: string): Promise<void> {
  const { error } = await db
    .from("agent_runs")
    .update({ status: "complete", completed_at: new Date().toISOString() })
    .eq("id", agentRunId);

  assertNoError(error, `Failed to complete agent run ${agentRunId}`);
}

export async function failAgentRun(agentRunId: string, reason: string): Promise<void> {
  const { error: updateError } = await db
    .from("agent_runs")
    .update({ status: "failed", completed_at: new Date().toISOString() })
    .eq("id", agentRunId);

  assertNoError(updateError, `Failed to mark agent run ${agentRunId} failed`);

  const { error: eventError } = await db.from("task_events").insert({
    task_id: await taskIdForAgentRun(agentRunId),
    event_type: "agent_run_failed",
    actor: "scheduler",
    payload: { agent_run_id: agentRunId, reason },
  });

  assertNoError(eventError, `Failed to record failure event for agent run ${agentRunId}`);
}

async function taskIdForAgentRun(agentRunId: string): Promise<string> {
  const { data, error } = await db
    .from("agent_runs")
    .select("task_id")
    .eq("id", agentRunId)
    .single();

  assertNoError(error, `Failed to load task id for agent run ${agentRunId}`);
  return (data as { task_id: string }).task_id;
}

export interface RecordArtifactInput {
  taskId: string;
  artifactType: string;
  url?: string | null;
  content?: unknown;
}

export async function recordArtifact(input: RecordArtifactInput): Promise<string> {
  const { data, error } = await db
    .from("artifacts")
    .insert({
      task_id: input.taskId,
      artifact_type: input.artifactType,
      url: input.url ?? null,
      content: typeof input.content === "string" ? { text: input.content } : input.content ?? null,
    })
    .select("id")
    .single();

  assertNoError(error, `Failed to record artifact ${input.artifactType} for ${input.taskId}`);
  return (data as { id: string }).id;
}

export interface LatestEngineeringWorktree {
  path?: string;
  branch?: string;
  baseSha?: string | null;
  headSha?: string | null;
}

export async function getLatestEngineeringWorktree(
  taskId: string,
): Promise<LatestEngineeringWorktree | null> {
  const { data, error } = await db
    .from("artifacts")
    .select("content")
    .eq("task_id", taskId)
    .eq("artifact_type", "engineering_worktree")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  assertNoError(error, `Failed to load engineering worktree for ${taskId}`);
  if (!data?.content) return null;

  const content = data.content as {
    path?: string;
    branch?: string;
    base_sha?: string | null;
    head_sha?: string | null;
  };

  return {
    path: content.path,
    branch: content.branch,
    baseSha: content.base_sha ?? null,
    headSha: content.head_sha ?? null,
  };
}

export async function publishContractVersion(taskId: string, contract: TaskContract): Promise<number> {
  const { data: latest, error: latestError } = await db
    .from("task_contract_versions")
    .select("version")
    .eq("task_id", taskId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  assertNoError(latestError, `Failed to load latest contract version for ${taskId}`);
  const version = ((latest as { version: number } | null)?.version ?? 0) + 1;

  const { error: insertError } = await db
    .from("task_contract_versions")
    .insert({ task_id: taskId, version, contract });

  assertNoError(insertError, `Failed to publish contract version for ${taskId}`);

  const { error: updateError } = await db
    .from("tasks")
    .update({ title: contract.title, contract_version: version })
    .eq("id", taskId);

  assertNoError(updateError, `Failed to update task ${taskId} contract version`);
  return version;
}

export async function getLatestContract(taskId: string): Promise<TaskContract> {
  const { data, error } = await db
    .from("task_contract_versions")
    .select("contract")
    .eq("task_id", taskId)
    .order("version", { ascending: false })
    .limit(1)
    .single();

  assertNoError(error, `Failed to load latest contract for ${taskId}`);
  return (data as { contract: TaskContract }).contract;
}

export async function createContextPacket(taskId: string, content: JsonObject): Promise<string> {
  const { data: latest, error: latestError } = await db
    .from("context_packets")
    .select("version")
    .eq("task_id", taskId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  assertNoError(latestError, `Failed to load latest context packet version for ${taskId}`);
  const version = ((latest as { version: number } | null)?.version ?? 0) + 1;

  const { data, error } = await db
    .from("context_packets")
    .insert({ task_id: taskId, version, content })
    .select("id")
    .single();

  assertNoError(error, `Failed to create context packet for ${taskId}`);
  return (data as { id: string }).id;
}

export async function enrichExecutionContextPacket(
  taskId: string,
  contract: TaskContract,
  packet: JsonObject,
  executability: ExecutabilityResult,
): Promise<string> {
  const seed = (packet.seed ?? null) as SeedRepoContext | null;
  const content = buildExecutionReadyPacket({
    repoFullName:
      (typeof packet.repo_full_name === "string" ? packet.repo_full_name : null) ??
      seed?.repo_full_name ??
      "",
    userContext: typeof packet.user_context === "string" ? packet.user_context : "",
    planningContext: typeof packet.planning_context === "string" ? packet.planning_context : "",
    seed,
    contract,
    executability,
  });
  return createContextPacket(taskId, content);
}

export async function getLatestContextPacket(taskId: string): Promise<JsonObject | null> {
  const { data, error } = await db
    .from("context_packets")
    .select("content")
    .eq("task_id", taskId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  assertNoError(error, `Failed to load latest context packet for ${taskId}`);
  return (data as { content: JsonObject } | null)?.content ?? null;
}

export async function recordEvidence(input: EvidenceRecord & { agentRunId?: string | null }): Promise<void> {
  const { error } = await db.from("evidence_records").upsert({
    id: input.evidence_id,
    task_id: input.task_id,
    agent_run_id: input.agentRunId ?? null,
    acceptance_criteria: input.acceptance_criteria,
    evidence_type: input.type,
    status: input.status,
    commit_sha: input.commit_sha ?? null,
    source: input.source,
    command: input.command ?? null,
    recorded_at: input.timestamp,
    summary: input.summary,
  });

  assertNoError(error, `Failed to record evidence ${input.evidence_id}`);
}

export async function listEvidenceRecords(taskId: string): Promise<EvidenceRecord[]> {
  const { data, error } = await db
    .from("evidence_records")
    .select("*")
    .eq("task_id", taskId);

  assertNoError(error, `Failed to list evidence records for ${taskId}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    evidence_id: row.id as string,
    task_id: row.task_id as string,
    acceptance_criteria: row.acceptance_criteria as string[],
    type: row.evidence_type as EvidenceRecord["type"],
    status: row.status as EvidenceRecord["status"],
    commit_sha: row.commit_sha as string | undefined,
    source: row.source as string,
    command: row.command as string | undefined,
    timestamp: row.recorded_at as string,
    summary: row.summary as string,
  }));
}

export interface RecordVerificationInput {
  taskId: string;
  agentRunId: string;
  verdict: TaskVerdict;
  blockingDefects: string[];
  missingEvidence: string[];
  regressionRisks: string[];
  criterionVerdicts: Record<string, CriterionVerdict>;
  failureOwner?: VerificationFailureOwner;
  failedAcIds?: string[];
  failureSummary?: string;
  recommendedNextStep?: string;
  questionForUser?: string;
}

export async function recordVerification(input: RecordVerificationInput): Promise<string> {
  const { data, error } = await db
    .from("verification_records")
    .insert({
      task_id: input.taskId,
      agent_run_id: input.agentRunId,
      verdict: input.verdict,
      blocking_defects: input.blockingDefects,
      missing_evidence: input.missingEvidence,
      regression_risks: input.regressionRisks,
      criterion_verdicts: input.criterionVerdicts,
      failure_owner: input.failureOwner ?? null,
      failed_ac_ids: input.failedAcIds ?? [],
      failure_summary: input.failureSummary ?? null,
      recommended_next_step: input.recommendedNextStep ?? null,
      question_for_user: input.questionForUser ?? null,
    })
    .select("id")
    .single();

  assertNoError(error, `Failed to record verification for ${input.taskId}`);
  return (data as { id: string }).id;
}

export interface LatestVerificationRecord {
  verdict: TaskVerdict;
  blockingDefects: string[];
  missingEvidence: string[];
  criterionVerdicts: Record<string, CriterionVerdict>;
  failureOwner?: VerificationFailureOwner | null;
  failedAcIds?: string[];
  failureSummary?: string | null;
  recommendedNextStep?: string | null;
  questionForUser?: string | null;
}

export async function getLatestVerificationRecord(
  taskId: string,
): Promise<LatestVerificationRecord | null> {
  const { data, error } = await db
    .from("verification_records")
    .select("verdict, blocking_defects, missing_evidence, criterion_verdicts, failure_owner, failed_ac_ids, failure_summary, recommended_next_step, question_for_user")
    .eq("task_id", taskId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to load verification for ${taskId}: ${error.message}`);
  if (!data) return null;

  const row = data as {
    verdict: TaskVerdict;
    blocking_defects: string[];
    missing_evidence: string[];
    criterion_verdicts: Record<string, CriterionVerdict>;
    failure_owner?: VerificationFailureOwner | null;
    failed_ac_ids?: string[] | null;
    failure_summary?: string | null;
    recommended_next_step?: string | null;
    question_for_user?: string | null;
  };

  return {
    verdict: row.verdict,
    blockingDefects: row.blocking_defects ?? [],
    missingEvidence: row.missing_evidence ?? [],
    criterionVerdicts: row.criterion_verdicts ?? {},
    failureOwner: row.failure_owner ?? null,
    failedAcIds: row.failed_ac_ids ?? [],
    failureSummary: row.failure_summary ?? null,
    recommendedNextStep: row.recommended_next_step ?? null,
    questionForUser: row.question_for_user ?? null,
  };
}

export async function recordApproval(input: {
  taskId: string;
  approver: string;
  role: string;
  notes?: string | null;
}): Promise<void> {
  const { error } = await db.from("approval_records").insert({
    task_id: input.taskId,
    approver: input.approver,
    role: input.role,
    notes: input.notes ?? null,
  });

  assertNoError(error, `Failed to record ${input.role} approval for ${input.taskId}`);
}

export async function requiredApprovalsRecorded(taskId: string, requiredRoles: string[]): Promise<boolean> {
  if (requiredRoles.length === 0) return true;

  const { data, error } = await db
    .from("approval_records")
    .select("role")
    .eq("task_id", taskId)
    .in("role", requiredRoles);

  assertNoError(error, `Failed to load approvals for ${taskId}`);
  const approvedRoles = new Set(((data ?? []) as Array<{ role: string }>).map((row) => row.role));
  return requiredRoles.every((role) => approvedRoles.has(role));
}

export async function getReworkAttemptCount(taskId: string): Promise<number> {
  const { data: latestApproval, error: approvalError } = await db
    .from("artifacts")
    .select("created_at")
    .eq("task_id", taskId)
    .eq("artifact_type", "approved_contract")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  assertNoError(approvalError, `Failed to load latest approved contract for ${taskId}`);

  let query = db
    .from("agent_runs")
    .select("*", { count: "exact", head: true })
    .eq("task_id", taskId)
    .eq("worker_type", WORKER_TYPE_REWORK);

  const approvedAt = (latestApproval as { created_at?: string } | null)?.created_at;
  if (approvedAt) {
    query = query.gte("started_at", approvedAt);
  }

  const { count, error } = await query;

  assertNoError(error, `Failed to count rework attempts for ${taskId}`);
  return count ?? 0;
}

export interface RecordDecisionInput {
  taskId: string | null;
  title: string;
  decision: string;
  rationale: string;
  madeBy: string;
}

export async function recordDecision(input: RecordDecisionInput): Promise<string> {
  const { data, error } = await db
    .from("decision_records")
    .insert({
      task_id: input.taskId,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale,
      made_by: input.madeBy,
    })
    .select("id")
    .single();

  assertNoError(error, `Failed to record decision "${input.title}"`);
  return (data as { id: string }).id;
}

export async function findDecisionByTitle(title: string): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from("decision_records")
    .select("id")
    .eq("title", title)
    .maybeSingle();

  assertNoError(error, `Failed to look up decision "${title}"`);
  return data as { id: string } | null;
}

export async function dependenciesComplete(taskId: string): Promise<boolean> {
  const { data, error } = await db.rpc("task_dependencies_complete", { p_task_id: taskId });
  assertNoError(error, `Failed to check dependencies for ${taskId}`);
  return Boolean(data);
}

/** Tasks that declare `taskId` as a dependency (i.e. are waiting on it). */
export async function getDependentTaskIds(taskId: string): Promise<string[]> {
  const { data, error } = await db
    .from("task_dependencies")
    .select("task_id")
    .eq("depends_on_id", taskId);
  assertNoError(error, `Failed to load dependents of ${taskId}`);
  return ((data ?? []) as Array<{ task_id: string }>).map((row) => row.task_id);
}

export async function getChatRepoBinding(chatId: string): Promise<string | null> {
  const { data, error } = await db
    .from("chat_repo_bindings")
    .select("repo_full_name")
    .eq("chat_id", chatId)
    .maybeSingle();

  assertNoError(error, `Failed to load chat repo binding for ${chatId}`);
  return (data as { repo_full_name: string } | null)?.repo_full_name ?? null;
}

export async function setChatRepoBinding(chatId: string, repoFullName: string): Promise<void> {
  const { error } = await db.from("chat_repo_bindings").upsert({
    chat_id: chatId,
    repo_full_name: repoFullName,
    updated_at: new Date().toISOString(),
  });

  assertNoError(error, `Failed to set chat repo binding for ${chatId}`);
}

export interface TaskRepoInfo {
  repoUrl: string | null;
  repoFullName: string | null;
  source: string | null;
  sourceContext: JsonObject | null;
}

export async function getTaskRepo(taskId: string): Promise<TaskRepoInfo> {
  const { data, error } = await db
    .from("tasks")
    .select("repo_url, repo_full_name, source, source_context")
    .eq("id", taskId)
    .single();

  assertNoError(error, `Failed to load repo info for ${taskId}`);
  const row = data as {
    repo_url: string | null;
    repo_full_name: string | null;
    source: string | null;
    source_context: JsonObject | null;
  };

  return {
    repoUrl: row.repo_url,
    repoFullName: row.repo_full_name,
    source: row.source,
    sourceContext: row.source_context,
  };
}
