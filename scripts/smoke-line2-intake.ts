#!/usr/bin/env tsx
/**
 * Line 2 intake path smoke — same createAndEnqueueTask call as Telegram /task
 * after /repo set. Requires scheduler running with auto-dispatch flags.
 *
 * Usage:
 *   npm run smoke:line2 -- "Add a one-line README note about the healthcheck self-test"
 *   npm run smoke:line2 -- "..." --repo jackye426/swarm-sandbox
 */

import "dotenv/config";
import { resolveRepoForIntake } from "../src/intake/repo-resolver.js";
import { createAndEnqueueTask } from "../src/intake/task-creator.js";
import { formatIntakeUserContext } from "../src/intake/intake-context.js";

const args = process.argv.slice(2);
const repoIdx = args.indexOf("--repo");
const repoFlag = repoIdx >= 0 ? args[repoIdx + 1] ?? null : null;
const goal = args
  .filter((_, i) => i !== repoIdx && i !== repoIdx + 1 && !args[i]?.startsWith("--"))
  .join(" ")
  .trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

if (!goal) {
  console.error('Usage: npm run smoke:line2 -- "<goal>" [--repo owner/name]');
  process.exit(1);
}

if (process.env.TASKGRAPH_AUTO_ENQUEUE_EXECUTION !== "true") {
  console.warn("[Line2] WARNING: TASKGRAPH_AUTO_ENQUEUE_EXECUTION is not true");
}
if (process.env.TASKGRAPH_AUTO_ENQUEUE_VERIFICATION !== "true") {
  console.warn("[Line2] WARNING: TASKGRAPH_AUTO_ENQUEUE_VERIFICATION is not true");
}

const repo = await resolveRepoForIntake({
  repoFlag,
  chatId: chatId ?? null,
});

const { taskId, repoFullName } = await createAndEnqueueTask({
  goal,
  context: formatIntakeUserContext("telegram"),
  sourceLabel: "telegram-smoke-line2",
  sourceKind: "telegram",
  repo,
  sourceContext: { telegram_chat_id: chatId, line2_smoke: true },
});

console.log(`Line 2 intake smoke: ${taskId} queued for ${repoFullName}`);
console.log(`Monitor: npm run watch:task -- ${taskId}`);
