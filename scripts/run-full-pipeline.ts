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
import { getLatestContextPacket } from "../src/db/records.js";
import { resolveTestCommandsFromPacket } from "../src/core/contract-executability.js";

const execFileAsync = promisify(execFile);
const taskId = process.argv[2];
if (!taskId || !/^T-\d+$/.test(taskId)) {
  console.error("Usage: npm run pipeline:run -- T-NNN");
  process.exit(1);
}

const TERMINAL_STATUSES = new Set(["COMPLETE", "CANCELLED"]);
const MAX_CYCLES = Number(process.env.TASKGRAPH_MAX_REWORK_ATTEMPTS ?? 3) + 1;

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

async function runVerificationSeed(): Promise<void> {
  console.log("[pipeline] verification seed + enqueue...");
  const { stdout, stderr } = await execFileAsync(
    "npm",
    ["run", "smoke:seed:verification", "--", taskId],
    { cwd: process.cwd(), env: process.env, shell: true, maxBuffer: 10 * 1024 * 1024 },
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

async function runVerificationStep(): Promise<void> {
  // Rework may have auto-enqueued verification via the scheduler.
  await schedulerOnce();
  const afterScheduler = await getStatus();
  if (afterScheduler === "AWAITING_EVIDENCE") {
    await runVerificationSeed();
    await schedulerOnce();
    return;
  }
  if (afterScheduler === "VERIFYING") {
    await schedulerOnce();
  }
}

async function resetBlockedEngineering(): Promise<void> {
  const packet = (await getLatestContextPacket(taskId)) ?? {};
  const testCommands = resolveTestCommandsFromPacket(packet);
  const testArg = testCommands.length > 0 ? testCommands.join(";") : "npm test";

  console.log(`[pipeline] Resetting BLOCKED → READY (tests: ${testArg})...`);
  const { stdout, stderr } = await execFileAsync(
    "npm",
    ["run", "smoke:reset:engineering", "--", taskId, testArg],
    { cwd: process.cwd(), env: process.env, shell: true, maxBuffer: 10 * 1024 * 1024 },
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

async function runPlanningStep(): Promise<void> {
  console.log("[pipeline] Step: planning...");
  await schedulerOnce();
}

async function runEngineeringStep(): Promise<void> {
  console.log("[pipeline] Step: enqueue + engineering...");
  await enqueue({
    job_type: "task.execution.requested",
    task_id: taskId,
    payload: { task_id: taskId },
  });
  await schedulerOnce();
}

async function dispatchForStatus(status: string): Promise<boolean> {
  switch (status) {
    case "DRAFT":
    case "AWAITING_APPROVAL":
      await runPlanningStep();
      return true;

    case "READY":
      await runEngineeringStep();
      return true;

    case "BLOCKED": {
      const [{ data: latestVer }, { data: latestEngError }] = await Promise.all([
        db
          .from("verification_records")
          .select("created_at")
          .eq("task_id", taskId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        db
          .from("artifacts")
          .select("created_at")
          .eq("task_id", taskId)
          .eq("artifact_type", "engineering_error")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      const verAt = (latestVer as { created_at?: string } | null)?.created_at;
      const engErrAt = (latestEngError as { created_at?: string } | null)?.created_at;
      const blockedAfterVerification =
        verAt !== undefined && (engErrAt === undefined || verAt > engErrAt);

      if (blockedAfterVerification) {
        console.log("[pipeline] BLOCKED after verification — re-verifying only...");
        await runVerificationStep();
      } else {
        await resetBlockedEngineering();
        await schedulerOnce();
      }
      return true;
    }

    case "REWORK_REQUIRED":
    case "IN_PROGRESS":
    case "VERIFYING":
    case "PLANNING":
      await schedulerOnce();
      return true;

    case "AWAITING_EVIDENCE":
      console.log("[pipeline] Step: verification...");
      await runVerificationStep();
      return true;

    default:
      return false;
  }
}

async function main(): Promise<void> {
  process.env.TASKGRAPH_DISABLE_POSTGRES_CHECKPOINT ??= "true";

  let status = await getStatus();
  console.log(`[pipeline] ${taskId} status: ${status}`);

  if (status === "PLANNING") {
    console.error(
      `[pipeline] Task ${taskId} stuck at PLANNING from a failed run. Re-seed first:\n` +
        `  npm run smoke:seed -- ${taskId} --repo owner/repo --goal "..."`,
    );
    process.exit(1);
  }

  for (let cycle = 0; cycle < MAX_CYCLES && !TERMINAL_STATUSES.has(status); cycle += 1) {
    console.log(`\n[pipeline] cycle ${cycle + 1}/${MAX_CYCLES}, status=${status}`);

    if (status === "AWAITING_APPROVAL") {
      await runPlanningStep();
      status = await getStatus();
      if (status === "AWAITING_APPROVAL") {
        console.error(
          `[pipeline] Contract executability validation failed — check contract_validation_failed artifact, ` +
            `fix the seed goal/context, then re-seed and re-run.`,
        );
        process.exit(1);
      }
      continue;
    }

    const dispatched = await dispatchForStatus(status);
    if (!dispatched) break;

    status = await getStatus();
    console.log(`[pipeline] after step: ${status}`);
  }

  if (status === "COMPLETE") {
    console.log(`\n[pipeline] ${taskId} reached COMPLETE.`);
  } else {
    console.error(
      `\n[pipeline] ${taskId} ended at ${status} (expected COMPLETE). ` +
        `Run: npm run smoke:inspect -- ${taskId}`,
    );
    process.exit(1);
  }

  console.log("\n[pipeline] Run: npm run smoke:inspect -- " + taskId);
}

main().catch((err) => {
  console.error("[pipeline] Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
