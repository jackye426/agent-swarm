#!/usr/bin/env tsx
/**
 * Enqueue task.rework.requested using the latest verification record's defect
 * context. Sets BLOCKED → REWORK_REQUIRED (direct DB update for recovery).
 *
 * Usage: tsx scripts/smoke-enqueue-rework.ts T-008
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { db } from "../src/db/client.js";
import { enqueue } from "../src/db/queue.js";
import { getReworkAttemptCount } from "../src/db/records.js";

const taskId = process.argv[2];
if (!taskId || !/^T-\d+$/.test(taskId)) {
  console.error("Usage: tsx scripts/smoke-enqueue-rework.ts T-NNN [--instructions-file path.txt]");
  process.exit(1);
}

function loadExtraInstructions(): string[] {
  const fileIdx = process.argv.indexOf("--instructions-file");
  if (fileIdx < 0) return [];
  const filePath = process.argv[fileIdx + 1];
  if (!filePath) throw new Error("--instructions-file requires a path");
  return [readFileSync(filePath, "utf8").trim()];
}

async function main(): Promise<void> {
  const { data: task, error: taskError } = await db
    .from("tasks")
    .select("status")
    .eq("id", taskId)
    .single();

  if (taskError || !task) throw new Error(`Task ${taskId} not found`);
  const status = (task as { status: string }).status;
  if (status !== "BLOCKED" && status !== "REWORK_REQUIRED") {
    throw new Error(`Task ${taskId} is ${status}, expected BLOCKED or REWORK_REQUIRED`);
  }

  const { data: verification, error: verError } = await db
    .from("verification_records")
    .select("blocking_defects, missing_evidence")
    .eq("task_id", taskId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (verError) throw new Error(`Failed to load verification: ${verError.message}`);
  if (!verification) throw new Error(`No verification record for ${taskId}`);

  const blocking = [
    ...loadExtraInstructions(),
    ...(verification as { blocking_defects: string[] }).blocking_defects ?? [],
  ];
  const missing = (verification as { missing_evidence: string[] }).missing_evidence ?? [];
  const reworkAttempt = (await getReworkAttemptCount(taskId)) + 1;

  if (status === "BLOCKED") {
    const { error: updateError } = await db.from("tasks").update({ status: "REWORK_REQUIRED" }).eq("id", taskId);
    if (updateError) throw new Error(`Failed to set REWORK_REQUIRED: ${updateError.message}`);

    await db.from("task_events").insert({
      task_id: taskId,
      event_type: "status_changed",
      from_status: status,
      to_status: "REWORK_REQUIRED",
      actor: "smoke-enqueue-rework",
      payload: { reason: "Manual rework enqueue from latest verification defects" },
    });
  }

  await enqueue({
    job_type: "task.rework.requested",
    task_id: taskId,
    payload: {
      task_id: taskId,
      blocking_defects: blocking,
      missing_evidence: missing,
      rework_attempt: reworkAttempt,
    },
  });

  console.log(`✓ ${taskId} → REWORK_REQUIRED, enqueued task.rework.requested (attempt ${reworkAttempt})`);
  console.log("Next: npm run scheduler:once");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
