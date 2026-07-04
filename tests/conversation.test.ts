import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  appendProjectNote,
  buildSystemPrompt,
  formatRepoSnapshot,
  parseConversationAction,
} from "../src/intake/conversation.js";
import type { SeedRepoContext } from "../src/intake/repo-scanner.js";

test("parseConversationAction accepts a reply action", () => {
  const action = parseConversationAction(
    JSON.stringify({ action: "reply", message: "Which project is this for?" }),
  );
  assert.deepEqual(action, { action: "reply", message: "Which project is this for?" });
});

test("parseConversationAction carries a valid declared repo on reply", () => {
  const action = parseConversationAction(
    JSON.stringify({ action: "reply", message: "Got it.", repo: "jackye426/swarm-sandbox" }),
  );
  assert.deepEqual(action, {
    action: "reply",
    message: "Got it.",
    repo: "jackye426/swarm-sandbox",
  });
});

test("parseConversationAction drops an invalid declared repo but keeps the reply", () => {
  const action = parseConversationAction(
    JSON.stringify({ action: "reply", message: "Got it.", repo: "not a repo!!" }),
  );
  assert.deepEqual(action, { action: "reply", message: "Got it." });
});

test("parseConversationAction accepts create_tasks with requirements_summary and chain", () => {
  const action = parseConversationAction(
    JSON.stringify({
      action: "create_tasks",
      repo: "jackye426/swarm-sandbox",
      requirements_summary: "Dashboard shows healthcheck results; no new dependencies.",
      message: "Queued!",
      tasks: [
        { goal: "Add config module", context: "npm test must pass" },
        { goal: "Add config validation", depends_on_previous: true },
      ],
    }),
  );
  assert.ok(action && action.action === "create_tasks");
  assert.equal(action.repo, "jackye426/swarm-sandbox");
  assert.match(action.requirements_summary, /no new dependencies/);
  assert.equal(action.tasks.length, 2);
  assert.equal(action.tasks[0]!.depends_on_previous, false);
  assert.equal(action.tasks[1]!.depends_on_previous, true);
});

test("parseConversationAction rejects create_tasks without requirements_summary", () => {
  assert.equal(
    parseConversationAction(
      JSON.stringify({
        action: "create_tasks",
        repo: "a/b",
        tasks: [{ goal: "do something" }],
      }),
    ),
    null,
  );
});

test("parseConversationAction handles markdown-fenced JSON", () => {
  const action = parseConversationAction(
    '```json\n{"action":"reply","message":"hi"}\n```',
  );
  assert.deepEqual(action, { action: "reply", message: "hi" });
});

test("parseConversationAction rejects malformed shapes", () => {
  assert.equal(parseConversationAction("just some prose, not JSON"), null);
  assert.equal(parseConversationAction('{"action":"reply"}'), null); // no message
  assert.equal(
    parseConversationAction(
      '{"action":"create_tasks","repo":"a/b","requirements_summary":"x","tasks":[]}',
    ),
    null, // empty task list
  );
  assert.equal(
    parseConversationAction(
      '{"action":"create_tasks","repo":"a/b","requirements_summary":"x","tasks":[{"context":"no goal"}]}',
    ),
    null, // task without goal
  );
});

const seed: SeedRepoContext = {
  repo_full_name: "jackye426/swarm-sandbox",
  scanned_at: "2026-07-04T00:00:00Z",
  scan_root: "/tmp/x",
  file_tree: "scripts/\n  healthcheck.js\npackage.json\nREADME.md",
  readme_excerpt: "# Sandbox\nA test repo.",
  package_manifest: { name: "sandbox" },
  package_manifest_path: "package.json",
  test_commands: ["npm test"],
  recent_commits: ["c0725eb feat: healthcheck", "a11ce00 init"],
};

test("formatRepoSnapshot includes tests, commits, readme, and tree", () => {
  const snapshot = formatRepoSnapshot(seed);
  assert.match(snapshot, /jackye426\/swarm-sandbox/);
  assert.match(snapshot, /Test commands: npm test/);
  assert.match(snapshot, /c0725eb/);
  assert.match(snapshot, /# Sandbox/);
  assert.match(snapshot, /healthcheck\.js/);
});

test("formatRepoSnapshot respects the overall cap", () => {
  const big = { ...seed, file_tree: "x".repeat(10_000), readme_excerpt: "y".repeat(10_000) };
  const snapshot = formatRepoSnapshot(big, 2_500);
  assert.ok(snapshot.length <= 2_500 + 20); // + truncation marker
});

test("buildSystemPrompt embeds snapshot and notes when present", () => {
  const prompt = buildSystemPrompt({
    repos: ["jackye426/swarm-sandbox"],
    chatDefault: "jackye426/swarm-sandbox",
    repoSnapshot: "Current repo snapshot: jackye426/swarm-sandbox",
    notes: "[2026-07-04] built the dashboard",
  });
  assert.match(prompt, /Current repo snapshot/);
  assert.match(prompt, /built the dashboard/);
  assert.match(prompt, /READINESS CHECKLIST/);
  assert.match(prompt, /requirements_summary is REQUIRED/);
});

test("buildSystemPrompt embeds existing work summary when provided", () => {
  const prompt = buildSystemPrompt({
    repos: ["jackye426/swarm-sandbox"],
    chatDefault: "jackye426/swarm-sandbox",
    workSummary: "T-012 [COMPLETE] jackye426/swarm-sandbox — Dark-Themed To-Do List Frontend",
    repoSnapshot: null,
    notes: null,
  });

  assert.match(prompt, /EXISTING AND IN-FLIGHT WORK/);
  assert.match(prompt, /T-012 \[COMPLETE\]/);
  assert.match(prompt, /project EXISTS/);
});

test("buildSystemPrompt omits existing work summary when empty", () => {
  const prompt = buildSystemPrompt({
    repos: [],
    chatDefault: null,
    workSummary: "",
    repoSnapshot: null,
    notes: null,
  });

  assert.doesNotMatch(prompt, /EXISTING AND IN-FLIGHT WORK/);
});

test("appendProjectNote keeps the most recent tail under the cap", () => {
  const notes = appendProjectNote("a".repeat(3_990), "[2026-07-04] new entry");
  assert.ok(notes.length <= 4_000);
  assert.match(notes, /new entry$/);
});
