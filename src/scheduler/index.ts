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
  ContractRevisionRequestedPayloadSchema,
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
  getLatestVerificationRecord,
  listEvidenceRecords,
} from "../db/records.js";
import { ReworkRequestedPayloadSchema } from "../core/queue-schemas.js";
import { getTaskStatus, transitionTaskStatus } from "../db/tasks.js";
import { canTransition } from "../core/state-machine.js";
import {
  formatContextForEngineering,
  resolveTestCommandsFromPacket,
} from "../core/contract-executability.js";
import { formatReworkContextForEngineering } from "../core/rework-context.js";
import { getPlanningWorkflow, reviseContractFromVerification } from "../cells/planning/workflow.js";
import { engineeringWorkflow } from "../cells/engineering/workflow.js";
import { verificationWorkflow } from "../cells/verification/workflow.js";
import {
  autoEnqueueVerificationIfEnabled,
  enqueueVerificationForTask,
} from "../../scripts/lib/verification-enqueue.js";
import {
  isStaleContractRevisionJob,
  isStaleExecutionJob,
  isStalePlanningJob,
  isStaleReworkJob,
  isStaleVerificationJob,
} from "./guards.js";
import { WORKER_TYPE_BY_QUEUE } from "../core/worker-types.js";

const QUEUES: QueueJobType[] = [
  "task.plan.requested",
  "task.contract_revision.requested",
  "task.execution.requested",
  "task.verification.requested",
  "task.rework.requested",
];

const POLL_INTERVAL_MS = Number(process.env.SCHEDULER_POLL_INTERVAL_MS ?? 5_000);
const VISIBILITY_TIMEOUT_S = Number(process.env.SCHEDULER_VISIBILITY_TIMEOUT_S ?? 120);

function queueCell(queueName: QueueJobType): CellType {
  switch (queueName) {
    case "task.plan.requested": return "planning";
    case "task.contract_revision.requested": return "planning";
    case "task.execution.requested": return "engineering";
    case "task.verification.requested": return "verification";
    case "task.design.requested": return "design";
    case "task.release.requested": return "release";
    case "task.rework.requested": return "engineering";
  }
}

function queueWorkerType(queueName: QueueJobType): string {
  return WORKER_TYPE_BY_QUEUE[queueName];
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

async function preflightJob(queueName: QueueJobType, payload: Record<string, unknown>): Promise<JobResult> {
  switch (queueName) {
    case "task.plan.requested": {
      const parsed = PlanRequestedPayloadSchema.parse(payload);
      const status = await getTaskStatus(parsed.task_id);
      if (isStalePlanningJob(status)) {
        console.log(`[Scheduler] Stale planning job for ${parsed.task_id} (status=${status}) — acking`);
        return "ack_stale";
      }
      return;
    }

    case "task.contract_revision.requested": {
      const parsed = ContractRevisionRequestedPayloadSchema.parse(payload);
      const status = await getTaskStatus(parsed.task_id);
      if (isStaleContractRevisionJob(status)) {
        console.log(
          `[Scheduler] Stale contract revision job for ${parsed.task_id} ` +
            `(status=${status}, expected BLOCKED) — acking`,
        );
        return "ack_stale";
      }
      return;
    }

    case "task.execution.requested": {
      const parsed = ExecutionRequestedPayloadSchema.parse(payload);
      const status = await getTaskStatus(parsed.task_id);
      if (isStaleExecutionJob(status)) {
        console.log(`[Scheduler] Stale execution job for ${parsed.task_id} (status=${status}, expected READY) — acking`);
        return "ack_stale";
      }
      if (!(await dependenciesComplete(parsed.task_id))) {
        console.log(`[Scheduler] ${parsed.task_id} has incomplete dependencies — skipping, will retry`);
        return "skip";
      }
      return;
    }

    case "task.rework.requested": {
      const parsed = ReworkRequestedPayloadSchema.parse(payload);
      const status = await getTaskStatus(parsed.task_id);
      if (isStaleReworkJob(status)) {
        console.log(
          `[Scheduler] Stale rework job for ${parsed.task_id} (status=${status}, expected REWORK_REQUIRED) — acking`,
        );
        return "ack_stale";
      }
      if (!(await dependenciesComplete(parsed.task_id))) {
        console.log(`[Scheduler] ${parsed.task_id} rework has incomplete dependencies — skipping`);
        return "skip";
      }
      return;
    }

    case "task.verification.requested": {
      const parsed = VerificationRequestedPayloadSchema.parse(payload);
      const status = await getTaskStatus(parsed.task_id);
      if (isStaleVerificationJob(status)) {
        console.log(`[Scheduler] Stale verification job for ${parsed.task_id} (status=${status}) — acking`);
        return "ack_stale";
      }
      return;
    }

    default:
      return;
  }
}

async function processJob(queueName: QueueJobType, payload: Record<string, unknown>, agentRunId: string): Promise<JobResult> {
  console.log(`[Scheduler] Processing ${queueName} for task ${payload.task_id}`);

  switch (queueName) {
    case "task.plan.requested": {
      const parsed = PlanRequestedPayloadSchema.parse(payload);
      const planStatus = await getTaskStatus(parsed.task_id);
      if (isStalePlanningJob(planStatus)) {
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

    case "task.contract_revision.requested": {
      const parsed = ContractRevisionRequestedPayloadSchema.parse(payload);
      const revisionStatus = await getTaskStatus(parsed.task_id);
      if (isStaleContractRevisionJob(revisionStatus)) {
        console.log(
          `[Scheduler] Stale contract revision job for ${parsed.task_id} ` +
            `(status=${revisionStatus}, expected BLOCKED) — acking`,
        );
        return "ack_stale";
      }

      const result = await reviseContractFromVerification({
        taskId: parsed.task_id,
        agentRunId,
        failedAcIds: parsed.failed_ac_ids,
        failureSummary: parsed.failure_summary,
        recommendedNextStep: parsed.recommended_next_step,
        questionForUser: parsed.question_for_user,
        verifierReason: parsed.verifier_reason,
      });
      if (result.error) throw new Error(`Contract revision workflow error: ${result.error}`);
      break;
    }

    case "task.execution.requested": {
      const parsed = ExecutionRequestedPayloadSchema.parse(payload);
      const execStatus = await getTaskStatus(parsed.task_id);
      if (isStaleExecutionJob(execStatus)) {
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
        preserveWorktreeBase: false,
      });
      if (engResult.error) throw new Error(`Engineering workflow error: ${engResult.error}`);

      const postExecStatus = await getTaskStatus(parsed.task_id);
      if (postExecStatus === "AWAITING_EVIDENCE") {
        await autoEnqueueVerificationIfEnabled(parsed.task_id);
      }
      break;
    }

    case "task.rework.requested": {
      const parsed = ReworkRequestedPayloadSchema.parse(payload);
      const reworkStatus = await getTaskStatus(parsed.task_id);
      if (isStaleReworkJob(reworkStatus)) {
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

      const latestVerification = await getLatestVerificationRecord(parsed.task_id);
      const reworkContext = formatReworkContextForEngineering({
        contract: reworkContract,
        baseContext: formatContextForEngineering(existingPacket),
        reworkAttempt: parsed.rework_attempt,
        blockingDefects: parsed.blocking_defects,
        missingEvidence: parsed.missing_evidence,
        verdict: latestVerification?.verdict,
        criterionVerdicts: latestVerification?.criterionVerdicts,
      });

      const reworkResult = await engineeringWorkflow.invoke({
        taskId: parsed.task_id,
        agentRunId,
        contextPacketId: reworkContextPacketId,
        contract: reworkContract,
        contextPacket: reworkContext,
        testCommands: reworkTestCommands,
        preserveWorktreeBase: true,
      });
      if (reworkResult.error) throw new Error(`Rework workflow error: ${reworkResult.error}`);

      const postReworkStatus = await getTaskStatus(parsed.task_id);
      if (postReworkStatus === "AWAITING_EVIDENCE") {
        await enqueueVerificationForTask(parsed.task_id);
        console.log(`[Scheduler] Auto-enqueued verification after rework for ${parsed.task_id}`);
      }
      break;
    }

    case "task.verification.requested": {
      const parsed = VerificationRequestedPayloadSchema.parse(payload);
      const verifyStatus = await getTaskStatus(parsed.task_id);
      if (isStaleVerificationJob(verifyStatus)) {
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
      const preflight = await preflightJob(queue, payload);
      if (preflight === "skip") {
        continue;
      }
      if (preflight === "ack_stale") {
        await ack(queue, msg.msg_id);
        continue;
      }

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

// Graceful shutdown: on SIGINT/SIGTERM finish the in-flight poll (durable
// writes complete, message gets acked), then stop. A crash mid-job is still
// safe — the unacked message reappears after the pgmq visibility timeout.
let shuttingDown = false;

function requestShutdown(signal: string): void {
  if (shuttingDown) {
    console.log(`[Scheduler] ${signal} received again — forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[Scheduler] ${signal} received — finishing in-flight job, then stopping`);
}

async function runWorker(workerId: number): Promise<void> {
  console.log(`[Scheduler] Worker ${workerId} started`);
  while (!shuttingDown) {
    await poll();
    if (shuttingDown) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log(`[Scheduler] Worker ${workerId} stopped`);
}

export async function run(): Promise<void> {
  console.log(`[Scheduler] Starting TaskGraph OS scheduler (${WORKER_COUNT} worker(s))`);
  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));
  // Each worker independently dequeues from all queues. pgmq visibility timeout
  // ensures a message is only processed by one worker at a time.
  await Promise.all(
    Array.from({ length: WORKER_COUNT }, (_, i) => runWorker(i + 1)),
  );
  console.log("[Scheduler] Shutdown complete");
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
