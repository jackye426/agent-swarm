#!/usr/bin/env tsx
/** Enqueue task.execution.requested when task is READY (after auto-approve planning). */

import "dotenv/config";
import { db } from "../src/db/client.js";
import { enqueue } from "../src/db/queue.js";

const taskId = process.argv[2];
if (!taskId || !/^T-\d+$/.test(taskId)) {
  console.error("Usage: npm run smoke:enqueue:execution -- T-NNN");
  process.exit(1);
}

async function main(): Promise<void> {
  const { data: task, error } = await db.from("tasks").select("status").eq("id", taskId).single();
  if (error || !task) throw new Error(`Task ${taskId} not found`);
  const status = (task as { status: string }).status;
  if (status !== "READY") {
    throw new Error(`Task ${taskId} is ${status}, expected READY`);
  }

  await enqueue({
    job_type: "task.execution.requested",
    task_id: taskId,
    payload: { task_id: taskId },
  });
  console.log(`Enqueued task.execution.requested for ${taskId}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
