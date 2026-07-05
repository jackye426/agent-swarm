import { Bot } from "grammy";
import { sendTelegramMessage } from "../core/notify.js";
import { db } from "../db/client.js";
import { setChatRepoBinding, getChatRepoBinding } from "../db/records.js";
import { parseRepoFullName } from "../core/repo.js";
import {
  parseTaskCommand,
  RepoResolutionError,
  resolveRepoForIntake,
} from "./repo-resolver.js";
import { createAndEnqueueTask } from "./task-creator.js";
import { formatTaskStatusMessage } from "./status-format.js";
import {
  answerPendingEscalation,
  clearConversation,
  forgetChat,
  handleConversationMessage,
} from "./conversation.js";
import { formatIntakeUserContext } from "./intake-context.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");

export const bot = new Bot(token);

/** Pending /task requests waiting for a repo reply (no automatic timeout). */
const pendingRepoPrompts = new Map<string, { goal: string }>();

export async function sendNotification(text: string): Promise<void> {
  // Shared fetch-based sender (also used by the watchdog) — same Bot API call
  // grammy would make, without coupling notification delivery to the bot instance.
  const result = await sendTelegramMessage(text);
  if (!result.ok) {
    throw new Error(`Telegram notification failed: ${result.message}`);
  }
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
      context: formatIntakeUserContext("telegram"),
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

bot.command("reset", async (ctx) => {
  const chatIdStr = String(ctx.chat.id);
  pendingRepoPrompts.delete(chatIdStr);
  await clearConversation(chatIdStr);
  await ctx.reply("Fresh start — tell me what you'd like built. (I still remember past projects; /forget wipes those too.)");
});

bot.command("forget", async (ctx) => {
  const chatIdStr = String(ctx.chat.id);
  pendingRepoPrompts.delete(chatIdStr);
  await forgetChat(chatIdStr);
  await ctx.reply("All project memory for this chat wiped. Clean slate.");
});

bot.command("answer", async (ctx) => {
  await answerPendingEscalation(String(ctx.chat.id), ctx.match?.trim() ?? "", (text) =>
    ctx.reply(text),
  );
});

bot.on("message:text", async (ctx, next) => {
  const chatIdStr = String(ctx.chat.id);
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    await next();
    return;
  }

  // A pending /task repo prompt takes priority over the conversation flow.
  const pending = pendingRepoPrompts.get(chatIdStr);
  if (pending) {
    const parsed = parseRepoFullName(text);
    if (!parsed) {
      await ctx.reply("Please reply with a valid `owner/repo` slug.", { parse_mode: "Markdown" });
      return;
    }
    pendingRepoPrompts.delete(chatIdStr);
    await createTaskFromTelegram(chatIdStr, pending.goal, parsed, (text, markdown) =>
      ctx.reply(text, markdown ? { parse_mode: "Markdown" } : undefined),
    );
    return;
  }

  // Plain-language path: requirements conversation → confirmed task chain.
  // Telegram's typing indicator auto-clears after ~5s, but the conversation
  // model (plus a possible repo snapshot scan) can easily take longer —
  // without a refresh, the indicator vanishes and the chat looks dead until
  // the reply lands. Keep it alive on an interval for the duration of the call.
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4_000);
  await ctx.replyWithChatAction("typing").catch(() => {});
  try {
    await handleConversationMessage(chatIdStr, text, (message) => ctx.reply(message));
  } finally {
    clearInterval(typingInterval);
  }
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
    await ctx.reply(formatTaskStatusMessage(t));
  } catch (err) {
    await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 *TaskGraph OS*\n\n" +
      "Just tell me what you want built, in your own words — I'll ask questions, " +
      "propose a plan, and queue the work once you confirm.\n\n" +
      "Power-user commands:\n" +
      "/task <goal> [--repo owner/name] — queue a task directly\n" +
      "/repo set owner/repo — default repo for this chat\n" +
      "/status T-001 — check task status\n" +
      "/reset — start the conversation over (keeps project memory)\n" +
      "/forget — wipe this chat's project memory\n" +
      "/answer <decision> — answer a task's clarification question\n\n" +
      "I'll message you here when tasks complete or need attention.",
    { parse_mode: "Markdown" },
  );
});
