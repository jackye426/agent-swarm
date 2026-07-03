import { db } from "../db/client.js";
import { sendNotification } from "./telegram.js";

export interface NotificationPayload {
  type: string;
  task_id: string;
  contract_title?: string;
  message?: string;
  errors?: string[];
  agent_run_id?: string;
}

// Formats a human_notification artifact into a Telegram message.
export function formatNotification(payload: NotificationPayload): string {
  const taskLink = `*${payload.task_id}*`;

  switch (payload.type) {
    case "contract_auto_approved":
      return (
        `✅ ${taskLink} — contract auto-approved\n` +
        `*${payload.contract_title ?? ""}*\n` +
        `Planning complete. Task is now READY for engineering.\n` +
        `Run \`/status ${payload.task_id}\` to check.`
      );
    case "contract_validation_failed": {
      const errorLines =
        payload.errors && payload.errors.length > 0
          ? payload.errors.map((e) => `• ${e}`).join("\n")
          : "(no error details)";
      return (
        `⚠️ ${taskLink} — contract validation failed\n` +
        `*${payload.contract_title ?? ""}*\n` +
        `Executability errors:\n${errorLines}\n` +
        `Check the contract_validation_failed artifact for details.`
      );
    }
    case "task_complete":
      return (
        `🎉 ${taskLink} — COMPLETE\n\n` +
        `${payload.message ?? "Verification passed. Task is complete."}`
      );
    case "rework_escalated":
      return (
        `🚫 ${taskLink} — BLOCKED after max rework attempts\n\n` +
        `${payload.message ?? ""}\n\n` +
        `Revise the contract scope or intervene manually.`
      );
    default:
      return `📬 ${taskLink}: ${payload.message ?? payload.type}`;
  }
}

const POLL_INTERVAL_MS = Number(process.env.NOTIFY_POLL_INTERVAL_MS ?? 60_000);
const POLL_LOOKBACK_MS = Number(process.env.NOTIFY_POLL_LOOKBACK_MS ?? 600_000);

/** Artifact ids already forwarded, so Realtime and the poller never double-send. */
const deliveredIds = new Set<string>();

async function forwardNotification(
  artifactId: string,
  content: NotificationPayload | null,
): Promise<void> {
  if (!content || deliveredIds.has(artifactId)) return;
  deliveredIds.add(artifactId);
  try {
    await sendNotification(formatNotification(content));
    console.log(`[Notifications] Delivered ${content.type} for ${content.task_id} (${artifactId})`);
  } catch (err) {
    // Un-mark so the poller retries on its next cycle instead of dropping it.
    deliveredIds.delete(artifactId);
    console.error("[Notifications] Failed to send Telegram notification:", err);
  }
}

// Watches for new human_notification artifacts on two channels:
//   1. Supabase Realtime (instant) — requires the artifacts table in the
//      supabase_realtime publication (migration 005). Misconfiguration there
//      is SILENT: the channel subscribes fine and simply never fires.
//   2. Polling fallback (default every 60 s, 10 min lookback) — guarantees
//      delivery even when Realtime is misconfigured or drops the connection,
//      and redelivers notifications written during a short intake restart.
// deliveredIds dedupes across both channels.
export function startNotificationWatcher(): void {
  db.channel("human-notifications")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "artifacts",
        filter: "artifact_type=eq.human_notification",
      },
      async (change) => {
        await forwardNotification(
          change.new.id as string,
          change.new.content as NotificationPayload | null,
        );
      },
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log("[Notifications] Watching for human_notification artifacts via Realtime");
      } else {
        console.warn(`[Notifications] Realtime channel status: ${status}`, err ?? "");
      }
    });

  // Watermark starts one lookback window in the past so notifications written
  // just before an intake restart still get delivered.
  let watermark = new Date(Date.now() - POLL_LOOKBACK_MS).toISOString();

  setInterval(async () => {
    try {
      const { data, error } = await db
        .from("artifacts")
        .select("id, content, created_at")
        .eq("artifact_type", "human_notification")
        .gt("created_at", watermark)
        .order("created_at", { ascending: true });
      if (error || !data) return;

      for (const row of data as Array<{
        id: string;
        content: NotificationPayload | null;
        created_at: string;
      }>) {
        await forwardNotification(row.id, row.content);
        if (row.created_at > watermark) watermark = row.created_at;
      }
    } catch (err) {
      console.error("[Notifications] Poll cycle failed:", err);
    }
  }, POLL_INTERVAL_MS);

  console.log(
    `[Notifications] Polling fallback active (every ${Math.round(POLL_INTERVAL_MS / 1000)} s)`,
  );
}
