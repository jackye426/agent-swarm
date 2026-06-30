#!/usr/bin/env tsx
/**
 * Seeds T-003 (Add GitHub Actions CI workflow) directly into READY state,
 * bypassing the planning cell. Use this when the contract is hand-crafted
 * and planning cell approval is not needed.
 *
 * What this does:
 *   1. Upsert T-003 into the tasks table at DRAFT
 *   2. Read tasks/T-003/contract.yaml and publish as contract version 1
 *   3. Record Product + Engineering approvals (simulated)
 *   4. Create a context packet describing the repo and the task
 *   5. Force status to READY via direct DB update (skips state machine)
 *   6. Enqueue task.execution.requested
 *
 * Prerequisites:
 *   - git repo with tasks/T-003/contract.yaml committed on main
 *   - TASKGRAPH_WORKTREE_ROOT must exist (default: C:\tmp\taskgraph-os)
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { db } from "../src/db/client.js";
import { enqueue } from "../src/db/queue.js";
import {
  createContextPacket,
  publishContractVersion,
  recordApproval,
} from "../src/db/records.js";
import type { TaskContract } from "../src/core/types.js";

const TASK_ID = "T-003";

async function main(): Promise<void> {
  // 1. Load contract from YAML on disk — the authoritative source for T-003
  const contractPath = path.resolve(`tasks/${TASK_ID}/contract.yaml`);
  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract not found at ${contractPath}. Run: git pull`);
  }
  const contract = yaml.load(fs.readFileSync(contractPath, "utf8")) as TaskContract;
  console.log(`Contract: "${contract.title}"`);
  console.log(`ACs: ${contract.acceptance_criteria.map((a) => a.id).join(", ")}`);

  // 2. Upsert task record at DRAFT (idempotent — safe to re-run)
  console.log("\nUpserting task...");
  const { error: upsertError } = await db.from("tasks").upsert({
    id: TASK_ID,
    title: contract.title,
    status: "DRAFT",
    cell: "engineering",
    contract_version: 0,
  });
  if (upsertError) throw new Error(`Failed to upsert task: ${upsertError.message}`);

  // 3. Publish contract version (auto-increments from latest)
  console.log("Publishing contract version...");
  const version = await publishContractVersion(TASK_ID, contract);
  console.log(`  → version ${version}`);

  // 4. Record approvals for all required roles
  for (const role of contract.approvals_required) {
    console.log(`  Recording ${role} approval...`);
    await recordApproval({
      taskId: TASK_ID,
      approver: "seed-t003-script",
      role,
      notes: "T-003 engineering smoke test — approval simulated by seed script.",
    });
  }

  // 5. Create context packet so the engineering cell has orientation
  console.log("Creating context packet...");
  await createContextPacket(TASK_ID, {
    goal: contract.goal,
    scope_in: contract.scope.in,
    scope_out: contract.scope.out,
    constraints: contract.constraints,
    repo_layout: {
      language: "TypeScript / Node.js 20",
      package_manager: "npm",
      test_command: "npm test",
      typecheck_command: "npm run typecheck",
      tasks_dir: "tasks/T-###/",
      evidence_dir: `tasks/${TASK_ID}/evidence/`,
    },
    note: [
      `This is a clean engineering smoke test for ${TASK_ID}.`,
      `Only .github/workflows/ci.yml should be created.`,
      `Place evidence files in tasks/${TASK_ID}/evidence/ as markdown.`,
      `Commit all changes at the end of the session.`,
    ].join(" "),
  });

  // 6. Force status to READY via direct DB update — skips state machine since
  //    we're bypassing planning. Same pattern as reset-task-engineering.ts.
  console.log("Setting status to READY...");
  const { error: updateError } = await db
    .from("tasks")
    .update({ status: "READY" })
    .eq("id", TASK_ID);
  if (updateError) throw new Error(`Failed to set READY: ${updateError.message}`);

  await db.from("task_events").insert({
    task_id: TASK_ID,
    event_type: "status_changed",
    from_status: "DRAFT",
    to_status: "READY",
    actor: "seed-t003-script",
    payload: {
      reason: "Hand-crafted contract; planning cell skipped for engineering smoke test.",
      contract_valid: true,
      dependencies_complete: true,
      approvals_complete: true,
      context_packet_available: true,
    },
  });

  // 7. Enqueue engineering job
  console.log("Enqueueing task.execution.requested...");
  await enqueue({
    job_type: "task.execution.requested",
    task_id: TASK_ID,
    payload: { task_id: TASK_ID },
  });

  console.log(`\n✓ ${TASK_ID} is READY and enqueued for engineering.`);
  console.log("Next: npm run scheduler:once");
  console.log("Then: npm run smoke:inspect -- " + TASK_ID);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
