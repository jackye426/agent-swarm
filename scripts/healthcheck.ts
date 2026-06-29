#!/usr/bin/env tsx

import { db } from "../src/db/client.js";
import { physicalQueueName } from "../src/core/queue-names.js";
import type { QueueJobType } from "../src/core/types.js";

const queues: QueueJobType[] = [
  "task.plan.requested",
  "task.design.requested",
  "task.execution.requested",
  "task.verification.requested",
  "task.release.requested",
  "task.rework.requested",
];

async function main(): Promise<void> {
  const requiredEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY"];
  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const { error: taskError } = await db.from("tasks").select("id").limit(1);
  if (taskError) throw new Error(`Cannot read tasks table: ${taskError.message}`);

  for (const queue of queues) {
    const physical = physicalQueueName(queue);
    const { error } = await db.rpc("pgmq_metrics", { queue_name: physical });
    if (error) {
      throw new Error(`Queue ${physical} is not available: ${error.message}`);
    }
  }

  console.log("TaskGraph OS healthcheck passed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
