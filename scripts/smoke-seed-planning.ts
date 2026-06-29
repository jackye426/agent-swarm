#!/usr/bin/env tsx

import { db } from "../src/db/client.js";
import { enqueue } from "../src/db/queue.js";

const taskId = process.argv[2] ?? "T-002";

const goal = "Draft an evidence-gated task contract for adding a README section that explains local setup for TaskGraph OS.";

const context = [
  "The repository is a TypeScript Node project.",
  "It uses Supabase Postgres as durable work state.",
  "It uses Supabase Queues / pgmq for dispatch.",
  "It uses OpenRouter role-based model routing.",
  "It uses LangGraph cell workflows.",
  "Task contracts and evidence live under tasks/T-###.",
  "This is a smoke test: stop after draft contract and await human approval.",
].join("\n");

async function main(): Promise<void> {
  const { error: taskError } = await db.from("tasks").upsert({
    id: taskId,
    title: "Smoke test planning task",
    status: "DRAFT",
    cell: "planning",
    contract_version: 0,
  });

  if (taskError) throw new Error(`Failed to seed task ${taskId}: ${taskError.message}`);

  await enqueue({
    job_type: "task.plan.requested",
    task_id: taskId,
    payload: {
      task_id: taskId,
      goal,
      context,
      stop_after_draft: true,
    },
  });

  console.log(`Seeded and enqueued planning smoke test for ${taskId}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
