#!/usr/bin/env tsx

import { db } from "../src/db/client.js";
import { enqueue } from "../src/db/queue.js";
import { createContextPacket, recordArtifact } from "../src/db/records.js";
import { resolveRepoForManual } from "../src/intake/repo-resolver.js";
import {
  formatSeedContextForPlanning,
  scanRepoSeedContext,
} from "../src/intake/repo-scanner.js";

const taskId = process.argv[2] ?? "T-002";
const stopAfterDraft = process.argv.includes("--stop-after-draft");

const repoFlag = (() => {
  const idx = process.argv.indexOf("--repo");
  return idx >= 0 ? process.argv[idx + 1] ?? null : null;
})();

function argValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? null : null;
}

const goal =
  argValue("--goal") ??
  "Draft an evidence-gated task contract for adding a README section that explains local setup for TaskGraph OS.";

const userContext =
  argValue("--context") ??
  [
    "The repository is a TypeScript Node project.",
    "It uses Supabase Postgres as durable work state.",
    "It uses Supabase Queues / pgmq for dispatch.",
    "It uses OpenRouter role-based model routing.",
    "It uses LangGraph cell workflows.",
    "Task contracts and evidence live under tasks/T-###.",
  ].join("\n");

async function main(): Promise<void> {
  const repo = await resolveRepoForManual({ repoFlag });

  const seed = await scanRepoSeedContext(repo.repoFullName);
  const context = formatSeedContextForPlanning(seed, userContext);

  const { error: taskError } = await db.from("tasks").upsert({
    id: taskId,
    title: goal.slice(0, 120),
    status: "DRAFT",
    cell: "planning",
    contract_version: 0,
    repo_url: repo.repoUrl,
    repo_full_name: repo.repoFullName,
    source: "manual",
    source_context: { repo_resolution: repo.resolutionSource },
  });

  if (taskError) throw new Error(`Failed to seed task ${taskId}: ${taskError.message}`);

  await recordArtifact({
    taskId,
    artifactType: "seed_repo_context",
    content: seed,
  });

  const contextPacketId = await createContextPacket(taskId, {
    kind: "seed_repo_context",
    repo_full_name: repo.repoFullName,
    user_context: userContext,
    planning_context: context,
    seed,
  });

  await db
    .from("tasks")
    .update({
      source_context: {
        repo_resolution: repo.resolutionSource,
        context_packet_id: contextPacketId,
      },
    })
    .eq("id", taskId);

  await enqueue({
    job_type: "task.plan.requested",
    task_id: taskId,
    payload: {
      task_id: taskId,
      goal,
      context,
      repo_full_name: repo.repoFullName,
      repo_url: repo.repoUrl,
      stop_after_draft: stopAfterDraft,
    },
  });

  console.log(
    `Seeded and enqueued planning smoke test for ${taskId} ` +
      `(repo: ${repo.repoFullName}, resolution: ${repo.resolutionSource})` +
      `${stopAfterDraft ? " (stop after draft)" : " (full pipeline with auto-approve)"}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
