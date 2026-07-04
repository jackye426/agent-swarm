#!/usr/bin/env tsx

import "dotenv/config";
import { db } from "../src/db/client.js";
import { runCommand, runShellCommand, type CommandResult } from "../src/core/command.js";
import {
  completeAgentRun,
  failAgentRun,
  getLatestContract,
  getLatestEngineeringWorktree,
  recordArtifact,
  recordEvidence,
} from "../src/db/records.js";
import { transitionTaskStatus } from "../src/db/tasks.js";
import { enqueueVerificationForTask } from "./lib/verification-enqueue.js";
import {
  classifyAcceptanceCriterion,
  extractCommandFromVerification,
  primaryAcKind,
} from "../src/core/contract-executability.js";
import { scrubHarnessLinesFromGitignore } from "../src/cells/engineering/worktree-support.js";
import {
  hasStagedChanges,
  restoreScopeOutFilesBeforeCommit,
  stageAllExceptExcluded,
  unstageExcludedPaths,
} from "../src/cells/engineering/commit-staging.js";
import { filterExcludedCommitPaths } from "../src/cells/engineering/commit-guard.js";
import type { AgentRun, EvidenceRecord } from "../src/core/types.js";

const taskId = process.argv[2];
const flags = new Set(process.argv.slice(3));

if (!taskId || !/^T-\d+$/.test(taskId)) {
  console.error("Usage: npm run recover:stale-rework -- T-NNN -- --inspect|--finalize-fixed-worktree|--block");
  process.exit(1);
}

async function latestRunningReworkRun(): Promise<AgentRun | null> {
  const { data, error } = await db
    .from("agent_runs")
    .select("*")
    .eq("task_id", taskId)
    .eq("worker_type", "rework-cell")
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load running rework run: ${error.message}`);
  return data as AgentRun | null;
}

async function latestTaskStatus(): Promise<string> {
  const { data, error } = await db.from("tasks").select("status").eq("id", taskId).single();
  if (error) throw new Error(`Failed to load task ${taskId}: ${error.message}`);
  return (data as { status: string }).status;
}

async function latestVerificationSummary(): Promise<unknown> {
  const { data, error } = await db
    .from("verification_records")
    .select("verdict, failure_owner, failed_ac_ids, failure_summary, recommended_next_step, blocking_defects, missing_evidence, created_at")
    .eq("task_id", taskId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load latest verification: ${error.message}`);
  return data;
}

async function gitOutput(worktreePath: string, args: string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd: worktreePath });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function restoreTrackedHarnessFiles(worktreePath: string): Promise<void> {
  const tracked = await runCommand("git", ["ls-files"], { cwd: worktreePath });
  if (tracked.exitCode !== 0) return;
  const excluded = filterExcludedCommitPaths(taskId, tracked.stdout.split("\n").filter(Boolean));
  if (excluded.length === 0) return;
  await runCommand("git", ["restore", "--staged", "--worktree", "--", ...excluded], { cwd: worktreePath });
}

function ciOutput(results: CommandResult[]): string {
  return results
    .map((result) => [
      `$ ${result.command}`,
      `exit=${result.exitCode}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

async function stopOrphanServer(worktreePath: string): Promise<void> {
  if (process.platform !== "win32") return;
  await recordArtifact({
    taskId,
    artifactType: "recovery_cleanup_note",
    content: {
      worktree_path: worktreePath,
      note:
        "Recovery did not automatically stop node server.js processes because Windows process metadata " +
        "does not reliably expose the working directory. Inspect processes before stopping any orphan manually.",
    },
  });
}

async function inspect(): Promise<void> {
  const run = await latestRunningReworkRun();
  const worktree = await getLatestEngineeringWorktree(taskId);
  console.log(JSON.stringify({
    task_id: taskId,
    status: await latestTaskStatus(),
    running_rework_run: run,
    latest_worktree: worktree,
    latest_verification: await latestVerificationSummary(),
  }, null, 2));
}

async function block(): Promise<void> {
  const run = await latestRunningReworkRun();
  if (!run) throw new Error(`No running rework run found for ${taskId}`);
  await recordArtifact({
    taskId,
    artifactType: "engineering_error",
    content: {
      agent_run_id: run.id,
      error: "Manual stale rework recovery blocked the task.",
    },
  });
  await failAgentRun(run.id, "Manual stale rework recovery blocked the task");
  await transitionTaskStatus({
    taskId,
    to: "BLOCKED",
    actor: "recover-stale-rework",
    payload: { agent_run_id: run.id, reason: "Manual stale rework recovery blocked the task" },
  });
  await recordArtifact({
    taskId,
    artifactType: "human_notification",
    content: {
      type: "infrastructure_blocked",
      task_id: taskId,
      message: `${taskId} was blocked by stale rework recovery. Inspect the engineering_error artifact.`,
      agent_run_id: run.id,
      notified_at: new Date().toISOString(),
    },
  });
}

async function finalizeFixedWorktree(): Promise<void> {
  const run = await latestRunningReworkRun();
  if (!run) throw new Error(`No running rework run found for ${taskId}`);

  const worktree = await getLatestEngineeringWorktree(taskId);
  if (!worktree?.path) throw new Error(`No engineering worktree artifact found for ${taskId}`);

  const contract = await getLatestContract(taskId);
  await restoreTrackedHarnessFiles(worktree.path);
  await scrubHarnessLinesFromGitignore(worktree.path, taskId);

  const test = await runShellCommand("npm run test:api", {
    cwd: worktree.path,
    timeoutMs: Number(process.env.TASKGRAPH_TEST_TIMEOUT_MS ?? 600_000),
  });
  if (test.exitCode !== 0) {
    await recordArtifact({
      taskId,
      artifactType: "engineering_error",
      content: {
        agent_run_id: run.id,
        error: "Recovery test command failed",
        test,
      },
    });
    throw new Error(`npm run test:api failed: ${test.stderr || test.stdout}`);
  }

  await restoreScopeOutFilesBeforeCommit(worktree.path, contract.scope.out, worktree.baseSha);
  await stageAllExceptExcluded(worktree.path, taskId);
  await unstageExcludedPaths(worktree.path, taskId);

  if (await hasStagedChanges(worktree.path)) {
    const authorName = process.env.TASKGRAPH_GIT_AUTHOR_NAME ?? "TaskGraph OS";
    const authorEmail = process.env.TASKGRAPH_GIT_AUTHOR_EMAIL ?? "taskgraph@example.local";
    const commit = await runCommand("git", [
      "-c",
      `user.name=${authorName}`,
      "-c",
      `user.email=${authorEmail}`,
      "commit",
      "-m",
      `fix(${taskId}): recover stale rework changes\n\nAgent run: ${run.id}`,
    ], { cwd: worktree.path });
    if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }

  const headSha = await gitOutput(worktree.path, ["rev-parse", "HEAD"]);
  const results = [test];
  await recordArtifact({
    taskId,
    artifactType: "implementation_report",
    content: {
      agent_run_id: run.id,
      recovered: true,
      summary: "Recovered stale rework run from existing fixed worktree.",
    },
  });
  await recordArtifact({
    taskId,
    artifactType: "test_report",
    content: { agent_run_id: run.id, results },
  });
  await recordArtifact({
    taskId,
    artifactType: "engineering_worktree",
    content: {
      agent_run_id: run.id,
      path: worktree.path,
      branch: worktree.branch,
      base_sha: worktree.baseSha,
      head_sha: headSha,
      mode: "post_recovery_commit",
    },
  });

  const evidence: EvidenceRecord[] = [];
  const timestamp = new Date().toISOString();
  const source = process.env.TASKGRAPH_EVIDENCE_SOURCE_URL ?? `https://localhost/taskgraph-os/${taskId}`;
  const taskNumber = taskId.replace("T-", "");
  let evidenceIndex = 0;

  for (const ac of contract.acceptance_criteria) {
    const primary = primaryAcKind(classifyAcceptanceCriterion(ac));
    if (primary === "human" || primary === "unknown") continue;
    evidenceIndex += 1;
    const evidenceId = `E-${taskNumber}${String(evidenceIndex).padStart(3, "0")}`;
    if (primary === "diff_inspection") {
      evidence.push({
        evidence_id: evidenceId,
        task_id: taskId,
        acceptance_criteria: [ac.id],
        type: "model_review",
        status: "inconclusive",
        commit_sha: headSha,
        source,
        timestamp,
        summary: `${ac.id}: awaiting verification via PR diff inspection (${ac.verification.join(", ")})`,
      });
      continue;
    }
    const commands = ac.verification.map(extractCommandFromVerification).filter((c): c is string => Boolean(c));
    const relevantResults = commands.length > 0
      ? results.filter((result) => commands.some((command) => result.command.includes(command.replace("npm run ", ""))))
      : results;
    evidence.push({
      evidence_id: evidenceId,
      task_id: taskId,
      acceptance_criteria: [ac.id],
      type: "ci_run",
      status: relevantResults.length > 0 && relevantResults.every((result) => result.exitCode === 0) ? "pass" : "inconclusive",
      commit_sha: headSha,
      source,
      command: (relevantResults.length > 0 ? relevantResults : results).map((result) => result.command).join(" && "),
      timestamp,
      summary: `Recovery test evidence for ${ac.id}.`,
    });
  }

  for (const item of evidence) {
    await recordEvidence({ ...item, agentRunId: run.id });
  }

  await completeAgentRun(run.id);
  await transitionTaskStatus({
    taskId,
    to: "AWAITING_EVIDENCE",
    actor: "recover-stale-rework",
    payload: { agent_run_id: run.id, evidence_count: evidence.length, ci_output: ciOutput(results) },
  });
  await enqueueVerificationForTask(taskId);
  await recordArtifact({
    taskId,
    artifactType: "human_notification",
    content: {
      type: "stale_rework_recovered",
      task_id: taskId,
      message: `${taskId} stale rework was recovered and verification was re-enqueued.`,
      agent_run_id: run.id,
      notified_at: new Date().toISOString(),
    },
  });
  await stopOrphanServer(worktree.path);
  console.log(`${taskId} recovered; verification re-enqueued at ${headSha}`);
}

async function main(): Promise<void> {
  if (flags.has("--inspect")) {
    await inspect();
    return;
  }
  if (flags.has("--block")) {
    await block();
    return;
  }
  if (flags.has("--finalize-fixed-worktree")) {
    await finalizeFixedWorktree();
    return;
  }
  throw new Error("Choose one mode: --inspect, --block, or --finalize-fixed-worktree");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
