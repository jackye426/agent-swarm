import { db } from "../db/client.js";
import { sendNotification } from "./telegram.js";

interface NotificationPayload {
  type: string;
  task_id: string;
  contract_title?: string;
  message?: string;
  agent_run_id?: string;
}

// Formats a human_notification artifact into a Telegram message.
function formatNotification(payload: NotificationPayload): string {
  const taskLink = `*${payload.task_id}*`;

  switch (payload.type) {
    case "contract_auto_approved":
      return (
        `✅ ${taskLink} — contract auto-approved\n` +
        `*${payload.contract_title ?? ""}*\n` +
        `Planning complete. Task is now READY for engineering.\n` +
        `Run \`/status ${payload.task_id}\` to check.`
      );
    default:
      return `📬 ${taskLink}: ${payload.message ?? payload.type}`;
  }
}

// Subscribes to new human_notification artifacts via Supabase Realtime.
// Forwards each one to Telegram immediately.
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
        try {
          const content = change.new.content as NotificationPayload | null;
          if (!content) return;
          const message = formatNotification(content);
          await sendNotification(message);
        } catch (err) {
          console.error("[Notifications] Failed to send Telegram notification:", err);
        }
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("[Notifications] Watching for human_notification artifacts via Realtime");
      }
    });
}
