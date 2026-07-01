import { Bot } from "grammy";
import { db } from "../db/client.js";
import { setChatRepoBinding, getChatRepoBinding } from "../db/records.js";
import { parseRepoFullName } from "../core/repo.js";
import {
  parseTaskCommand,
  RepoResolutionError,
  resolveRepoForIntake,
} from "./repo-resolver.js";
import { createAndEnqueueTask } from "./task-creator.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");

export const bot = new Bot(token);

/** Pending /task requests waiting for a repo reply (no automatic timeout). */
const pendingRepoPrompts = new Map<string, { goal: string }>();

export async function sendNotification(text: string): Promise<void> {
  await bot.api.sendMessage(chatId!, text, { parse_mode: "Markdown" });
}

async function createTaskFromTelegram(
  chatIdStr: string,
  goal: string,
  repoFlag: string | null,
  reply: (text: string, markdown?: boolean) => Promise<unknown>,
): Promise<void> {
  if (!goal) {
    await reply("Usage: /task <describe what you want built> [--repo owner/name]");
    return;
  }

  try {
    const repo = await resolveRepoForIntake({ repoFlag, chatId: chatIdStr });
    await reply("Creating task…");
    const { taskId, repoFullName } = await createAndEnqueueTask({
      goal,
      context: "Task created via Telegram bot.",
      sourceLabel: "telegram",
      sourceKind: "telegram",
      repo,
      sourceContext: { telegram_chat_id: chatIdStr },
    });
    await reply(
      `✅ *${taskId}* created for \`${repoFullName}\` and queued for planning.\n` +
        `I'll notify you when the contract is ready.`,
      true,
    );
  } catch (err) {
    if (err instanceof RepoResolutionError) {
      pendingRepoPrompts.set(chatIdStr, { goal });
      await reply(
        "Which repo should this target?\n\n" +
          "Reply with `owner/repo`, or use:\n" +
          "`/repo set owner/repo` then resend your task,\n" +
          "or `/task ... --repo owner/repo`",
        true,
      );
      return;
    }
    await reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

bot.command("task", async (ctx) => {
  const { goal, repoFlag } = parseTaskCommand(ctx.match?.trim() ?? "");
  await createTaskFromTelegram(String(ctx.chat.id), goal, repoFlag, (text, markdown) =>
    ctx.reply(text, markdown ? { parse_mode: "Markdown" } : undefined),
  );
});

bot.command("repo", async (ctx) => {
  const args = ctx.match?.trim() ?? "";
  const chatIdStr = String(ctx.chat.id);

  if (args.startsWith("set ")) {
    const repoInput = args.slice(4).trim();
    const parsed = parseRepoFullName(repoInput);
    if (!parsed) {
      await ctx.reply("Usage: /repo set owner/repo");
      return;
    }
    await setChatRepoBinding(chatIdStr, parsed);
    await ctx.reply(`✅ Default repo for this chat set to \`${parsed}\`.`, { parse_mode: "Markdown" });
    return;
  }

  if (args === "current" || args === "") {
    const binding = await getChatRepoBinding(chatIdStr);
    const envDefault = process.env.TASKGRAPH_DEFAULT_REPO?.trim();
    await ctx.reply(
      binding
        ? `Default repo: \`${binding}\``
        : envDefault
          ? `No chat binding. Env default: \`${envDefault}\``
          : "No default repo. Use `/repo set owner/repo`.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  await ctx.reply("Usage:\n/repo set owner/repo\n/repo current");
});

bot.on("message:text", async (ctx, next) => {
  const chatIdStr = String(ctx.chat.id);
  const pending = pendingRepoPrompts.get(chatIdStr);
  if (!pending) {
    await next();
    return;
  }

  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    await next();
    return;
  }

  const parsed = parseRepoFullName(text);
  if (!parsed) {
    await ctx.reply("Please reply with a valid `owner/repo` slug.", { parse_mode: "Markdown" });
    return;
  }

  pendingRepoPrompts.delete(chatIdStr);
  await createTaskFromTelegram(chatIdStr, pending.goal, parsed, (text, markdown) =>
    ctx.reply(text, markdown ? { parse_mode: "Markdown" } : undefined),
  );
});

bot.command("status", async (ctx) => {
  const taskId = ctx.match?.trim().toUpperCase();
  if (!taskId || !/^T-\d+$/.test(taskId)) {
    await ctx.reply("Usage: /status T-001");
    return;
  }
  try {
    const { data, error } = await db
      .from("tasks")
      .select("id, title, status, repo_full_name, updated_at")
      .eq("id", taskId)
      .single();

    if (error || !data) {
      await ctx.reply(`Task ${taskId} not found.`);
      return;
    }
    const t = data as {
      id: string;
      title: string;
      status: string;
      repo_full_name: string | null;
      updated_at: string;
    };
    const repoLine = t.repo_full_name ? `\nRepo: \`${t.repo_full_name}\`` : "";
    await ctx.reply(
      `*${t.id}* — ${t.status}\n${t.title}${repoLine}\n_Updated: ${new Date(t.updated_at).toLocaleString()}_`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 *TaskGraph OS*\n\n" +
      "/task <goal> [--repo owner/name] — queue a new task\n" +
      "/repo set owner/repo — default repo for this chat\n" +
      "/repo current — show default repo\n" +
      "/status T-001 — check task status\n\n" +
      "I'll message you here when tasks need attention.",
    { parse_mode: "Markdown" },
  );
});
