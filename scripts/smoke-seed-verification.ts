#!/usr/bin/env tsx
/**
 * Reads engineering artifacts from Supabase + the git worktree diff, then
 * enqueues task.verification.requested.
 *
 * Prerequisites:
 *   - Engineering cell has run successfully (task at AWAITING_EVIDENCE)
 *   - Run: npm run smoke:seed:engineering -- T-002 && npm run scheduler:once
 */

import "dotenv/config";
import path from "node:path";
import os from "node:os";
import { db } from "../src/db/client.js";
import { enqueue } from "../src/db/queue.js";
import { runCommand } from "../src/core/command.js";

const taskId = process.argv[2] ?? "T-002";

async function main(): Promise<void> {
  // 1. Check the task is at AWAITING_EVIDENCE
  const { data: task, error: taskError } = await db
    .from("tasks")
    .select("status")
    .eq("id", taskId)
    .single();

  if (taskError || !task) throw new Error(`Task ${taskId} not found`);
  const status = (task as { status: string }).status;
  if (status !== "AWAITING_EVIDENCE") {
    throw new Error(
      `Task ${taskId} is at ${status}, expected AWAITING_EVIDENCE.\n` +
      `Run: npm run smoke:seed:engineering -- ${taskId} && npm run scheduler:once`
    );
  }

  // 2. Read the test_report artifact for CI output
  let ciOutput = "";
  const { data: testReport } = await db
    .from("artifacts")
    .select("content")
    .eq("task_id", taskId)
    .eq("artifact_type", "test_report")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (testReport?.content) {
    const report = testReport.content as { results?: Array<{ command: string; exitCode: number; stdout: string; stderr: string }> };
    ciOutput = (report.results ?? [])
      .map((r) => [`$ ${r.command}`, `exit=${r.exitCode}`, r.stdout, r.stderr].filter(Boolean).join("\n"))
      .join("\n\n");
  }

  if (!ciOutput) console.warn("Warning: no test_report artifact found; ci_output will be empty.");

  // 3. Get the git diff from the engineering worktree
  let prDiff = "";
  let commitSha: string | undefined;

  const worktreeRoot = process.env.TASKGRAPH_WORKTREE_ROOT ?? path.join(os.tmpdir(), "taskgraph-os");
  const worktreePath = path.join(worktreeRoot, taskId);

  const diffResult = await runCommand("git", ["diff", "HEAD~1", "HEAD", "--stat", "--patch"], { cwd: worktreePath });
  if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
    prDiff = diffResult.stdout;
  } else {
    // Try diff against initial commit in case there's only one commit
    const diffAllResult = await runCommand("git", ["diff", "--stat", "--patch"], { cwd: worktreePath });
    prDiff = diffAllResult.stdout || "(no diff — worktree may not have changes yet)";
  }

  const shaResult = await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  if (shaResult.exitCode === 0) commitSha = shaResult.stdout.trim();

  console.log(`PR diff: ${prDiff.split("\n").length} lines`);
  console.log(`Commit SHA: ${commitSha ?? "unknown"}`);
  console.log(`CI output: ${ciOutput.split("\n").length} lines`);

  // 4. Enqueue verification job
  console.log("\nEnqueueing task.verification.requested...");
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

  console.log(`\n✓ Verification smoke test enqueued for ${taskId}.`);
  console.log("\nNext: npm run scheduler:once");
  console.log("Then: npm run smoke:inspect -- " + taskId);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
