import { StateGraph, Annotation } from "@langchain/langgraph";
import type {
  CriterionVerdict,
  EvidenceRecord,
  TaskContract,
  TaskVerdict,
  VerificationFailureOwner,
} from "../../core/types.js";
import {
  computeEffectiveMissingEvidence,
  deriveTaskVerdict,
  findMissingEvidence,
  routeVerdictByFailureOwner,
} from "../../core/verification.js";
import { classifyVerificationMethod } from "../../core/contract-executability.js";
import { integrateCompletedTaskBranch } from "../../core/branch-integration.js";
import { invokeRoleModel } from "../../core/model-router.js";
import { readKnowledgeExcerpt } from "../../core/knowledge-excerpt.js";
import { formatVerificationRequirementsSection } from "../../core/requirements.js";
import {
  dependenciesComplete,
  getDependentTaskIds,
  getLatestContract,
  getReworkAttemptCount,
  getTaskRequirementsSummary,
  recordArtifact,
  recordVerification,
  requiredApprovalsRecorded,
} from "../../db/records.js";
import { enqueue } from "../../db/queue.js";
import { getTaskStatus, transitionTaskStatus, transitionTaskStatusIfLegal } from "../../db/tasks.js";

const VerificationState = Annotation.Root({
  taskId: Annotation<string>(),
  agentRunId: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  contract: Annotation<TaskContract>(),
  prDiff: Annotation<string>(),
  ciOutput: Annotation<string>(),
  evidenceRecords: Annotation<EvidenceRecord[]>(),
  modelReview: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  criterionVerdicts: Annotation<Record<string, CriterionVerdict>>({ default: () => ({}), reducer: (_, v) => v }),
  blockingDefects: Annotation<string[]>({ default: () => [], reducer: (_, v) => v }),
  missingEvidence: Annotation<string[]>({ default: () => [], reducer: (_, v) => v }),
  regressionRisks: Annotation<string[]>({ default: () => [], reducer: (_, v) => v }),
  failureOwner: Annotation<VerificationFailureOwner | null>({ default: () => null, reducer: (_, v) => v }),
  failedAcIds: Annotation<string[]>({ default: () => [], reducer: (_, v) => v }),
  failureSummary: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  recommendedNextStep: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  questionForUser: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  verdict: Annotation<TaskVerdict | null>({ default: () => null, reducer: (_, v) => v }),
  error: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
});

type S = typeof VerificationState.State;

async function readContractAndEvidence(state: S): Promise<Partial<S>> {
  await recordArtifact({
    taskId: state.taskId,
    artifactType: "verification_input",
    content: {
      agent_run_id: state.agentRunId,
      pr_diff: state.prDiff,
      ci_output: state.ciOutput,
      evidence_count: state.evidenceRecords.length,
    },
  });
  return { missingEvidence: findMissingEvidence(state.contract, state.evidenceRecords) };
}

function parseReviewJson(content: string): {
  criterion_verdicts?: Record<string, CriterionVerdict>;
  blocking_defects?: string[];
  regression_risks?: string[];
  failure_owner?: VerificationFailureOwner;
  failed_ac_ids?: string[];
  failure_summary?: string;
  recommended_next_step?: string;
  question_for_user?: string;
} {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

async function runModelReview(state: S): Promise<Partial<S>> {
  const acList = state.contract.acceptance_criteria
    .map((ac) => {
      const kinds = ac.verification.map((v) => `${v} [${classifyVerificationMethod(v)}]`);
      return `${ac.id}: ${ac.requirement}\n  Verification: ${kinds.join(", ")}`;
    })
    .join("\n\n");

  const evidenceSummary = state.evidenceRecords
    .map((e) => `${e.evidence_id} [${e.status}] -> ${e.acceptance_criteria.join(", ")}: ${e.summary}`)
    .join("\n");

  const scopeIn = state.contract.scope.in.map((s) => `- ${s}`).join("\n");
  const scopeOut = state.contract.scope.out.map((s) => `- ${s}`).join("\n");
  const requirementsSummary = await getTaskRequirementsSummary(state.taskId);
  const requirementsSection = formatVerificationRequirementsSection(requirementsSummary);

  // Source: system-knowledge/concepts/evidence-and-verification.md#verifier-judging-rules (v1)
  const judgingRules = readKnowledgeExcerpt(
    "concepts/evidence-and-verification.md",
    "Verifier judging rules",
  );

  const content = await invokeRoleModel("verification", [
    {
      role: "system",
      content: `You are an independent code verifier. You did not implement this work.
Return only JSON with: {"criterion_verdicts":{"AC-1":"PASS"},"blocking_defects":[],"regression_risks":[],"failure_owner":"implementation","failed_ac_ids":["AC-1"],"failure_summary":"...","recommended_next_step":"...","question_for_user":"..."}.
Use PASS, FAIL, INCONCLUSIVE, or NOT_APPLICABLE for every acceptance criterion.
failure_owner must be one of: implementation, contract, human_decision, infrastructure, unknown.
Use implementation when code/tests should be reworked.
Use contract when the acceptance criterion, scope, or evidence requirement is contradictory, vague, or impossible to satisfy.
If an acceptance criterion conflicts with the product owner requirements, use failure_owner "contract" — do not classify it as implementation.
Use human_decision only when the product owner must choose behavior.
Use infrastructure for credentials, network, CI, dependency installation, or external service failures.
Use unknown when you cannot confidently classify the owner.

${judgingRules}`,
    },
    {
      role: "user",
      content: `Contract: ${state.contract.id} - ${state.contract.title}

Scope in:
${scopeIn || "(none)"}

Scope out:
${scopeOut || "(none)"}
${requirementsSection}

Acceptance criteria:
${acList}

Evidence records:
${evidenceSummary}

CI output:
${state.ciOutput}

PR diff:
${state.prDiff}`,
    },
  ], { temperature: 0, responseFormat: "json_object" });
  await recordArtifact({
    taskId: state.taskId,
    artifactType: "model_review",
    content: { agent_run_id: state.agentRunId, text: content },
  });

  try {
    const json = parseReviewJson(content);
    return {
      modelReview: content,
      criterionVerdicts: json.criterion_verdicts ?? {},
      blockingDefects: json.blocking_defects ?? [],
      regressionRisks: json.regression_risks ?? [],
      failureOwner: normalizeFailureOwner(json.failure_owner),
      failedAcIds: normalizeFailedAcIds(json.failed_ac_ids),
      failureSummary: json.failure_summary ?? null,
      recommendedNextStep: json.recommended_next_step ?? null,
      questionForUser: json.question_for_user ?? null,
    };
  } catch (err) {
    return {
      error: `Failed to parse model review JSON: ${(err as Error).message}`,
      modelReview: content,
      criterionVerdicts: Object.fromEntries(
        state.contract.acceptance_criteria.map((ac) => [ac.id, "INCONCLUSIVE" as CriterionVerdict])
      ),
      failureOwner: "unknown",
      failureSummary: "Verifier response could not be parsed.",
      recommendedNextStep: "Escalate to the coordinator for inspection.",
    };
  }
}

function normalizeFailureOwner(value: unknown): VerificationFailureOwner | null {
  return value === "implementation" ||
    value === "contract" ||
    value === "human_decision" ||
    value === "infrastructure" ||
    value === "unknown"
    ? value
    : null;
}

function normalizeFailedAcIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && /^AC-\d+$/.test(item));
}

async function mapEvidenceToCriteria(state: S): Promise<Partial<S>> {
  const verdicts: Record<string, CriterionVerdict> = { ...state.criterionVerdicts };

  for (const ac of state.contract.acceptance_criteria) {
    const relevantEvidence = state.evidenceRecords.filter((e) =>
      e.acceptance_criteria.includes(ac.id)
    );

    if (relevantEvidence.some((e) => e.status === "fail")) {
      verdicts[ac.id] = "FAIL";
      continue;
    }

    if (!verdicts[ac.id]) {
      verdicts[ac.id] = relevantEvidence.some((e) => e.status === "pass")
        ? "PASS"
        : "INCONCLUSIVE";
    }
  }

  return { criterionVerdicts: verdicts };
}

async function reconcileMissingEvidence(state: S): Promise<Partial<S>> {
  return {
    missingEvidence: computeEffectiveMissingEvidence(
      state.contract,
      state.evidenceRecords,
      state.criterionVerdicts,
    ),
  };
}

async function deriveVerdict(state: S): Promise<Partial<S>> {
  return {
    verdict: deriveTaskVerdict({
      criterionVerdicts: state.criterionVerdicts,
      missingEvidence: state.missingEvidence,
      blockingDefects: state.blockingDefects,
    }),
  };
}

function failedAcIdsFromVerdicts(verdicts: Record<string, CriterionVerdict>): string[] {
  return Object.entries(verdicts)
    .filter(([, verdict]) => verdict === "FAIL" || verdict === "INCONCLUSIVE")
    .map(([id]) => id);
}

function inferFailureOwner(state: S): VerificationFailureOwner {
  if (state.failureOwner) return state.failureOwner;
  if (state.blockingDefects.length > 0) return "implementation";
  // Missing evidence with no verifier classification: default to the rework
  // loop (pre-routing behavior). Routing it to "unknown" would park a
  // previously self-healing case as BLOCKED awaiting a human.
  if (state.missingEvidence.length > 0) return "implementation";
  const values = Object.values(state.criterionVerdicts);
  if (values.some((value) => value === "FAIL")) return "implementation";
  if (values.some((value) => value === "INCONCLUSIVE")) return "unknown";
  return "unknown";
}

/**
 * Promote dependents of a just-completed task. Tasks that hit the
 * waiting_on_dependency path were approved (contract published, approvals
 * recorded) but parked at AWAITING_APPROVAL with their queue message acked —
 * nothing retries them, so the completing task must wake them.
 */
async function wakeDependentTasks(completedTaskId: string, agentRunId: string | null): Promise<void> {
  let dependents: string[] = [];
  try {
    dependents = await getDependentTaskIds(completedTaskId);
  } catch (err) {
    console.warn(`[Verification Cell] Failed to load dependents of ${completedTaskId}:`, err);
    return;
  }

  for (const dependentId of dependents) {
    try {
      if ((await getTaskStatus(dependentId)) !== "AWAITING_APPROVAL") continue;
      if (!(await dependenciesComplete(dependentId))) continue;

      const contract = await getLatestContract(dependentId);
      await transitionTaskStatus({
        taskId: dependentId,
        to: "READY",
        actor: "verification-cell",
        payload: {
          reason: `dependency ${completedTaskId} completed`,
          agent_run_id: agentRunId,
        },
        readiness: {
          contractValid: true,
          dependenciesComplete: true,
          approvalsComplete: await requiredApprovalsRecorded(dependentId, contract.approvals_required),
          contextPacketAvailable: true,
        },
      });

      await recordArtifact({
        taskId: dependentId,
        artifactType: "human_notification",
        content: {
          type: "dependency_unblocked",
          task_id: dependentId,
          message:
            `${dependentId} was waiting on ${completedTaskId}, which is now COMPLETE. ` +
            `${dependentId} is READY and starting.`,
          notified_at: new Date().toISOString(),
        },
      });

      if (process.env.TASKGRAPH_AUTO_ENQUEUE_EXECUTION === "true") {
        await enqueue({
          job_type: "task.execution.requested",
          task_id: dependentId,
          payload: { task_id: dependentId },
        });
      }
      console.log(`[Verification Cell] Woke dependent ${dependentId} after ${completedTaskId} completed`);
    } catch (err) {
      // One bad dependent must not fail the completing task's verification.
      console.error(`[Verification Cell] Failed to wake dependent ${dependentId}:`, err);
    }
  }
}

async function publishVerificationRecord(state: S): Promise<Partial<S>> {
  if (!state.verdict) return { error: "Cannot publish verification without a verdict" };
  if (!state.agentRunId) return { error: "Cannot publish verification without an agent run id" };

  const failureOwner = inferFailureOwner(state);
  const failedAcIds = state.failedAcIds.length > 0
    ? state.failedAcIds
    : failedAcIdsFromVerdicts(state.criterionVerdicts);
  const failureSummary =
    state.failureSummary ??
    ([
      state.blockingDefects.length > 0 ? `Blocking defects: ${state.blockingDefects.join("; ")}` : "",
      state.missingEvidence.length > 0 ? `Missing evidence: ${state.missingEvidence.join("; ")}` : "",
    ].filter(Boolean).join("\n") ||
      "Verification did not pass.");
  const recommendedNextStep =
    state.recommendedNextStep ??
    (failureOwner === "contract"
      ? "Revise the contract and re-run verification."
      : failureOwner === "implementation"
        ? "Rework the implementation and re-run verification."
        : "Escalate to the coordinator for clarification.");

  // When the verifier wants REWORK_REQUIRED, check if we've hit the cap.
  // If so, escalate to BLOCKED (which is legal from VERIFYING) instead.
  const MAX_REWORK = Number(process.env.TASKGRAPH_MAX_REWORK_ATTEMPTS ?? 3);
  let effectiveVerdict = routeVerdictByFailureOwner(state.verdict, failureOwner);
  let reworkAttemptsDone = 0;
  if (effectiveVerdict === "REWORK_REQUIRED") {
    reworkAttemptsDone = await getReworkAttemptCount(state.taskId);
    if (reworkAttemptsDone >= MAX_REWORK) {
      effectiveVerdict = "BLOCKED";
    }
  }

  await recordVerification({
    taskId: state.taskId,
    agentRunId: state.agentRunId,
    verdict: effectiveVerdict,
    blockingDefects: state.blockingDefects,
    missingEvidence: state.missingEvidence,
    regressionRisks: state.regressionRisks,
    criterionVerdicts: state.criterionVerdicts,
    failureOwner,
    failedAcIds,
    failureSummary,
    recommendedNextStep,
    questionForUser: state.questionForUser ?? undefined,
  });

  const allCriteriaHaveVerdicts = state.contract.acceptance_criteria.every(
    (ac) => Boolean(state.criterionVerdicts[ac.id])
  );
  const values = Object.values(state.criterionVerdicts);
  const requiredHumanApprovalsRecorded = await requiredApprovalsRecorded(
    state.taskId,
    state.contract.approvals_required
  );

  const completionContext = {
    allCriteriaHaveVerdicts,
    allRequiredEvidenceExists: state.missingEvidence.length === 0,
    ciChecksPassed: !state.evidenceRecords.some((record) => record.status === "fail"),
    independentVerificationPassed:
      state.blockingDefects.length === 0 &&
      values.every((value) => value === "PASS" || value === "NOT_APPLICABLE"),
    requiredHumanApprovalsRecorded,
  };

  const fromStatus = await getTaskStatus(state.taskId);
  const transitioned = await transitionTaskStatusIfLegal({
    taskId: state.taskId,
    to: effectiveVerdict,
    actor: "verification-cell",
    payload: {
      agent_run_id: state.agentRunId,
      criterion_verdicts: state.criterionVerdicts,
      original_verdict: state.verdict,
      from_status: fromStatus,
    },
    completion: effectiveVerdict === "COMPLETE" ? completionContext : undefined,
  });

  if (!transitioned) {
    console.warn(
      `[Verification Cell] Saved ${effectiveVerdict} for ${state.taskId} but could not transition ` +
        `${fromStatus} → ${effectiveVerdict}. Run recover-task-verdict.ts if needed.`,
    );
  }

  if (effectiveVerdict === "COMPLETE" && transitioned) {
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "human_notification",
      content: {
        type: "task_complete",
        task_id: state.taskId,
        message: `${state.taskId} verification passed. All acceptance criteria satisfied.`,
        agent_run_id: state.agentRunId,
        notified_at: new Date().toISOString(),
      },
    });
    const integration = await integrateCompletedTaskBranch(state.taskId).catch(
      (err) => ({
        ok: false,
        merged: false,
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    if (integration.merged) {
      await recordArtifact({
        taskId: state.taskId,
        artifactType: "human_notification",
        content: {
          type: "work_integrated",
          task_id: state.taskId,
          message: `${state.taskId}'s changes were merged into the default branch.`,
          notified_at: new Date().toISOString(),
        },
      });
    } else if (!integration.ok) {
      await recordArtifact({
        taskId: state.taskId,
        artifactType: "human_notification",
        content: {
          type: "integration_conflict",
          task_id: state.taskId,
          message:
            `${state.taskId} is COMPLETE but could not be merged automatically: ${integration.detail}. ` +
            `Merge branch taskgraph/${state.taskId.toLowerCase()} manually.`,
          notified_at: new Date().toISOString(),
        },
      });
    }
    // Dependent tasks parked at AWAITING_APPROVAL (waiting_on_dependency) have
    // no queue message left — without this wake-up, chains deadlock one step
    // after the first task completes.
    await wakeDependentTasks(state.taskId, state.agentRunId);
  } else if (effectiveVerdict === "REWORK_REQUIRED" && transitioned) {
    // Auto re-enqueue engineering with defect context. The scheduler handler will
    // transition REWORK_REQUIRED → IN_PROGRESS and re-run the engineering cell.
    await enqueue({
      job_type: "task.rework.requested",
      task_id: state.taskId,
      payload: {
        task_id: state.taskId,
        blocking_defects: state.blockingDefects,
        missing_evidence: state.missingEvidence,
        rework_attempt: reworkAttemptsDone + 1,
      },
    });
  } else if (
    effectiveVerdict === "BLOCKED" &&
    state.verdict === "REWORK_REQUIRED" &&
    failureOwner === "implementation"
  ) {
    // Rework cap hit — record a human_notification so the Realtime watcher
    // forwards it to Telegram. Verification cell doesn't import from intake.
    const defectSummary = state.blockingDefects.map((d) => `• ${d}`).join("\n");
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "human_notification",
      content: {
        type: "rework_escalated",
        task_id: state.taskId,
        message:
          `Blocked after ${reworkAttemptsDone} rework attempt(s).\n\n` +
          `Blocking defects:\n${defectSummary || "(none listed)"}`,
      },
    });
  } else if (effectiveVerdict === "BLOCKED" && failureOwner === "contract" && transitioned) {
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "human_notification",
      content: {
        type: "contract_revision_requested",
        task_id: state.taskId,
        failed_ac_ids: failedAcIds,
        message:
          `Verification found a contract issue in ${failedAcIds.join(", ") || "the contract"}. ` +
          "Planning will revise the contract and re-run verification.",
        failure_summary: failureSummary,
        recommended_next_step: recommendedNextStep,
        agent_run_id: state.agentRunId,
        notified_at: new Date().toISOString(),
      },
    });
    await enqueue({
      job_type: "task.contract_revision.requested",
      task_id: state.taskId,
      payload: {
        task_id: state.taskId,
        failed_ac_ids: failedAcIds,
        failure_summary: failureSummary,
        recommended_next_step: recommendedNextStep,
        question_for_user: state.questionForUser ?? undefined,
        verifier_reason: state.modelReview ?? failureSummary,
      },
    });
  } else if (
    effectiveVerdict === "BLOCKED" &&
    (failureOwner === "human_decision" || failureOwner === "unknown") &&
    transitioned
  ) {
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "human_notification",
      content: {
        type: "human_input_required",
        task_id: state.taskId,
        failed_ac_ids: failedAcIds,
        message: failureSummary,
        question: state.questionForUser ?? "Verification needs human clarification before this task can continue.",
        recommended_next_step: recommendedNextStep,
        agent_run_id: state.agentRunId,
        notified_at: new Date().toISOString(),
      },
    });
  } else if (effectiveVerdict === "BLOCKED" && failureOwner === "infrastructure" && transitioned) {
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "human_notification",
      content: {
        type: "infrastructure_blocked",
        task_id: state.taskId,
        failed_ac_ids: failedAcIds,
        message: failureSummary,
        recommended_next_step: recommendedNextStep,
        agent_run_id: state.agentRunId,
        notified_at: new Date().toISOString(),
      },
    });
  }

  return {};
}

function hasError(state: S): "error" | "continue" {
  return state.error ? "error" : "continue";
}

async function handleError(state: S): Promise<Partial<S>> {
  console.error(`[Verification Cell] Error in ${state.taskId}: ${state.error}`);

  try {
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "verification_error",
      content: { agent_run_id: state.agentRunId, error: state.error },
    });
  } catch (err) {
    console.error(
      `[Verification Cell] Could not persist verification_error for ${state.taskId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return {};
}

const graph = new StateGraph(VerificationState)
  .addNode("readContractAndEvidence", readContractAndEvidence)
  .addNode("runModelReview", runModelReview)
  .addNode("mapEvidenceToCriteria", mapEvidenceToCriteria)
  .addNode("reconcileMissingEvidence", reconcileMissingEvidence)
  .addNode("deriveVerdict", deriveVerdict)
  .addNode("publishVerificationRecord", publishVerificationRecord)
  .addNode("handleError", handleError)
  .addEdge("__start__", "readContractAndEvidence")
  .addEdge("readContractAndEvidence", "runModelReview")
  .addConditionalEdges("runModelReview", hasError, {
    error: "mapEvidenceToCriteria",
    continue: "mapEvidenceToCriteria",
  })
  .addEdge("mapEvidenceToCriteria", "reconcileMissingEvidence")
  .addEdge("reconcileMissingEvidence", "deriveVerdict")
  .addEdge("deriveVerdict", "publishVerificationRecord")
  .addConditionalEdges("publishVerificationRecord", hasError, {
    error: "handleError",
    continue: "__end__",
  });

export const verificationWorkflow = graph.compile();
