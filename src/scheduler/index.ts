/**
 * TaskGraph OS Scheduler
 *
 * Supabase Queues dispatch one durable top-level job. LangGraph handles the
 * internal cell workflow. Supabase remains the source of truth for runs,
 * artifacts, evidence, verification, and task state.
 */

import { z } from "zod";
import { dequeue, ack } from "../db/queue.js";
import type { CellType, QueueJobType } from "../core/types.js";
import {
  ExecutionRequestedPayloadSchema,
  PlanRequestedPayloadSchema,
  VerificationRequestedPayloadSchema,
} from "../core/queue-schemas.js";
import {
  completeAgentRun,
  createAgentRun,
  createContextPacket,
  dependenciesComplete,
  failAgentRun,
  getLatestContextPacket,
  getLatestContract,
  listEvidenceRecords,
} from "../db/records.js";
import { ReworkRequestedPayloadSchema } from "../core/queue-schemas.js";
import { getTaskStatus, transitionTaskStatus } from "../db/tasks.js";
import { canTransition } from "../core/state-machine.js";
import {
  formatContextForEngineering,
  resolveTestCommandsFromPacket,
} from "../core/contract-executability.js";
import { getPlanningWorkflow } from "../cells/planning/workflow.js";
import { engineeringWorkflow } from "../cells/engineering/workflow.js";
import { verificationWorkflow } from "../cells/verification/workflow.js";

const QUEUES: QueueJobType[] = [
  "task.plan.requested",
  "task.execution.requested",
  "task.verification.requested",
  "task.rework.requested",
];

const POLL_INTERVAL_MS = Number(process.env.SCHEDULER_POLL_INTERVAL_MS ?? 5_000);
const VISIBILITY_TIMEOUT_S = Number(process.env.SCHEDULER_VISIBILITY_TIMEOUT_S ?? 120);

function queueCell(queueName: QueueJobType): CellType {
  switch (queueName) {
    case "task.plan.requested": return "planning";
    case "task.execution.requested": return "engineering";
    case "task.verification.requested": return "verification";
    case "task.design.requested": return "design";
    case "task.release.requested": return "release";
    case "task.rework.requested": return "engineering";
  }
}

function queueWorkerType(queueName: QueueJobType): string {
  switch (queueName) {
    case "task.plan.requested": return "planning-cell";
    case "task.execution.requested": return "engineering-cell";
    case "task.verification.requested": return "verification-cell";
    case "task.design.requested": return "design-cell";
    case "task.release.requested": return "release-cell";
    case "task.rework.requested": return "rework-cell";
  }
}

async function transitionIfLegal(taskId: string, to: Parameters<typeof transitionTaskStatus>[0]["to"]): Promise<void> {
  const from = await getTaskStatus(taskId);
  if (!canTransition(from, to)) return;
  await transitionTaskStatus({
    taskId,
    to,
    actor: "scheduler",
    payload: { reason: "queue dispatch" },
  });
}

type JobResult = "skip" | "ack_stale" | void;

async function processJob(queueName: QueueJobType, payload: Record<string, unknown>, agentRunId: string): Promise<JobResult> {
  console.log(`[Scheduler] Processing ${queueName} for task ${payload.task_id}`);

  switch (queueName) {
    case "task.plan.requested": {
      const parsed = PlanRequestedPayloadSchema.parse(payload);
      const planStatus = await getTaskStatus(parsed.task_id);
      if (planStatus !== "DRAFT" && planStatus !== "PLANNING") {
        console.log(
          `[Scheduler] Stale planning job for ${parsed.task_id} (status=${planStatus}) — acking`,
        );
        return "ack_stale";
      }

      await transitionIfLegal(parsed.task_id, "PLANNING");

      const planningWorkflow = await getPlanningWorkflow();
      // thread_id = agentRunId ties this invoke to a durable checkpoint slot.
      // If the process crashes mid-run, re-invoking with the same thread_id
      // resumes from the last completed node rather than restarting from scratch.
      const planResult = await planningWorkflow.invoke(
        {
          taskId: parsed.task_id,
          agentRunId,
          goal: parsed.goal,
          context: parsed.context,
          stopAfterDraft: parsed.stop_after_draft,
        },
        { configurable: { thread_id: agentRunId } },
      );

      if (planResult.error) throw new Error(`Planning workflow error: ${planResult.error}`);
      break;
    }

    case "task.execution.requested": {
      const parsed = ExecutionRequestedPayloadSchema.parse(payload);
      const execStatus = await getTaskStatus(parsed.task_id);
      if (execStatus !== "READY") {
        console.log(
          `[Scheduler] Stale execution job for ${parsed.task_id} (status=${execStatus}, expected READY) — acking`,
        );
        return "ack_stale";
      }

      // Do not proceed if dependencies aren't complete — leave message in queue
      // to be retried after the visibility timeout.
      if (!(await dependenciesComplete(parsed.task_id))) {
        console.log(`[Scheduler] ${parsed.task_id} has incomplete dependencies — skipping, will retry`);
        return "skip";
      }

      await transitionIfLegal(parsed.task_id, "IN_PROGRESS");

      const contract = await getLatestContract(parsed.task_id);
      const packetContent = parsed.context ?? await getLatestContextPacket(parsed.task_id) ?? {};
      const resolvedTestCommands = resolveTestCommandsFromPacket(
        packetContent,
        parsed.test_commands,
      );
      const contextPacketId = await createContextPacket(parsed.task_id, {
        ...packetContent,
        test_commands: resolvedTestCommands,
      });

      const engResult = await engineeringWorkflow.invoke({
        taskId: parsed.task_id,
        agentRunId,
        contextPacketId,
        contract,
        contextPacket: formatContextForEngineering(packetContent),
        testCommands: resolvedTestCommands,
      });
      if (engResult.error) throw new Error(`Engineering workflow error: ${engResult.error}`);
      break;
    }

    case "task.rework.requested": {
      const parsed = ReworkRequestedPayloadSchema.parse(payload);
      const reworkStatus = await getTaskStatus(parsed.task_id);
      if (reworkStatus !== "REWORK_REQUIRED") {
        console.log(
          `[Scheduler] Stale rework job for ${parsed.task_id} (status=${reworkStatus}, expected REWORK_REQUIRED) — acking`,
        );
        return "ack_stale";
      }

      if (!(await dependenciesComplete(parsed.task_id))) {
        console.log(`[Scheduler] ${parsed.task_id} rework has incomplete dependencies — skipping`);
        return "skip";
      }

      await transitionIfLegal(parsed.task_id, "IN_PROGRESS");

      const reworkContract = await getLatestContract(parsed.task_id);
      const existingPacket = await getLatestContextPacket(parsed.task_id) ?? {};
      const reworkTestCommands = resolveTestCommandsFromPacket(existingPacket);
      const reworkContextPacketId = await createContextPacket(parsed.task_id, {
        ...existingPacket,
        rework_attempt: parsed.rework_attempt,
        blocking_defects: parsed.blocking_defects,
        missing_evidence: parsed.missing_evidence,
      });

      // Inject defect context so the engineering cell knows what to fix.
      const defectContext =
        parsed.blocking_defects.length > 0
          ? `\n\nRework attempt ${parsed.rework_attempt}. Fix these defects from the last verification:\n` +
            parsed.blocking_defects.map((d) => `- ${d}`).join("\n") +
            (parsed.missing_evidence.length > 0
              ? `\n\nMissing evidence:\n${parsed.missing_evidence.map((e) => `- ${e}`).join("\n")}`
              : "")
          : "";

      const reworkResult = await engineeringWorkflow.invoke({
        taskId: parsed.task_id,
        agentRunId,
        contextPacketId: reworkContextPacketId,
        contract: reworkContract,
        contextPacket: formatContextForEngineering(existingPacket) + defectContext,
        testCommands: reworkTestCommands,
      });
      if (reworkResult.error) throw new Error(`Rework workflow error: ${reworkResult.error}`);
      break;
    }

    case "task.verification.requested": {
      const parsed = VerificationRequestedPayloadSchema.parse(payload);
      const verifyStatus = await getTaskStatus(parsed.task_id);
      if (verifyStatus !== "AWAITING_EVIDENCE" && verifyStatus !== "VERIFYING") {
        console.log(
          `[Scheduler] Stale verification job for ${parsed.task_id} (status=${verifyStatus}) — acking`,
        );
        return "ack_stale";
      }

      await transitionIfLegal(parsed.task_id, "VERIFYING");

      const contract = await getLatestContract(parsed.task_id);
      const evidenceRecords = await listEvidenceRecords(parsed.task_id);

      const verResult = await verificationWorkflow.invoke({
        taskId: parsed.task_id,
        agentRunId,
        contract,
        prDiff: parsed.pr_diff,
        ciOutput: parsed.ci_output,
        evidenceRecords,
      });
      if (verResult.error) throw new Error(`Verification workflow error: ${verResult.error}`);
      break;
    }

    default:
      throw new Error(`No scheduler handler for queue ${queueName}`);
  }
}

export async function poll(): Promise<void> {
  for (const queue of QUEUES) {
    try {
      const msg = await dequeue(queue, VISIBILITY_TIMEOUT_S);
      if (!msg) continue;

      const payload = msg.message;
      const taskId = z.string().regex(/^T-\d+$/).parse(payload.task_id);
      const run = await createAgentRun({
        taskId,
        cell: queueCell(queue),
        workerType: queueWorkerType(queue),
      });

      try {
        const result = await processJob(queue, payload, run.id);
        if (result === "skip") {
          // Dependencies not met — leave message in queue; it becomes visible
          // again after the visibility timeout for automatic retry.
          await failAgentRun(run.id, "skipped: dependencies not complete");
        } else if (result === "ack_stale") {
          await completeAgentRun(run.id);
          await ack(queue, msg.msg_id);
        } else {
          await completeAgentRun(run.id);
          await ack(queue, msg.msg_id);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[Scheduler] Job failed for ${taskId}:`, err);
        await failAgentRun(run.id, reason);
        // Message becomes visible again after the visibility timeout for retry.
      }
    } catch (err) {
      console.error(`[Scheduler] Queue poll error on ${queue}:`, err);
    }
  }
}

const WORKER_COUNT = Number(process.env.SCHEDULER_WORKERS ?? 1);

async function runWorker(workerId: number): Promise<void> {
  console.log(`[Scheduler] Worker ${workerId} started`);
  while (true) {
    await poll();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

export async function run(): Promise<void> {
  console.log(`[Scheduler] Starting TaskGraph OS scheduler (${WORKER_COUNT} worker(s))`);
  // Each worker independently dequeues from all queues. pgmq visibility timeout
  // ensures a message is only processed by one worker at a time.
  await Promise.all(
    Array.from({ length: WORKER_COUNT }, (_, i) => runWorker(i + 1)),
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--once")) {
    await poll();
    return;
  }
  await run();
}

main().catch((err) => {
  console.error("[Scheduler] Fatal error:", err);
  process.exit(1);
});
