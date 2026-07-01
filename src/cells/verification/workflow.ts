import { StateGraph, Annotation } from "@langchain/langgraph";
import type { CriterionVerdict, EvidenceRecord, TaskContract, TaskVerdict } from "../../core/types.js";
import { deriveTaskVerdict, findMissingEvidence } from "../../core/verification.js";
import { classifyVerificationMethod } from "../../core/contract-executability.js";
import { invokeRoleModel } from "../../core/model-router.js";
import {
  getReworkAttemptCount,
  recordArtifact,
  recordVerification,
  requiredApprovalsRecorded,
} from "../../db/records.js";
import { enqueue } from "../../db/queue.js";
import { getTaskStatus, transitionTaskStatusIfLegal } from "../../db/tasks.js";

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

  const content = await invokeRoleModel("verification", [
    {
      role: "system",
      content: `You are an independent code verifier. You did not implement this work.
Return only JSON with: {"criterion_verdicts":{"AC-1":"PASS"},"blocking_defects":[],"regression_risks":[]}.
Use PASS, FAIL, INCONCLUSIVE, or NOT_APPLICABLE for every acceptance criterion.

Judging rules:
- command verification: use CI output and ci_run evidence
- diff_inspection verification: judge primarily from the PR diff; do not require CI alone
- human verification: PASS only if explicit human evidence exists; otherwise INCONCLUSIVE or NOT_APPLICABLE
- Flag scope violations if changed files appear to touch scope.out areas`,
    },
    {
      role: "user",
      content: `Contract: ${state.contract.id} - ${state.contract.title}

Scope in:
${scopeIn || "(none)"}

Scope out:
${scopeOut || "(none)"}

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
    };
  } catch (err) {
    return {
      error: `Failed to parse model review JSON: ${(err as Error).message}`,
      modelReview: content,
      criterionVerdicts: Object.fromEntries(
        state.contract.acceptance_criteria.map((ac) => [ac.id, "INCONCLUSIVE" as CriterionVerdict])
      ),
    };
  }
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

async function deriveVerdict(state: S): Promise<Partial<S>> {
  return {
    verdict: deriveTaskVerdict({
      criterionVerdicts: state.criterionVerdicts,
      missingEvidence: state.missingEvidence,
      blockingDefects: state.blockingDefects,
    }),
  };
}

async function publishVerificationRecord(state: S): Promise<Partial<S>> {
  if (!state.verdict) return { error: "Cannot publish verification without a verdict" };
  if (!state.agentRunId) return { error: "Cannot publish verification without an agent run id" };

  // When the verifier wants REWORK_REQUIRED, check if we've hit the cap.
  // If so, escalate to BLOCKED (which is legal from VERIFYING) instead.
  const MAX_REWORK = Number(process.env.TASKGRAPH_MAX_REWORK_ATTEMPTS ?? 3);
  let effectiveVerdict = state.verdict;
  let reworkAttemptsDone = 0;
  if (state.verdict === "REWORK_REQUIRED") {
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

  if (effectiveVerdict === "REWORK_REQUIRED" && transitioned) {
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
  } else if (effectiveVerdict === "BLOCKED" && state.verdict === "REWORK_REQUIRED") {
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
  }

  return {};
}

function hasError(state: S): "error" | "continue" {
  return state.error ? "error" : "continue";
}

async function handleError(state: S): Promise<Partial<S>> {
  await recordArtifact({
    taskId: state.taskId,
    artifactType: "verification_error",
    content: { agent_run_id: state.agentRunId, error: state.error },
  });
  console.error(`[Verification Cell] Error in ${state.taskId}: ${state.error}`);
  return {};
}

const graph = new StateGraph(VerificationState)
  .addNode("readContractAndEvidence", readContractAndEvidence)
  .addNode("runModelReview", runModelReview)
  .addNode("mapEvidenceToCriteria", mapEvidenceToCriteria)
  .addNode("deriveVerdict", deriveVerdict)
  .addNode("publishVerificationRecord", publishVerificationRecord)
  .addNode("handleError", handleError)
  .addEdge("__start__", "readContractAndEvidence")
  .addEdge("readContractAndEvidence", "runModelReview")
  .addConditionalEdges("runModelReview", hasError, {
    error: "mapEvidenceToCriteria",
    continue: "mapEvidenceToCriteria",
  })
  .addEdge("mapEvidenceToCriteria", "deriveVerdict")
  .addEdge("deriveVerdict", "publishVerificationRecord")
  .addConditionalEdges("publishVerificationRecord", hasError, {
    error: "handleError",
    continue: "__end__",
  });

export const verificationWorkflow = graph.compile();
