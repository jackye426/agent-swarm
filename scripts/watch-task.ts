#!/usr/bin/env tsx
/**
 * Poll task status until terminal or timeout.
 *
 * Usage: npm run watch:task -- T-009 [--timeout-min 120]
 */

import "dotenv/config";
import { db } from "../src/db/client.js";

const taskId = process.argv[2];
if (!taskId || !/^T-\d+$/.test(taskId)) {
  console.error("Usage: npm run watch:task -- T-NNN [--timeout-min N]");
  process.exit(1);
}

const timeoutIdx = process.argv.indexOf("--timeout-min");
const timeoutMin = timeoutIdx >= 0 ? Number(process.argv[timeoutIdx + 1] ?? 120) : 120;
const deadline = Date.now() + timeoutMin * 60_000;

const TERMINAL = new Set(["COMPLETE", "CANCELLED", "BLOCKED"]);

async function getStatus(): Promise<string> {
  const { data, error } = await db.from("tasks").select("status, updated_at").eq("id", taskId).single();
  if (error || !data) throw new Error(`Task ${taskId} not found`);
  return (data as { status: string; updated_at: string }).status;
}

console.log(`[watch] ${taskId} — polling every 30s (timeout ${timeoutMin} min)`);

while (Date.now() < deadline) {
  const status = await getStatus();
  console.log(`[watch] ${new Date().toISOString()} ${taskId} → ${status}`);
  if (TERMINAL.has(status)) {
    console.log(`[watch] Terminal status: ${status}`);
    process.exit(status === "COMPLETE" ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 30_000));
}

console.error(`[watch] Timed out after ${timeoutMin} min`);
process.exit(2);
