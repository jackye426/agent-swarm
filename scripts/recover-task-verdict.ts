#!/usr/bin/env tsx
/**
 * Applies the latest verification record verdict to task status when the
 * verification workflow saved the record but could not transition (e.g. stale
 * engineering job moved the task to BLOCKED first).
 *
 * Usage: npm run recover:verdict -- T-005
 */

import "dotenv/config";
import { db } from "../src/db/client.js";
import { enqueue } from "../src/db/queue.js";
import { getReworkAttemptCount } from "../src/db/records.js";
import type { TaskStatus, TaskVerdict } from "../src/core/types.js";

const taskId = process.argv[2];
if (!taskId || !/^T-\d+$/.test(taskId)) {
  console.error("Usage: npm run recover:verdict -- T-NNN");
  process.exit(1);
}

async function main(): Promise<void> {
  const { data: task, error: taskError } = await db
    .from("tasks")
    .select("id, status")
    .eq("id", taskId)
    .single();

  if (taskError || !task) throw new Error(`Task ${taskId} not found`);

  const { data: verification, error: verError } = await db
    .from("verification_records")
    .select("id, verdict, blocking_defects, missing_evidence, created_at")
    .eq("task_id", taskId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (verError) throw new Error(`Failed to load verification: ${verError.message}`);
  if (!verification) throw new Error(`No verification record for ${taskId}`);

  const verdict = (verification as { verdict: TaskVerdict }).verdict;
  const currentStatus = (task as { status: TaskStatus }).status;

  if (currentStatus === verdict) {
    console.log(`${taskId} already at ${verdict}`);
    return;
  }

  const { error: updateError } = await db
    .from("tasks")
    .update({ status: verdict })
    .eq("id", taskId);

  if (updateError) throw new Error(`Failed to update status: ${updateError.message}`);

  await db.from("task_events").insert({
    task_id: taskId,
    event_type: "status_changed",
    from_status: currentStatus,
    to_status: verdict,
    actor: "recover-task-verdict",
    payload: {
      reason: "Apply saved verification verdict after failed transition",
      verification_id: (verification as { id: string }).id,
    },
  });

  console.log(`Recovered ${taskId}: ${currentStatus} → ${verdict}`);

  if (verdict === "REWORK_REQUIRED") {
    const blocking = (verification as { blocking_defects: string[] }).blocking_defects ?? [];
    const missing = (verification as { missing_evidence: string[] }).missing_evidence ?? [];
    const reworkAttemptsDone = await getReworkAttemptCount(taskId);
    await enqueue({
      job_type: "task.rework.requested",
      task_id: taskId,
      payload: {
        task_id: taskId,
        blocking_defects: blocking,
        missing_evidence: missing,
        rework_attempt: reworkAttemptsDone + 1,
      },
    });
    console.log("Enqueued task.rework.requested");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
