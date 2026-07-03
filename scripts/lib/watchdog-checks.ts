/**
 * Pure watchdog check logic — data in, alerts out. No I/O here so every rule
 * is unit-testable; scripts/watchdog.ts owns queries, Telegram, and timing.
 */

/** A condition worth telling a human about. `key` identifies it for dedup. */
export interface WatchdogAlert {
  key: string;
  message: string;
}

export interface TaskRow {
  id: string;
  status: string;
  updated_at: string;
}

/** Task statuses that mean "a cell should be actively working on this". */
const ACTIVE_STATUSES = new Set(["PLANNING", "IN_PROGRESS", "VERIFYING"]);

/**
 * Tasks sitting in an active status longer than the threshold are presumed
 * stuck (crashed cell, lost verdict, dead scheduler). The threshold must
 * exceed the longest legitimate run — engineering with Claude Code can take
 * CLAUDE_CODE_TIMEOUT_MS (default 30 min) — so the default is 45 min, not the
 * parent plan's 2× visibility timeout (4 min), which would false-alarm on
 * every real engineering run.
 */
export function findStuckTasks(
  tasks: TaskRow[],
  nowMs: number,
  thresholdMs: number,
): WatchdogAlert[] {
  return tasks
    .filter(
      (task) =>
        ACTIVE_STATUSES.has(task.status) &&
        nowMs - new Date(task.updated_at).getTime() > thresholdMs,
    )
    .map((task) => {
      const minutes = Math.round((nowMs - new Date(task.updated_at).getTime()) / 60_000);
      return {
        key: `stuck:${task.id}:${task.status}`,
        message:
          `Task *${task.id}* stuck in ${task.status} for ${minutes} min.\n` +
          `Check \`npm run smoke:inspect -- ${task.id}\`; if a verdict was saved but not applied, ` +
          `run \`npm run recover:verdict -- ${task.id}\`.`,
      };
    });
}

export interface FailureEventRow {
  task_id: string;
  payload: { reason?: string } | null;
}

const CREDENTIAL_FAILURE_PATTERN = /402|payment required|fetch failed/i;

/**
 * Recent agent_run_failed events whose reason smells like credits or network
 * (OpenRouter 402, Supabase "fetch failed") — the two failure classes that
 * masqueraded as platform bugs in the T-008 postmortem.
 */
export function findCredentialFailures(events: FailureEventRow[]): WatchdogAlert[] {
  const affected = new Map<string, string>();
  for (const event of events) {
    const reason = event.payload?.reason ?? "";
    if (CREDENTIAL_FAILURE_PATTERN.test(reason)) {
      affected.set(event.task_id, reason.slice(0, 120));
    }
  }
  if (affected.size === 0) return [];

  const lines = [...affected.entries()].map(([taskId, reason]) => `• ${taskId}: ${reason}`);
  return [
    {
      key: "credential_failures",
      message:
        `Recent agent runs failed with credit/network errors (OpenRouter credits or Supabase transport?):\n` +
        lines.join("\n"),
    },
  ];
}

export interface QueueDepthRow {
  queue: string;
  length: number;
}

export function evaluateQueueDepth(
  depths: QueueDepthRow[],
  threshold: number,
): WatchdogAlert[] {
  return depths
    .filter((row) => row.length > threshold)
    .map((row) => ({
      key: `queue_depth:${row.queue}`,
      message:
        `Queue \`${row.queue}\` has ${row.length} messages (threshold ${threshold}). ` +
        `Scheduler may be down or wedged.`,
    }));
}

export function evaluateDiskFree(
  freeBytes: number,
  minFreeGb: number,
  root: string,
): WatchdogAlert[] {
  const freeGb = freeBytes / 1024 ** 3;
  if (freeGb >= minFreeGb) return [];
  return [
    {
      key: "disk_free",
      message:
        `Worktree root \`${root}\` has ${freeGb.toFixed(1)} GB free ` +
        `(threshold ${minFreeGb} GB). Clean old worktrees/clones.`,
    },
  ];
}

/**
 * Suppresses repeat alerts: a condition alerts once, then again only after
 * `realertMs` if it persists. Keyed per condition; in-memory is fine because
 * the watchdog is a long-running pm2 process (a restart re-alerting once is
 * acceptable, arguably desirable).
 */
export class AlertDeduper {
  private lastSent = new Map<string, number>();

  constructor(private readonly realertMs: number) {}

  shouldSend(key: string, nowMs: number): boolean {
    const last = this.lastSent.get(key);
    if (last !== undefined && nowMs - last < this.realertMs) return false;
    this.lastSent.set(key, nowMs);
    return true;
  }

  /** Forget conditions that cleared so their next occurrence alerts immediately. */
  clearExcept(activeKeys: Set<string>): void {
    for (const key of this.lastSent.keys()) {
      if (!activeKeys.has(key)) this.lastSent.delete(key);
    }
  }
}
