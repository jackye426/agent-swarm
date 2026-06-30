import { Bot } from "grammy";
import { db } from "../db/client.js";
import { createAndEnqueueTask } from "./task-creator.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");

export const bot = new Bot(token);

// Send a message to your personal chat. Used by the notification watcher.
export async function sendNotification(text: string): Promise<void> {
  await bot.api.sendMessage(chatId!, text, { parse_mode: "Markdown" });
}

// ---- Commands ----

// /task <goal text> — creates a new planning task
bot.command("task", async (ctx) => {
  const goal = ctx.match?.trim();
  if (!goal) {
    await ctx.reply("Usage: /task <describe what you want built>");
    return;
  }
  await ctx.reply(`Creating task…`);
  try {
    const { taskId } = await createAndEnqueueTask({
      goal,
      context: "Task created via Telegram bot.",
      source: "telegram",
    });
    await ctx.reply(`✅ *${taskId}* created and queued for planning.\nI'll notify you when the contract is ready.`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// /status T-NNN — shows the current status of a task
bot.command("status", async (ctx) => {
  const taskId = ctx.match?.trim().toUpperCase();
  if (!taskId || !/^T-\d+$/.test(taskId)) {
    await ctx.reply("Usage: /status T-001");
    return;
  }
  try {
    const { data, error } = await db
      .from("tasks")
      .select("id, title, status, updated_at")
      .eq("id", taskId)
      .single();

    if (error || !data) {
      await ctx.reply(`Task ${taskId} not found.`);
      return;
    }
    const t = data as { id: string; title: string; status: string; updated_at: string };
    await ctx.reply(
      `*${t.id}* — ${t.status}\n${t.title}\n_Updated: ${new Date(t.updated_at).toLocaleString()}_`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 *TaskGraph OS*\n\n" +
    "/task <goal> — queue a new task for planning\n" +
    "/status T-001 — check task status\n\n" +
    "I'll message you here when tasks need attention.",
    { parse_mode: "Markdown" },
  );
});
