import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { runCommand, runShellCommand } from "../../src/core/command.js";
import { physicalQueueName } from "../../src/core/queue-names.js";
import type { QueueJobType } from "../../src/core/types.js";

export interface ProbeResult {
  name: string;
  ok: boolean;
  message: string;
  optional: boolean;
}

export interface CommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HealthProbeDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  runCommand: (
    command: string,
    args: string[],
    options?: { timeoutMs?: number },
  ) => Promise<CommandOutcome>;
  runShellCommand?: (
    command: string,
    options?: { timeoutMs?: number },
  ) => Promise<CommandOutcome>;
}

export interface SupabaseProbeClient {
  from(table: string): {
    select(columns: string): {
      limit(count: number): Promise<{ error: { message: string } | null }>;
    };
  };
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ error: { message: string } | null }>;
}

const QUEUES: QueueJobType[] = [
  "task.plan.requested",
  "task.design.requested",
  "task.execution.requested",
  "task.verification.requested",
  "task.release.requested",
  "task.rework.requested",
];

const ALWAYS_REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY",
] as const;

function result(
  name: string,
  ok: boolean,
  message: string,
  optional = false,
): ProbeResult {
  return { name, ok, message, optional };
}

export function probeRequiredEnv(env: NodeJS.ProcessEnv): ProbeResult {
  const missing = ALWAYS_REQUIRED_ENV.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    return result(
      "env",
      false,
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
  return result("env", true, "Required environment variables are set");
}

export async function probeSupabaseTasks(
  db: SupabaseProbeClient,
): Promise<ProbeResult> {
  const { error } = await db.from("tasks").select("id").limit(1);
  if (error) {
    return result("supabase_tasks", false, `Cannot read tasks table: ${error.message}`);
  }
  return result("supabase_tasks", true, "Supabase tasks table is readable");
}

export async function probeSupabaseQueues(
  db: SupabaseProbeClient,
): Promise<ProbeResult> {
  for (const queue of QUEUES) {
    const physical = physicalQueueName(queue);
    const { error } = await db.rpc("pgmq_metrics", { queue_name: physical });
    if (error) {
      return result(
        "supabase_queues",
        false,
        `Queue ${physical} is not available: ${error.message}`,
      );
    }
  }
  return result("supabase_queues", true, "All PGMQ queues respond to metrics");
}

export async function probeOpenRouter(deps: HealthProbeDeps): Promise<ProbeResult> {
  const apiKey = deps.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return result("openrouter", false, "OPENROUTER_API_KEY is not set");
  }

  try {
    // Must be an AUTHENTICATED endpoint: /models is public and returns 200
    // regardless of key validity, which silently defeated this probe.
    // /key requires auth and reports the key's usage/limit state.
    const response = await deps.fetch("https://openrouter.ai/api/v1/key", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 401) {
      return result("openrouter", false, "OpenRouter rejected the API key (401 Unauthorized)");
    }
    if (response.status === 402) {
      return result(
        "openrouter",
        false,
        "OpenRouter account has insufficient credits (402 Payment Required)",
      );
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      return result(
        "openrouter",
        false,
        `OpenRouter API returned ${response.status}: ${body || response.statusText}`,
      );
    }

    return result("openrouter", true, "OpenRouter API key is valid");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result("openrouter", false, `OpenRouter API unreachable: ${message}`);
  }
}

export async function probeClaudeCode(deps: HealthProbeDeps): Promise<ProbeResult> {
  const command = deps.env.CLAUDE_CODE_COMMAND?.trim() || "claude";
  const timeoutMs = 30_000;
  const flagAttempts = ["--version", "-v", "--help"];

  const attempts: Array<() => Promise<CommandOutcome>> = [];

  if (process.platform === "win32" && deps.runShellCommand) {
    for (const flag of flagAttempts) {
      attempts.push(() => deps.runShellCommand!(`${command} ${flag}`, { timeoutMs }));
    }
  }

  for (const flag of flagAttempts) {
    attempts.push(() => deps.runCommand(command, [flag], { timeoutMs }));
  }

  for (const attempt of attempts) {
    const outcome = await attempt();
    if (outcome.exitCode === 0) {
      const detail = (outcome.stdout || outcome.stderr).trim().split("\n")[0];
      return result(
        "claude_code",
        true,
        detail ? `${command} CLI is available (${detail})` : `${command} CLI is available`,
      );
    }
  }

  const last = await deps.runCommand(command, ["--version"], { timeoutMs });
  const detail = (last.stderr || last.stdout).trim().slice(0, 300);
  return result(
    "claude_code",
    false,
    `${command} is not available (${detail || "exit " + last.exitCode})`,
  );
}

export async function probeGit(deps: HealthProbeDeps): Promise<ProbeResult> {
  const outcome = await deps.runCommand("git", ["--version"], { timeoutMs: 10_000 });
  if (outcome.exitCode !== 0) {
    return result("git", false, "git is not available on PATH");
  }
  const version = outcome.stdout.trim().split("\n")[0] ?? "git";
  return result("git", true, version);
}

export async function probeWorktreeRoot(deps: HealthProbeDeps): Promise<ProbeResult> {
  const root = deps.env.TASKGRAPH_WORKTREE_ROOT?.trim();
  if (!root) {
    return result("worktree_root", false, "TASKGRAPH_WORKTREE_ROOT is not set");
  }

  try {
    await mkdir(root, { recursive: true });
    await access(root, constants.W_OK);
    const probeFile = join(root, `.taskgraph-healthcheck-${process.pid}`);
    await writeFile(probeFile, "ok", "utf8");
    await unlink(probeFile);
    return result("worktree_root", true, `Worktree root is writable: ${root}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result("worktree_root", false, `Worktree root not usable (${root}): ${message}`);
  }
}

function githubProbeRequired(env: NodeJS.ProcessEnv): boolean {
  return env.GITHUB_CREATE_PR === "true" || Boolean(env.GITHUB_TOKEN?.trim());
}

export async function probeGitHub(deps: HealthProbeDeps): Promise<ProbeResult | null> {
  if (!githubProbeRequired(deps.env)) {
    return null;
  }

  const outcome = await deps.runCommand("gh", ["auth", "status"], { timeoutMs: 15_000 });
  if (outcome.exitCode === 0) {
    return result("github", true, "GitHub CLI is authenticated");
  }

  const token = deps.env.GITHUB_TOKEN?.trim();
  if (token) {
    try {
      const response = await deps.fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "TaskGraph-OS-Healthcheck",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401) {
        return result("github", false, "GITHUB_TOKEN is invalid (401 Unauthorized)");
      }
      if (!response.ok) {
        return result("github", false, `GitHub API returned ${response.status}`);
      }
      return result("github", true, "GITHUB_TOKEN is valid");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return result("github", false, `GitHub API unreachable: ${message}`);
    }
  }

  const detail = (outcome.stderr || outcome.stdout).trim().slice(0, 300);
  return result(
    "github",
    false,
    `GitHub CLI is not authenticated (${detail || "gh auth status failed"})`,
  );
}

function postgresProbeRequired(env: NodeJS.ProcessEnv): boolean {
  return (
    Boolean(env.DATABASE_URL?.trim()) &&
    env.TASKGRAPH_DISABLE_POSTGRES_CHECKPOINT !== "true"
  );
}

export async function probePostgresCheckpoint(env: NodeJS.ProcessEnv): Promise<ProbeResult | null> {
  if (!postgresProbeRequired(env)) {
    return null;
  }

  const databaseUrl = env.DATABASE_URL!.trim();
  try {
    const pg = await import("pg");
    const client = new pg.Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 8_000,
    });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return result("postgres_checkpoint", true, "Postgres checkpointer database is reachable");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result(
      "postgres_checkpoint",
      false,
      `Postgres checkpointer connection failed: ${message}`,
    );
  }
}

function telegramProbeRequired(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
}

export async function probeTelegram(deps: HealthProbeDeps): Promise<ProbeResult | null> {
  if (!telegramProbeRequired(deps.env)) {
    return null;
  }

  const token = deps.env.TELEGRAM_BOT_TOKEN!.trim();
  try {
    const response = await deps.fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return result("telegram", false, `Telegram getMe returned ${response.status}`);
    }
    const body = (await response.json()) as { ok?: boolean; description?: string };
    if (!body.ok) {
      return result("telegram", false, `Telegram bot token invalid: ${body.description ?? "getMe failed"}`);
    }
    return result("telegram", true, "Telegram bot token is valid");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result("telegram", false, `Telegram API unreachable: ${message}`);
  }
}

export function probeTelegramChatId(env: NodeJS.ProcessEnv): ProbeResult | null {
  if (!telegramProbeRequired(env)) {
    return null;
  }
  if (!env.TELEGRAM_CHAT_ID?.trim()) {
    return result(
      "telegram_chat_id",
      false,
      "TELEGRAM_CHAT_ID is required when TELEGRAM_BOT_TOKEN is set",
      true,
    );
  }
  return result("telegram_chat_id", true, "TELEGRAM_CHAT_ID is set", true);
}

export function probeGitHubWebhookSecret(env: NodeJS.ProcessEnv): ProbeResult | null {
  if (!telegramProbeRequired(env)) {
    return null;
  }
  if (!env.GITHUB_WEBHOOK_SECRET?.trim()) {
    return result(
      "github_webhook_secret",
      false,
      "GITHUB_WEBHOOK_SECRET is not set (GitHub intake webhooks will not verify)",
      true,
    );
  }
  return result("github_webhook_secret", true, "GITHUB_WEBHOOK_SECRET is set", true);
}

export interface RunHealthProbesOptions {
  strict?: boolean;
  db?: SupabaseProbeClient;
}

export interface HealthProbeSummary {
  ok: boolean;
  results: ProbeResult[];
}

export function evaluateProbeResults(
  results: ProbeResult[],
  strict = false,
): boolean {
  for (const probe of results) {
    if (!probe.ok && (!probe.optional || strict)) {
      return false;
    }
  }
  return true;
}

export async function runHealthProbes(
  deps: HealthProbeDeps,
  options: RunHealthProbesOptions = {},
): Promise<HealthProbeSummary> {
  const results: ProbeResult[] = [];

  results.push(probeRequiredEnv(deps.env));
  if (!results[0]!.ok) {
    return { ok: false, results };
  }

  if (options.db) {
    results.push(await probeSupabaseTasks(options.db));
    results.push(await probeSupabaseQueues(options.db));
  }

  results.push(await probeOpenRouter(deps));
  results.push(await probeClaudeCode(deps));
  results.push(await probeGit(deps));
  results.push(await probeWorktreeRoot(deps));

  const github = await probeGitHub(deps);
  if (github) results.push(github);

  const postgres = await probePostgresCheckpoint(deps.env);
  if (postgres) results.push(postgres);

  const telegram = await probeTelegram(deps);
  if (telegram) results.push(telegram);

  const chatId = probeTelegramChatId(deps.env);
  if (chatId) results.push(chatId);

  const webhookSecret = probeGitHubWebhookSecret(deps.env);
  if (webhookSecret) results.push(webhookSecret);

  return {
    ok: evaluateProbeResults(results, options.strict ?? false),
    results,
  };
}

export function defaultHealthProbeDeps(env: NodeJS.ProcessEnv = process.env): HealthProbeDeps {
  return {
    env,
    fetch,
    runCommand: async (command, args, opts) => {
      const outcome = await runCommand(command, args, opts);
      return {
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      };
    },
    runShellCommand: async (command, opts) => {
      const outcome = await runShellCommand(command, opts);
      return {
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      };
    },
  };
}

export function formatProbeResults(results: ProbeResult[], strict = false): string {
  const lines = results.map((probe) => {
    const tag = probe.optional ? (strict ? "optional*" : "optional") : "required";
    const status = probe.ok ? "PASS" : "FAIL";
    return `[${status}] ${probe.name} (${tag}): ${probe.message}`;
  });
  return lines.join("\n");
}
