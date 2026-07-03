#!/usr/bin/env tsx
/**
 * Reads engineering artifacts from Supabase + the git worktree diff, then
 * enqueues task.verification.requested.
 */

import "dotenv/config";
import { db } from "../src/db/client.js";
import { enqueueVerificationForTask } from "./lib/verification-enqueue.js";

const taskId = process.argv[2] ?? "T-002";

async function main(): Promise<void> {
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
        `Run engineering first, then re-run this script.`,
    );
  }

  console.log("\nEnqueueing task.verification.requested...");
  await enqueueVerificationForTask(taskId);

  console.log(`\n✓ Verification smoke test enqueued for ${taskId}.`);
  console.log("\nNext: npm run scheduler:once");
  console.log("Then: npm run smoke:inspect -- " + taskId);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
