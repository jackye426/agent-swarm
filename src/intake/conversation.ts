/**
 * Conversational intake — plain-language Telegram → scoped task chain.
 *
 * Any non-command Telegram message lands here. An LLM plays requirements
 * analyst: it asks clarifying questions in plain language (no repo slugs, no
 * command syntax required from the user), and once the user confirms a
 * proposed breakdown, it emits a create_tasks action. We then create the
 * tasks via the normal intake path, chained with task_dependencies so the
 * scheduler executes them strictly in order — each task stays inside the
 * pipeline's proven envelope (one focused change, npm-test/diff verifiable).
 *
 * Grounding: once the conversation settles on a repo (the model declares it
 * via the `repo` field on reply actions, or the chat has a default binding),
 * subsequent turns include a compact snapshot from the seed scanner — file
 * tree, README excerpt, test commands, recent commits — so questions and task
 * goals reference the real codebase rather than guesses.
 *
 * Memory: per-chat state persists in chat_conversations (migrations 006/007):
 *   messages — current conversation turns (cleared when tasks are created)
 *   notes    — durable project memory appended on each confirmed chain
 *   repo     — the repo the current conversation is grounded in
 */

import { db } from "../db/client.js";
import { invokeRoleModel, type RoleMessage } from "../core/model-router.js";
import { parseRepoFullName, repoUrlFromFullName } from "../core/repo.js";
import { getChatRepoBinding } from "../db/records.js";
import { createAndEnqueueTask, type CreatedTask } from "./task-creator.js";
import { scanRepoSeedContext, type SeedRepoContext } from "./repo-scanner.js";

const MAX_HISTORY_MESSAGES = 40;
const MAX_NOTES_CHARS = 4_000;
const MAX_SNAPSHOT_CHARS = 2_500;

export interface ConversationTaskSpec {
  goal: string;
  context?: string;
  /** Chain onto the previous task in the list — scheduler waits for it to COMPLETE. */
  depends_on_previous?: boolean;
}

export type ConversationAction =
  | { action: "reply"; message: string; repo?: string }
  | {
      action: "create_tasks";
      repo: string;
      /** Audit trail: what the agent believed the agreed requirements were. */
      requirements_summary: string;
      message?: string;
      tasks: ConversationTaskSpec[];
    };

/** Parse the model's JSON action. Returns null when the shape is unusable. */
export function parseConversationAction(content: string): ConversationAction | null {
  let parsed: unknown;
  try {
    const fenced = content.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
    parsed = JSON.parse(fenced?.[1] ?? content.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.action === "reply" && typeof obj.message === "string" && obj.message.trim()) {
    const repo =
      typeof obj.repo === "string" && parseRepoFullName(obj.repo)
        ? parseRepoFullName(obj.repo)!
        : undefined;
    return { action: "reply", message: obj.message, ...(repo ? { repo } : {}) };
  }

  if (
    obj.action === "create_tasks" &&
    typeof obj.repo === "string" &&
    typeof obj.requirements_summary === "string" &&
    obj.requirements_summary.trim().length > 0 &&
    Array.isArray(obj.tasks) &&
    obj.tasks.length > 0 &&
    obj.tasks.every(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Record<string, unknown>).goal === "string" &&
        ((t as Record<string, unknown>).goal as string).trim().length > 0,
    )
  ) {
    return {
      action: "create_tasks",
      repo: obj.repo,
      requirements_summary: obj.requirements_summary.trim(),
      message: typeof obj.message === "string" ? obj.message : undefined,
      tasks: (obj.tasks as Array<Record<string, unknown>>).map((t) => ({
        goal: (t.goal as string).trim(),
        context: typeof t.context === "string" ? t.context : undefined,
        depends_on_previous: t.depends_on_previous === true,
      })),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Repo snapshot (grounding)
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}

/** Compact, prompt-ready summary of the seed scan. Ground truth for the agent. */
export function formatRepoSnapshot(seed: SeedRepoContext, maxChars = MAX_SNAPSHOT_CHARS): string {
  const sections = [
    `Current repo snapshot: ${seed.repo_full_name} (scanned ${seed.scanned_at})`,
    seed.test_commands.length > 0
      ? `Test commands: ${seed.test_commands.join(", ")}`
      : "Test commands: (none detected)",
    seed.recent_commits.length > 0
      ? `Recent commits:\n${seed.recent_commits.slice(0, 5).join("\n")}`
      : null,
    seed.readme_excerpt ? `README excerpt:\n${truncate(seed.readme_excerpt, 800)}` : null,
    seed.file_tree ? `File tree (top levels):\n${truncate(seed.file_tree, 1_200)}` : null,
  ].filter((s): s is string => Boolean(s));

  return truncate(sections.join("\n\n"), maxChars);
}

async function loadRepoSnapshot(repoFullName: string): Promise<string | null> {
  try {
    // Cached for REPO_CACHE_MAX_AGE_MS (default 10 min) — repeat turns are free.
    const seed = await scanRepoSeedContext(repoFullName);
    return formatRepoSnapshot(seed);
  } catch (err) {
    console.warn(`[Conversation] Repo snapshot failed for ${repoFullName}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistence (chat_conversations, migrations 006 + 007)
// ---------------------------------------------------------------------------

interface ConversationState {
  messages: RoleMessage[];
  notes: string | null;
  repo: string | null;
}

async function loadConversation(chatId: string): Promise<ConversationState> {
  try {
    // select("*") stays compatible if migration 007 hasn't been applied yet.
    const { data, error } = await db
      .from("chat_conversations")
      .select("*")
      .eq("chat_id", chatId)
      .maybeSingle();
    if (error || !data) return { messages: [], notes: null, repo: null };
    const row = data as { messages?: RoleMessage[]; notes?: string | null; repo?: string | null };
    return {
      messages: (row.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant"),
      notes: row.notes ?? null,
      repo: row.repo && parseRepoFullName(row.repo) ? row.repo : null,
    };
  } catch {
    return { messages: [], notes: null, repo: null };
  }
}

async function saveConversation(
  chatId: string,
  fields: Partial<{ messages: RoleMessage[]; notes: string | null; repo: string | null }>,
): Promise<void> {
  try {
    await db.from("chat_conversations").upsert({
      chat_id: chatId,
      ...(fields.messages ? { messages: fields.messages.slice(-MAX_HISTORY_MESSAGES) } : {}),
      ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
      ...(fields.repo !== undefined ? { repo: fields.repo } : {}),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    // Conversation continues in-memory for this turn; state just won't survive a restart.
    console.warn("[Conversation] Failed to persist state:", err);
  }
}

/** /reset — restart the conversation but keep project notes and repo. */
export async function clearConversation(chatId: string): Promise<void> {
  await saveConversation(chatId, { messages: [] });
}

/** /forget — wipe everything this chat has taught the agent. */
export async function forgetChat(chatId: string): Promise<void> {
  try {
    await db.from("chat_conversations").delete().eq("chat_id", chatId);
  } catch (err) {
    console.warn("[Conversation] Failed to forget chat:", err);
  }
}

/** Append a dated entry to project notes, keeping the most recent MAX_NOTES_CHARS. */
export function appendProjectNote(existing: string | null, entry: string): string {
  const combined = existing ? `${existing}\n${entry}` : entry;
  // Keep the tail — the most recent notes matter most.
  return combined.length <= MAX_NOTES_CHARS ? combined : combined.slice(-MAX_NOTES_CHARS);
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

async function knownRepos(chatId: string): Promise<{ repos: string[]; chatDefault: string | null }> {
  const chatDefault = await getChatRepoBinding(chatId).catch(() => null);
  const repos = new Set<string>();
  if (chatDefault) repos.add(chatDefault);
  const envDefault = process.env.TASKGRAPH_DEFAULT_REPO?.trim();
  if (envDefault && parseRepoFullName(envDefault)) repos.add(envDefault);
  try {
    const { data } = await db
      .from("tasks")
      .select("repo_full_name")
      .not("repo_full_name", "is", null)
      .order("id", { ascending: false })
      .limit(30);
    for (const row of (data ?? []) as Array<{ repo_full_name: string }>) {
      repos.add(row.repo_full_name);
    }
  } catch {
    /* repo list is a convenience, not a requirement */
  }
  return { repos: [...repos].slice(0, 10), chatDefault };
}

interface PromptContext {
  repos: string[];
  chatDefault: string | null;
  repoSnapshot: string | null;
  notes: string | null;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const repoList =
    ctx.repos.length > 0 ? ctx.repos.map((r) => `- ${r}`).join("\n") : "- (none yet)";

  return `You are the intake assistant for TaskGraph OS, an autonomous software delivery pipeline. You are chatting with the product owner on Telegram.

THE USER IS NOT TECHNICAL. Never ask for repo slugs, branch names, or command syntax. Speak plainly, keep messages short (Telegram), ask at most 1-2 questions per message.

Known project repositories (most recently used first):
${repoList}
${ctx.chatDefault ? `Default for this chat: ${ctx.chatDefault}` : "No default repo for this chat."}
If the target project is ambiguous, ask in plain words (e.g. "Is this for the sandbox project or the agent-swarm project?") and map the answer to a repo yourself. As soon as you have settled which repo the work targets, include it as "repo" on your reply action — the system will then give you a snapshot of that repo's contents.
${
  ctx.repoSnapshot
    ? `\n${ctx.repoSnapshot}\n\nTreat the snapshot above as ground truth: reference its real files, scripts, and test commands in your questions and task goals (e.g. "extend scripts/healthcheck.js or add a new file?").`
    : ""
}${
  ctx.notes
    ? `\nWhat this chat has built before (project notes):\n${ctx.notes}\nUse these to resolve references like "the dashboard we built" without re-asking.`
    : ""
}

YOUR JOB, IN ORDER:
1. Understand what they want built. Ask clarifying questions until the READINESS CHECKLIST below is satisfied. Do not interrogate — 1-2 rounds is usually enough for small projects; vague big ideas may need more.
2. Propose a breakdown as a short numbered list in plain language, with your repo choice, and ask for confirmation.
3. Only after the user clearly confirms (e.g. "yes", "go ahead", "proceed"), emit the create_tasks action.

READINESS CHECKLIST — do not propose a breakdown until you can state ALL of:
- The outcome: what user-visible behavior exists when the work is done.
- The target repo.
- Per task, what "done" looks like in mechanically verifiable terms (a test command passes and/or specific things visible in the code diff).
- Constraints: are new dependencies allowed? any files or areas off-limits?
- Any assumption you are making to fill a gap — state it to the user rather than silently assuming.

TASK SIZING RULES (the pipeline's proven envelope — breaking these causes failed runs):
- Each task = ONE focused change: a few files, completable in under an hour of focused work.
- Each task must be verifiable mechanically. Say so in the task's context.
- Big projects become a CHAIN of such tasks, each depends_on_previous so they execute strictly in order.
- Each task's context should carry constraints the builder needs: which files, test command, "no new dependencies" if applicable, and anything agreed in this conversation that the task depends on.
- Tasks run autonomously once created — a task's goal+context must stand alone without this chat.

RESPONSE FORMAT — you MUST reply with a single JSON object, nothing else:
- To talk to the user: {"action":"reply","message":"<your message>","repo":"owner/name (include once the target repo is settled)"}
- To create the confirmed tasks: {"action":"create_tasks","repo":"owner/name","requirements_summary":"<3-6 sentences: the agreed requirements, constraints, and your assumptions>","message":"<short confirmation to send after creating>","tasks":[{"goal":"...","context":"...","depends_on_previous":false},{"goal":"...","context":"...","depends_on_previous":true}]}
requirements_summary is REQUIRED on create_tasks — it becomes the audit record of what was agreed.
Never emit create_tasks without an explicit user confirmation of your proposed breakdown in this conversation.`;
}

// ---------------------------------------------------------------------------
// Task chain creation
// ---------------------------------------------------------------------------

async function createTaskChain(
  chatId: string,
  action: Extract<ConversationAction, { action: "create_tasks" }>,
): Promise<CreatedTask[]> {
  const repoFullName = parseRepoFullName(action.repo);
  if (!repoFullName) {
    throw new Error(`Model proposed an invalid repo: ${action.repo}`);
  }

  const created: CreatedTask[] = [];
  for (const [index, spec] of action.tasks.entries()) {
    // Prepend the agreed requirements so downstream cells (planning contract
    // draft, engineering) see the conversation's decisions, not just the goal.
    const context = [
      `Agreed requirements (from intake conversation):\n${action.requirements_summary}`,
      spec.context ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const task = await createAndEnqueueTask({
      goal: spec.goal,
      context,
      sourceLabel: "telegram-conversation",
      sourceKind: "telegram",
      repo: {
        repoFullName,
        repoUrl: repoUrlFromFullName(repoFullName),
        resolutionSource: "chat_binding",
      },
      sourceContext: {
        telegram_chat_id: chatId,
        conversation_position: index + 1,
        requirements_summary: action.requirements_summary,
      },
    });

    if (spec.depends_on_previous && created.length > 0) {
      const { error } = await db.from("task_dependencies").insert({
        task_id: task.taskId,
        depends_on_id: created[created.length - 1]!.taskId,
      });
      if (error) {
        console.warn(
          `[Conversation] Failed to record dependency ${task.taskId} → ${created[created.length - 1]!.taskId}: ${error.message}`,
        );
      }
    }
    created.push(task);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleConversationMessage(
  chatId: string,
  text: string,
  reply: (text: string) => Promise<unknown>,
): Promise<void> {
  const state = await loadConversation(chatId);
  const userMessage: RoleMessage = { role: "user", content: text };
  const { repos, chatDefault } = await knownRepos(chatId);

  // Ground the conversation in the settled repo (or the chat default).
  const groundingRepo = state.repo ?? chatDefault;
  const repoSnapshot = groundingRepo ? await loadRepoSnapshot(groundingRepo) : null;

  let content: string;
  try {
    content = await invokeRoleModel(
      "intake_conversation",
      [
        {
          role: "system",
          content: buildSystemPrompt({ repos, chatDefault, repoSnapshot, notes: state.notes }),
        },
        ...state.messages,
        userMessage,
      ],
      { temperature: 0.4, responseFormat: "json_object" },
    );
  } catch (err) {
    console.error("[Conversation] Model call failed:", err);
    await reply("Sorry — I hit an error thinking about that. Try again in a minute.");
    return;
  }

  const action = parseConversationAction(content) ?? {
    // Malformed JSON: treat the raw content as a reply rather than dropping the turn.
    action: "reply" as const,
    message: content.slice(0, 2000),
  };

  if (action.action === "reply") {
    await saveConversation(chatId, {
      messages: [...state.messages, userMessage, { role: "assistant", content: action.message }],
      // Persist the repo the agent declared so the next turn is grounded.
      ...(action.repo && action.repo !== state.repo ? { repo: action.repo } : {}),
    });
    await reply(action.message);
    return;
  }

  // create_tasks
  try {
    const created = await createTaskChain(chatId, action);
    const list = created
      .map((t, i) => `${i + 1}. ${t.taskId} — ${t.goal.slice(0, 80)}`)
      .join("\n");
    await reply(
      `${action.message ?? "On it — work is queued."}\n\n` +
        `Created ${created.length} task(s) on ${created[0]!.repoFullName}:\n${list}\n\n` +
        `I'll notify you here as each one completes. /status ${created[0]!.taskId} to peek.`,
    );

    // Requirements now live in the tasks; fold them into durable project notes
    // and start the next conversation fresh (notes + repo survive).
    const noteEntry =
      `[${new Date().toISOString().slice(0, 10)}] ${created[0]!.repoFullName} ` +
      `${created.map((t) => t.taskId).join(", ")}: ${action.requirements_summary.slice(0, 500)}`;
    await saveConversation(chatId, {
      messages: [],
      notes: appendProjectNote(state.notes, noteEntry),
      repo: parseRepoFullName(action.repo),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Conversation] Task creation failed:", err);
    await saveConversation(chatId, {
      messages: [
        ...state.messages,
        userMessage,
        { role: "assistant", content: `(task creation failed: ${message})` },
      ],
    });
    await reply(
      `I tried to queue the work but hit an error: ${message}\nNothing may have been created — say "try again" and I'll retry.`,
    );
  }
}
