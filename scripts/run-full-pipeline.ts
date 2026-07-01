#!/usr/bin/env tsx
/**
 * Run planning → engineering → verification for a task already seeded with
 * npm run smoke:seed -- T-NNN --repo owner/repo [--goal ...]
 *
 * Usage: npm run pipeline:run -- T-006
 */

import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../src/db/client.js";
import { enqueue } from "../src/db/queue.js";

const execFileAsync = promisify(execFile);
const taskId = process.argv[2];
if (!taskId || !/^T-\d+$/.test(taskId)) {
  console.error("Usage: npm run pipeline:run -- T-NNN");
  process.exit(1);
}

async function getStatus(): Promise<string> {
  const { data, error } = await db.from("tasks").select("status").eq("id", taskId).single();
  if (error || !data) throw new Error(`Task ${taskId} not found`);
  return (data as { status: string }).status;
}

async function schedulerOnce(): Promise<void> {
  console.log("\n[pipeline] npm run scheduler:once");
  const { stdout, stderr } = await execFileAsync("npm", ["run", "scheduler:once"], {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 3_600_000,
    shell: true,
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

async function main(): Promise<void> {
  process.env.TASKGRAPH_DISABLE_POSTGRES_CHECKPOINT ??= "true";

  let status = await getStatus();
  console.log(`[pipeline] ${taskId} status: ${status}`);

  // 1. Planning
  if (status === "DRAFT" || status === "PLANNING" || status === "AWAITING_APPROVAL") {
    if (status === "PLANNING") {
      throw new Error(
        `Task ${taskId} stuck at PLANNING from a failed run. Re-seed first:\n` +
          `  npm run smoke:seed -- ${taskId} --repo owner/repo --goal "..."`,
      );
    }
    console.log("[pipeline] Step 1/3: planning...");
    await schedulerOnce();
    status = await getStatus();
    console.log(`[pipeline] after planning: ${status}`);
    if (status !== "READY") {
      throw new Error(`Expected READY after planning, got ${status}`);
    }
  }

  // 2. Engineering
  if (status === "AWAITING_EVIDENCE" || status === "REWORK_REQUIRED" || status === "COMPLETE" || status === "VERIFYING") {
    console.log(`[pipeline] Skipping engineering — already at ${status}`);
  } else if (status === "READY" || status === "BLOCKED") {
    if (status === "BLOCKED") {
      console.log("[pipeline] Resetting BLOCKED → READY and re-enqueueing engineering...");
      const { stdout, stderr } = await execFileAsync(
        "npm",
        ["run", "smoke:reset:engineering", "--", taskId, "npm test;npm run test:negative"],
        { cwd: process.cwd(), env: process.env, shell: true, maxBuffer: 10 * 1024 * 1024 },
      );
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    } else {
      console.log("[pipeline] Step 2/3: enqueue + engineering...");
      await enqueue({
        job_type: "task.execution.requested",
        task_id: taskId,
        payload: { task_id: taskId },
      });
    }

    await schedulerOnce();
    status = await getStatus();
    console.log(`[pipeline] after engineering: ${status}`);
    if (status !== "AWAITING_EVIDENCE") {
      throw new Error(`Expected AWAITING_EVIDENCE after engineering, got ${status}`);
    }
  }

  // 3. Verification
  if (status === "AWAITING_EVIDENCE") {
    console.log("[pipeline] Step 3/3: verification seed + run...");
    const { stdout, stderr } = await execFileAsync(
      "npm",
      ["run", "smoke:seed:verification", "--", taskId],
      { cwd: process.cwd(), env: process.env, shell: true, maxBuffer: 10 * 1024 * 1024 },
    );
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    await schedulerOnce();
    status = await getStatus();
    console.log(`[pipeline] after verification: ${status}`);
  }

  console.log("\n[pipeline] Done. Run: npm run smoke:inspect -- " + taskId);
}

main().catch((err) => {
  console.error("[pipeline] Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
