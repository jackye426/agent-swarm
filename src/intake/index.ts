/**
 * TaskGraph OS — Intake Server
 *
 * Runs three things in one process:
 *   1. Express HTTP server — receives GitHub webhook POSTs
 *   2. Telegram bot (long-poll) — accepts /task and /status commands
 *   3. Supabase Realtime watcher — forwards human_notification artifacts to Telegram
 *
 * Usage: npm run intake
 */

import "dotenv/config";
import { startServer } from "./server.js";
import { bot } from "./telegram.js";
import { startNotificationWatcher } from "./notifications.js";

const PORT = Number(process.env.INTAKE_PORT ?? 3000);

async function main(): Promise<void> {
  // 1. Start GitHub webhook receiver
  await startServer(PORT);

  // 2. Start Supabase Realtime → Telegram notification watcher
  startNotificationWatcher();

  // 3. Start Telegram bot in long-polling mode (no public URL required)
  //    bot.start() blocks and handles updates until the process exits.
  console.log("[Intake] Starting Telegram bot (long-polling)");
  await bot.start({
    onStart: (info) => {
      console.log(`[Intake] Telegram bot @${info.username} is running`);
    },
  });
}

main().catch((err) => {
  console.error("[Intake] Fatal error:", err);
  process.exit(1);
});
