import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateProbeResults,
  probeClaudeCode,
  probeGit,
  probeGitHub,
  probeGitHubWebhookSecret,
  probeOpenRouter,
  probeRequiredEnv,
  probeSupabaseQueues,
  probeSupabaseTasks,
  probeTelegram,
  probeTelegramChatId,
  probeWorktreeRoot,
  runHealthProbes,
  type CommandOutcome,
  type HealthProbeDeps,
  type SupabaseProbeClient,
} from "../scripts/lib/health-probes.js";

const baseEnv: NodeJS.ProcessEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  OPENROUTER_API_KEY: "or-key",
  TASKGRAPH_WORKTREE_ROOT: process.cwd(),
  CLAUDE_CODE_COMMAND: "claude",
};

function mockDeps(overrides: Partial<HealthProbeDeps> = {}): HealthProbeDeps {
  return {
    env: { ...baseEnv },
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    ...overrides,
  };
}

function mockDb(options: {
  tasksError?: string | null;
  queueError?: string | null;
} = {}): SupabaseProbeClient {
  return {
    from() {
      return {
        select() {
          return {
            async limit() {
              if (options.tasksError) {
                return { error: { message: options.tasksError } };
              }
              return { error: null };
            },
          };
        },
      };
    },
    async rpc() {
      if (options.queueError) {
        return { error: { message: options.queueError } };
      }
      return { error: null };
    },
  };
}

test("probeRequiredEnv fails when core vars missing", () => {
  const result = probeRequiredEnv({});
  assert.equal(result.ok, false);
  assert.match(result.message, /SUPABASE_URL/);
});

test("probeRequiredEnv passes when core vars set", () => {
  const result = probeRequiredEnv(baseEnv);
  assert.equal(result.ok, true);
});

test("probeOpenRouter surfaces 401 and 402", async () => {
  const unauthorized = await probeOpenRouter(
    mockDeps({
      fetch: async () => new Response("", { status: 401 }),
    }),
  );
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.message, /401/);

  const paymentRequired = await probeOpenRouter(
    mockDeps({
      fetch: async () => new Response("", { status: 402 }),
    }),
  );
  assert.equal(paymentRequired.ok, false);
  assert.match(paymentRequired.message, /402/);
});

test("probeOpenRouter passes on 200", async () => {
  const result = await probeOpenRouter(mockDeps());
  assert.equal(result.ok, true);
});

test("probeClaudeCode fails when CLI exits non-zero", async () => {
  const result = await probeClaudeCode(
    mockDeps({
      runCommand: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /not available/);
});

test("probeGit passes with version output", async () => {
  const result = await probeGit(
    mockDeps({
      runCommand: async () => ({
        exitCode: 0,
        stdout: "git version 2.43.0.windows.1",
        stderr: "",
      }),
    }),
  );
  assert.equal(result.ok, true);
});

test("probeWorktreeRoot fails when path unset", async () => {
  const result = await probeWorktreeRoot(
    mockDeps({
      env: { ...baseEnv, TASKGRAPH_WORKTREE_ROOT: "" },
    }),
  );
  assert.equal(result.ok, false);
});

test("probeGitHub uses token when gh auth fails", async () => {
  const calls: string[] = [];
  const result = await probeGitHub(
    mockDeps({
      env: { ...baseEnv, GITHUB_TOKEN: "ghp_test", GITHUB_CREATE_PR: "true" },
      runCommand: async (command, args) => {
        calls.push([command, ...args].join(" "));
        return { exitCode: 1, stdout: "", stderr: "not logged in" };
      },
      fetch: async (input) => {
        assert.match(String(input), /api\.github\.com\/user/);
        return new Response(JSON.stringify({ login: "tester" }), { status: 200 });
      },
    }),
  );
  assert.ok(result);
  assert.equal(result.ok, true);
  assert.match(calls[0] ?? "", /gh auth status/);
});

test("probeTelegram validates getMe", async () => {
  const bad = await probeTelegram(
    mockDeps({
      env: { ...baseEnv, TELEGRAM_BOT_TOKEN: "bad-token" },
      fetch: async () =>
        new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 200 }),
    }),
  );
  assert.ok(bad);
  assert.equal(bad.ok, false);

  const good = await probeTelegram(
    mockDeps({
      env: { ...baseEnv, TELEGRAM_BOT_TOKEN: "good-token" },
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
  );
  assert.ok(good);
  assert.equal(good.ok, true);
});

test("optional intake probes warn on missing chat id and webhook secret", () => {
  const chatId = probeTelegramChatId({ TELEGRAM_BOT_TOKEN: "token" });
  assert.ok(chatId);
  assert.equal(chatId.optional, true);
  assert.equal(chatId.ok, false);

  const webhook = probeGitHubWebhookSecret({ TELEGRAM_BOT_TOKEN: "token" });
  assert.ok(webhook);
  assert.equal(webhook.optional, true);
  assert.equal(webhook.ok, false);
});

test("evaluateProbeResults ignores optional failures unless strict", () => {
  const results = [
    { name: "core", ok: true, message: "ok", optional: false },
    { name: "optional", ok: false, message: "warn", optional: true },
  ];
  assert.equal(evaluateProbeResults(results, false), true);
  assert.equal(evaluateProbeResults(results, true), false);
});

test("probeSupabaseTasks and queues surface errors", async () => {
  const tasks = await probeSupabaseTasks(mockDb({ tasksError: "permission denied" }));
  assert.equal(tasks.ok, false);

  const queues = await probeSupabaseQueues(mockDb({ queueError: "missing rpc" }));
  assert.equal(queues.ok, false);
});

test("runHealthProbes stops before network probes when env missing", async () => {
  const summary = await runHealthProbes(mockDeps({ env: {} }));
  assert.equal(summary.ok, false);
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0]?.name, "env");
});

test("runHealthProbes aggregates required probes with mocked deps", async () => {
  const summary = await runHealthProbes(mockDeps(), { db: mockDb() });
  assert.equal(summary.ok, true);
  const names = summary.results.map((r) => r.name);
  assert.ok(names.includes("supabase_tasks"));
  assert.ok(names.includes("openrouter"));
  assert.ok(names.includes("claude_code"));
});
