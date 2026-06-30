#!/usr/bin/env tsx
/**
 * Recovery script: drains any stale queue messages for a task, resets the task
 * status to READY via a direct DB update (bypassing the state machine), and
 * re-enqueues task.execution.requested.
 *
 * Use this when an engineering run fails and the task is stuck at IN_PROGRESS or BLOCKED.
 */

import "dotenv/config";
import { db } from "../src/db/client.js";
import { enqueue } from "../src/db/queue.js";
import { physicalQueueName } from "../src/core/queue-names.js";
import type { QueueJobType } from "../src/core/types.js";

const taskId = process.argv[2] ?? "T-002";

const QUEUES_TO_DRAIN: QueueJobType[] = [
  "task.plan.requested",
  "task.execution.requested",
];

async function drainQueue(queueName: QueueJobType): Promise<number> {
  let drained = 0;
  for (let i = 0; i < 20; i++) {
    const { data, error } = await db.rpc("pgmq_read", {
      queue_name: physicalQueueName(queueName),
      vt: 1,
      qty: 1,
    });
    if (error) throw new Error(`Failed to read ${queueName}: ${error.message}`);
    const msg = data?.[0];
    if (!msg) break;

    // Only delete messages belonging to this task
    const msgTaskId = (msg.message as { task_id?: string }).task_id;
    if (msgTaskId === taskId) {
      const { error: delError } = await db.rpc("pgmq_delete", {
        queue_name: physicalQueueName(queueName),
        msg_id: msg.msg_id,
      });
      if (delError) throw new Error(`Failed to delete from ${queueName}: ${delError.message}`);
      drained++;
    }
  }
  return drained;
}

async function main(): Promise<void> {
  // 1. Check current status
  const { data: task, error: taskError } = await db
    .from("tasks")
    .select("status")
    .eq("id", taskId)
    .single();

  if (taskError || !task) throw new Error(`Task ${taskId} not found`);
  const status = (task as { status: string }).status;
  console.log(`Current status: ${status}`);

  // 2. Drain stale queue messages
  for (const queue of QUEUES_TO_DRAIN) {
    const count = await drainQueue(queue);
    if (count > 0) console.log(`Drained ${count} stale message(s) from ${queue}`);
  }

  // 3. Force status back to READY (direct DB update — bypasses state machine for recovery)
  const { error: updateError } = await db
    .from("tasks")
    .update({ status: "READY" })
    .eq("id", taskId);

  if (updateError) throw new Error(`Failed to reset ${taskId} to READY: ${updateError.message}`);

  // 4. Log a recovery event
  await db.from("task_events").insert({
    task_id: taskId,
    event_type: "status_changed",
    from_status: status,
    to_status: "READY",
    actor: "reset-task-engineering-script",
    payload: { reason: "Manual recovery: engineering cell failed, task reset for retry" },
  });

  // 5. Re-enqueue the engineering job
  await enqueue({
    job_type: "task.execution.requested",
    task_id: taskId,
    payload: { task_id: taskId },
  });

  console.log(`\n✓ ${taskId} reset to READY and re-enqueued for engineering.`);
  console.log("Next: npm run scheduler:once");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
