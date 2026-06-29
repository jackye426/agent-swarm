#!/usr/bin/env tsx
/**
 * Promotes a task from AWAITING_APPROVAL → READY and enqueues task.execution.requested.
 *
 * Prerequisites:
 *   - Task must be at AWAITING_APPROVAL with a draft_contract artifact
 *     (run: npm run smoke:seed -- T-002 && npm run scheduler:once first)
 *   - This project directory must be a git repository
 *     (run: git init && git add -A && git commit -m "init" if not already)
 *   - TASKGRAPH_WORKTREE_ROOT must exist on disk (default: C:\tmp\taskgraph-os)
 *     (run: mkdir C:\tmp\taskgraph-os)
 */

import "dotenv/config";
import { db } from "../src/db/client.js";
import { enqueue } from "../src/db/queue.js";
import {
  createContextPacket,
  publishContractVersion,
  recordApproval,
} from "../src/db/records.js";
import { transitionTaskStatus } from "../src/db/tasks.js";
import type { TaskContract } from "../src/core/types.js";

const taskId = process.argv[2] ?? "T-002";

async function main(): Promise<void> {
  // 1. Check current task status
  const { data: task, error: taskError } = await db
    .from("tasks")
    .select("status")
    .eq("id", taskId)
    .single();

  if (taskError || !task) throw new Error(`Task ${taskId} not found`);
  const status = (task as { status: string }).status;
  if (status !== "AWAITING_APPROVAL") {
    throw new Error(
      `Task ${taskId} is at ${status}, expected AWAITING_APPROVAL.\n` +
      `Reset: npm run smoke:seed -- ${taskId} && npm run scheduler:once`
    );
  }

  // 2. Fetch the most recent draft_contract artifact
  const { data: artifact, error: artifactError } = await db
    .from("artifacts")
    .select("content")
    .eq("task_id", taskId)
    .eq("artifact_type", "draft_contract")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (artifactError || !artifact) {
    throw new Error(
      `No draft_contract artifact found for ${taskId}.\n` +
      `Run: npm run smoke:seed -- ${taskId} && npm run scheduler:once`
    );
  }

  const contract = (artifact as { content: TaskContract }).content;
  console.log(`Draft contract: "${contract.title}"`);
  console.log(`Approvals required: ${contract.approvals_required.join(", ")}`);

  // 3. Publish as a versioned contract
  console.log("\nPublishing contract version...");
  await publishContractVersion(taskId, contract);

  // 4. Record approvals for every required role
  for (const role of contract.approvals_required) {
    console.log(`  Recording ${role} approval...`);
    await recordApproval({
      taskId,
      approver: "smoke-test-human",
      role,
      notes: "Engineering cell smoke test — human approval simulated.",
    });
  }

  // 5. Create a context packet
  console.log("Creating context packet...");
  await createContextPacket(taskId, {
    goal: contract.goal,
    scope_in: contract.scope.in,
    constraints: contract.constraints,
    note: "Engineering cell smoke test. Claude Code will implement the accepted contract.",
  });

  // 6. Transition to READY
  console.log("Transitioning to READY...");
  await transitionTaskStatus({
    taskId,
    to: "READY",
    actor: "smoke-seed-engineering",
    payload: { note: "Promoted for engineering cell smoke test" },
    readiness: {
      contractValid: true,
      dependenciesComplete: true,
      approvalsComplete: true,
      contextPacketAvailable: true,
    },
  });

  // 7. Enqueue execution job
  console.log("Enqueueing task.execution.requested...");
  await enqueue({
    job_type: "task.execution.requested",
    task_id: taskId,
    payload: { task_id: taskId },
  });

  console.log(`\n✓ ${taskId} is READY. Engineering smoke test enqueued.`);
  console.log("\nChecklist before running the scheduler:");
  console.log("  □ git init && git add -A && git commit -m 'init'  (if not a git repo)");
  console.log("  □ mkdir C:\\tmp\\taskgraph-os                        (or set TASKGRAPH_WORKTREE_ROOT)");
  console.log("  □ GITHUB_CREATE_PR=false (default)                  (PR creation is deferred)");
  console.log("\nNext: npm run scheduler:once");
  console.log("Then: npm run smoke:inspect -- " + taskId);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
