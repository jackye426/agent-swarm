#!/usr/bin/env tsx
/**
 * Implements system-knowledge/operations/re-seed-and-queue-hygiene.md
 * Steps 1–3: inspect, drain queues, clear stale evidence, reset to DRAFT.
 *
 * Usage: npm run reseed:hygiene -- T-008
 */

import "dotenv/config";
import { db } from "../src/db/client.js";
import { physicalQueueName } from "../src/core/queue-names.js";
import type { QueueJobType } from "../src/core/types.js";

const taskId = process.argv[2];
if (!taskId || !/^T-\d+$/.test(taskId)) {
  console.error("Usage: npm run reseed:hygiene -- T-NNN");
  process.exit(1);
}

const ALL_QUEUES: QueueJobType[] = [
  "task.plan.requested",
  "task.execution.requested",
  "task.verification.requested",
  "task.rework.requested",
];

async function drainQueueForTask(queueName: QueueJobType): Promise<number> {
  let drained = 0;
  const physical = physicalQueueName(queueName);

  for (let pass = 0; pass < 50; pass++) {
    const { data, error } = await db.rpc("pgmq_read", {
      queue_name: physical,
      vt: 1,
      qty: 10,
    });
    if (error) throw new Error(`pgmq_read ${queueName}: ${error.message}`);

    const msgs = (data ?? []) as Array<{ msg_id: number; message: { task_id?: string } }>;
    if (msgs.length === 0) break;

    let deletedAny = false;
    for (const msg of msgs) {
      if (msg.message?.task_id === taskId) {
        const { error: delError } = await db.rpc("pgmq_delete", {
          queue_name: physical,
          msg_id: msg.msg_id,
        });
        if (delError) throw new Error(`pgmq_delete ${queueName}: ${delError.message}`);
        drained++;
        deletedAny = true;
      }
    }

    if (!deletedAny) break;
  }

  return drained;
}

async function main(): Promise<void> {
  const { data: task, error: taskError } = await db
    .from("tasks")
    .select("id, status, contract_version")
    .eq("id", taskId)
    .single();

  if (taskError || !task) throw new Error(`Task ${taskId} not found`);
  console.log(`[hygiene] ${taskId} status=${(task as { status: string }).status} contract_version=${(task as { contract_version: number }).contract_version}`);

  for (const queue of ALL_QUEUES) {
    const count = await drainQueueForTask(queue);
    if (count > 0) console.log(`[hygiene] Drained ${count} message(s) from ${queue}`);
  }

  const { count: evidenceCount, error: evidenceError } = await db
    .from("evidence_records")
    .delete({ count: "exact" })
    .eq("task_id", taskId);

  if (evidenceError) throw new Error(`Failed to clear evidence: ${evidenceError.message}`);
  console.log(`[hygiene] Cleared ${evidenceCount ?? 0} evidence record(s)`);

  const fromStatus = (task as { status: string }).status;
  const { error: updateError } = await db
    .from("tasks")
    .update({ status: "DRAFT", cell: "planning", contract_version: 0 })
    .eq("id", taskId);

  if (updateError) throw new Error(`Failed to reset task: ${updateError.message}`);

  await db.from("task_events").insert({
    task_id: taskId,
    event_type: "status_changed",
    from_status: fromStatus,
    to_status: "DRAFT",
    actor: "reseed-hygiene",
    payload: { reason: "Clean re-seed per system-knowledge/operations/re-seed-and-queue-hygiene.md" },
  });

  console.log(`\n✓ ${taskId} ready for re-seed (DRAFT, queues drained, evidence cleared)`);
  console.log("Next: npm run smoke:seed -- T-008 --repo ... --goal ... --context ...");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
