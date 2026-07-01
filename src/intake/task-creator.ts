import "dotenv/config";
import { db } from "../db/client.js";
import { enqueue } from "../db/queue.js";
import { createContextPacket, recordArtifact } from "../db/records.js";
import type { ResolvedRepo } from "./repo-resolver.js";
import {
  formatSeedContextForPlanning,
  scanRepoSeedContext,
  type SeedRepoContext,
} from "./repo-scanner.js";

export type TaskSourceKind = "telegram" | "github" | "manual";

export interface CreateTaskInput {
  goal: string;
  context: string;
  /** Human-readable origin label, e.g. `github:owner/repo#42`. */
  sourceLabel: string;
  sourceKind: TaskSourceKind;
  repo: ResolvedRepo;
  sourceContext?: Record<string, unknown>;
  stopAfterDraft?: boolean;
}

export interface CreatedTask {
  taskId: string;
  goal: string;
  repoFullName: string;
}

async function nextTaskId(): Promise<string> {
  const { data, error } = await db
    .from("tasks")
    .select("id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to generate task ID: ${error.message}`);

  const lastId = (data as { id: string } | null)?.id ?? "T-000";
  const num = parseInt(lastId.replace("T-", ""), 10);
  return `T-${String(num + 1).padStart(3, "0")}`;
}

async function persistSeedContext(
  taskId: string,
  seed: SeedRepoContext,
  userContext: string,
  planningContext: string,
): Promise<string> {
  await recordArtifact({
    taskId,
    artifactType: "seed_repo_context",
    content: seed,
  });

  return createContextPacket(taskId, {
    kind: "seed_repo_context",
    repo_full_name: seed.repo_full_name,
    user_context: userContext,
    planning_context: planningContext,
    seed,
  });
}

// Creates a task at DRAFT, scans the target repo, and enqueues planning.
export async function createAndEnqueueTask(input: CreateTaskInput): Promise<CreatedTask> {
  const taskId = await nextTaskId();
  const seed = await scanRepoSeedContext(input.repo.repoFullName);
  const planningContext = formatSeedContextForPlanning(seed, input.context);

  const { error: upsertError } = await db.from("tasks").upsert({
    id: taskId,
    title: input.goal.slice(0, 120),
    status: "DRAFT",
    cell: "planning",
    contract_version: 0,
    repo_url: input.repo.repoUrl,
    repo_full_name: input.repo.repoFullName,
    source: input.sourceKind,
    source_context: {
      ...input.sourceContext,
      repo_resolution: input.repo.resolutionSource,
    },
  });

  if (upsertError) throw new Error(`Failed to create task ${taskId}: ${upsertError.message}`);

  const contextPacketId = await persistSeedContext(taskId, seed, input.context, planningContext);
  const sourceContext = {
    ...input.sourceContext,
    repo_resolution: input.repo.resolutionSource,
    context_packet_id: contextPacketId,
  };

  const { error: contextUpdateError } = await db
    .from("tasks")
    .update({ source_context: sourceContext })
    .eq("id", taskId);

  if (contextUpdateError) {
    throw new Error(`Failed to update task ${taskId} source context: ${contextUpdateError.message}`);
  }

  await db.from("task_events").insert({
    task_id: taskId,
    event_type: "task_created",
    actor: input.sourceLabel,
    payload: {
      goal: input.goal,
      source: input.sourceLabel,
      repo_full_name: input.repo.repoFullName,
      repo_resolution: input.repo.resolutionSource,
    },
  });

  await enqueue({
    job_type: "task.plan.requested",
    task_id: taskId,
    payload: {
      task_id: taskId,
      goal: input.goal,
      context: planningContext,
      repo_full_name: input.repo.repoFullName,
      repo_url: input.repo.repoUrl,
      stop_after_draft: input.stopAfterDraft ?? false,
    },
  });

  console.log(
    `[Intake] Created ${taskId} from ${input.sourceLabel} ` +
      `(${input.repo.repoFullName}): ${input.goal.slice(0, 60)}`,
  );
  return { taskId, goal: input.goal, repoFullName: input.repo.repoFullName };
}
