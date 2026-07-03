import path from "node:path";
import os from "node:os";
import { db } from "../../src/db/client.js";
import { enqueue } from "../../src/db/queue.js";
import {
  assembleVerificationDiff,
  resolveWorktreePath,
} from "../../src/core/verification-diff.js";

async function loadCiOutput(taskId: string): Promise<string> {
  const { data: testReport } = await db
    .from("artifacts")
    .select("content")
    .eq("task_id", taskId)
    .eq("artifact_type", "test_report")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!testReport?.content) return "";

  const report = testReport.content as {
    results?: Array<{ command: string; exitCode: number; stdout: string; stderr: string }>;
  };
  return (report.results ?? [])
    .map((r) => [`$ ${r.command}`, `exit=${r.exitCode}`, r.stdout, r.stderr].filter(Boolean).join("\n"))
    .join("\n\n");
}

interface WorktreeArtifactContent {
  path?: string;
  base_sha?: string;
  head_sha?: string;
}

async function loadWorktreeArtifact(taskId: string): Promise<{ worktreePath: string; baseSha?: string; headSha?: string }> {
  const worktreeRoot = process.env.TASKGRAPH_WORKTREE_ROOT ?? path.join(os.tmpdir(), "taskgraph-os");

  const { data: worktreeArtifact } = await db
    .from("artifacts")
    .select("content")
    .eq("task_id", taskId)
    .eq("artifact_type", "engineering_worktree")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const content = worktreeArtifact?.content as WorktreeArtifactContent | null;
  return {
    worktreePath: resolveWorktreePath(taskId, content?.path, worktreeRoot),
    baseSha: content?.base_sha,
    headSha: content?.head_sha,
  };
}

async function loadPrUrl(taskId: string): Promise<string | undefined> {
  for (const artifactType of ["pull_request", "pull_request_deferred"] as const) {
    const { data } = await db
      .from("artifacts")
      .select("content")
      .eq("task_id", taskId)
      .eq("artifact_type", artifactType)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const url = (data?.content as { url?: string } | null)?.url;
    if (url?.trim()) return url.trim();
  }
  return undefined;
}

/** Load engineering artifacts and enqueue task.verification.requested. */
export async function enqueueVerificationForTask(taskId: string): Promise<void> {
  const { worktreePath, baseSha, headSha } = await loadWorktreeArtifact(taskId);
  const ciOutput = await loadCiOutput(taskId);
  const prUrl = await loadPrUrl(taskId);

  const { diff: prDiff, commitSha } = await assembleVerificationDiff(worktreePath, {
    baseSha,
    commitSha: headSha,
    prUrl,
    preferGhPrDiff: process.env.GITHUB_CREATE_PR === "true",
  });

  await enqueue({
    job_type: "task.verification.requested",
    task_id: taskId,
    payload: {
      task_id: taskId,
      pr_diff: prDiff,
      ci_output: ciOutput,
      ...(commitSha ? { commit_sha: commitSha } : {}),
    },
  });
}

export async function autoEnqueueVerificationIfEnabled(taskId: string): Promise<boolean> {
  if (process.env.TASKGRAPH_AUTO_ENQUEUE_VERIFICATION !== "true") return false;
  await enqueueVerificationForTask(taskId);
  console.log(`[Scheduler] Auto-enqueued verification for ${taskId}`);
  return true;
}
