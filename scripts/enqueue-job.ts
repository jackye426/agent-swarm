#!/usr/bin/env tsx

import fs from "node:fs";
import { z } from "zod";
import { enqueue } from "../src/db/queue.js";
import type { QueueJobType } from "../src/core/types.js";

const ArgsSchema = z.object({
  queue: z.enum([
    "task.plan.requested",
    "task.contract_revision.requested",
    "task.design.requested",
    "task.execution.requested",
    "task.verification.requested",
    "task.release.requested",
    "task.rework.requested",
  ]),
  payloadPath: z.string().min(1),
});

function parseArgs(): z.infer<typeof ArgsSchema> {
  const [, , queue, payloadPath] = process.argv;
  const result = ArgsSchema.safeParse({ queue, payloadPath });
  if (!result.success) {
    console.error("Usage: npm run enqueue -- <queue-name> <payload.json>");
    console.error("Example: npm run enqueue -- task.plan.requested ./payload.json");
    process.exit(1);
  }
  return result.data;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const payload = JSON.parse(fs.readFileSync(args.payloadPath, "utf8")) as Record<string, unknown>;
  const taskId = z.string().regex(/^T-\d+$/).parse(payload.task_id);

  await enqueue({
    job_type: args.queue as QueueJobType,
    task_id: taskId,
    payload,
  });

  console.log(`Enqueued ${args.queue} for ${taskId}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
