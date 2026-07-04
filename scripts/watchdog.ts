#!/usr/bin/env tsx
/**
 * Runtime watchdog — detects problems while the system is running, not only
 * at startup. Runs as the third pm2 app alongside scheduler and intake.
 *
 * Each cycle (default every 5 min):
 *   1. Supabase reachability + OpenRouter auth (health-probe subset)
 *   2. Tasks stuck in PLANNING / IN_PROGRESS / VERIFYING beyond threshold
 *   3. Recent agent_run failures that look like credits/network (402, fetch failed)
 *   4. pgmq queue depth over threshold
 *   5. Free disk on TASKGRAPH_WORKTREE_ROOT
 *
 * Alerts go to Telegram via the shared notify module, deduped so a persistent
 * condition re-alerts hourly instead of every cycle. At the end of each cycle
 * the watchdog pings HEALTHCHECKS_PING_URL (healthchecks.io) — the off-host
 * dead-man's switch: if the host dies, the missed ping raises an alert from
 * OUTSIDE the machine, which Telegram-from-this-host never could.
 *
 * Usage: tsx scripts/watchdog.ts [--once]
 */

import "dotenv/config";
import { statfs } from "node:fs/promises";
import { db } from "../src/db/client.js";
import { sendTelegramMessage } from "../src/core/notify.js";
import { physicalQueueName } from "../src/core/queue-names.js";
import type { QueueJobType } from "../src/core/types.js";
import { defaultHealthProbeDeps, probeOpenRouter } from "./lib/health-probes.js";
import {
  AlertDeduper,
  findStaleRunningAgentRuns,
  evaluateDiskFree,
  evaluateQueueDepth,
  findCredentialFailures,
  findStuckTasks,
  type AgentRunRow,
  type FailureEventRow,
  type QueueDepthRow,
  type TaskRow,
  type WatchdogAlert,
} from "./lib/watchdog-checks.js";

const INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS ?? 300_000);
const REALERT_MS = Number(process.env.WATCHDOG_REALERT_MS ?? 3_600_000);
// Must exceed the longest legitimate run (Claude Code engineering, default 30 min).
const STUCK_TASK_MS = Number(process.env.WATCHDOG_STUCK_TASK_MS ?? 2_700_000);
const QUEUE_DEPTH_THRESHOLD = Number(process.env.WATCHDOG_QUEUE_DEPTH_THRESHOLD ?? 10);
const MIN_FREE_DISK_GB = Number(process.env.WATCHDOG_MIN_FREE_DISK_GB ?? 5);

const QUEUES: QueueJobType[] = [
  "task.plan.requested",
  "task.contract_revision.requested",
  "task.execution.requested",
  "task.verification.requested",
  "task.rework.requested",
];

const deduper = new AlertDeduper(REALERT_MS);

async function checkInfrastructure(): Promise<WatchdogAlert[]> {
  const alerts: WatchdogAlert[] = [];

  const { error } = await db.from("tasks").select("id").limit(1);
  if (error) {
    alerts.push({
      key: "supabase",
      message: `Supabase unreachable or tasks table unreadable: ${error.message}`,
    });
  }

  const openrouter = await probeOpenRouter(defaultHealthProbeDeps());
  if (!openrouter.ok) {
    alerts.push({ key: "openrouter", message: openrouter.message });
  }

  return alerts;
}

async function checkStuckTasks(nowMs: number): Promise<WatchdogAlert[]> {
  const { data, error } = await db
    .from("tasks")
    .select("id, status, updated_at")
    .in("status", ["PLANNING", "IN_PROGRESS", "VERIFYING"]);
  if (error || !data) return [];
  return findStuckTasks(data as TaskRow[], nowMs, STUCK_TASK_MS);
}

async function checkStaleAgentRuns(nowMs: number): Promise<WatchdogAlert[]> {
  const { data, error } = await db
    .from("agent_runs")
    .select("id, task_id, worker_type, status, started_at")
    .eq("status", "running");
  if (error || !data) return [];
  return findStaleRunningAgentRuns(data as AgentRunRow[], nowMs, STUCK_TASK_MS);
}

async function checkCredentialFailures(): Promise<WatchdogAlert[]> {
  // Look back one re-alert window so a failure isn't missed between cycles
  // but also doesn't alert forever.
  const since = new Date(Date.now() - REALERT_MS).toISOString();
  const { data, error } = await db
    .from("task_events")
    .select("task_id, payload")
    .eq("event_type", "agent_run_failed")
    .gte("occurred_at", since);
  if (error || !data) return [];
  return findCredentialFailures(data as FailureEventRow[]);
}

async function checkQueueDepth(): Promise<WatchdogAlert[]> {
  const depths: QueueDepthRow[] = [];
  for (const queue of QUEUES) {
    const physical = physicalQueueName(queue);
    const { data, error } = await db.rpc("pgmq_metrics", { queue_name: physical });
    if (error || !data) continue;
    // pgmq.metrics returns a single row; supabase may wrap it in an array.
    const row = (Array.isArray(data) ? data[0] : data) as { queue_length?: number } | undefined;
    if (typeof row?.queue_length === "number") {
      depths.push({ queue: physical, length: row.queue_length });
    }
  }
  return evaluateQueueDepth(depths, QUEUE_DEPTH_THRESHOLD);
}

async function checkDiskFree(): Promise<WatchdogAlert[]> {
  const root = process.env.TASKGRAPH_WORKTREE_ROOT?.trim();
  if (!root) return [];
  try {
    const stats = await statfs(root);
    return evaluateDiskFree(stats.bavail * stats.bsize, MIN_FREE_DISK_GB, root);
  } catch {
    // statfs unsupported or root missing — the deep healthcheck owns that failure.
    return [];
  }
}

async function pingDeadMansSwitch(): Promise<void> {
  const url = process.env.HEALTHCHECKS_PING_URL?.trim();
  if (!url) {
    console.warn("[Watchdog] Dead-man ping SKIPPED: HEALTHCHECKS_PING_URL not set in this process env");
    return;
  }
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    console.log(`[Watchdog] Dead-man ping ${response.status} → ${url.slice(0, 40)}...`);
  } catch (err) {
    // Ping failure means healthchecks.io will alert externally — exactly its job.
    console.warn(`[Watchdog] Dead-man ping failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function runCycle(): Promise<WatchdogAlert[]> {
  const nowMs = Date.now();
  const alerts = (
    await Promise.all([
      checkInfrastructure(),
      checkStaleAgentRuns(nowMs),
      checkStuckTasks(nowMs),
      checkCredentialFailures(),
      checkQueueDepth(),
      checkDiskFree(),
    ])
  ).flat();

  // Reset dedup state for conditions that cleared, then send what's new/due.
  deduper.clearExcept(new Set(alerts.map((a) => a.key)));
  for (const alert of alerts) {
    if (!deduper.shouldSend(alert.key, nowMs)) continue;
    console.warn(`[Watchdog] ALERT ${alert.key}: ${alert.message}`);
    const sent = await sendTelegramMessage(`🐕 *Watchdog*\n\n${alert.message}`);
    if (!sent.ok) console.error(`[Watchdog] Telegram delivery failed: ${sent.message}`);
  }

  if (alerts.length === 0) {
    console.log(`[Watchdog] Cycle clean (${new Date(nowMs).toISOString()})`);
  }

  // Ping whenever the cycle itself completed — the dead-man's switch detects
  // a dead watchdog/host, not unhealthy dependencies (Telegram covers those).
  await pingDeadMansSwitch();
  return alerts;
}

async function main(): Promise<void> {
  if (process.argv.includes("--once")) {
    await runCycle();
    return;
  }
  console.log(`[Watchdog] Started — checking every ${Math.round(INTERVAL_MS / 1000)}s`);
  while (true) {
    try {
      await runCycle();
    } catch (err) {
      console.error("[Watchdog] Cycle failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("[Watchdog] Fatal error:", err);
  process.exit(1);
});
