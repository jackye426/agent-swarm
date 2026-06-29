import { StateGraph, Annotation } from "@langchain/langgraph";
import type { CriterionVerdict, EvidenceRecord, TaskContract, TaskVerdict } from "../../core/types.js";
import { deriveTaskVerdict, findMissingEvidence } from "../../core/verification.js";
import { invokeRoleModel } from "../../core/model-router.js";
import {
  recordArtifact,
  recordVerification,
  requiredApprovalsRecorded,
} from "../../db/records.js";
import { transitionTaskStatus } from "../../db/tasks.js";

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
    .map((ac) => `${ac.id}: ${ac.requirement}\n  Verification: ${ac.verification.join(", ")}`)
    .join("\n\n");

  const evidenceSummary = state.evidenceRecords
    .map((e) => `${e.evidence_id} [${e.status}] -> ${e.acceptance_criteria.join(", ")}: ${e.summary}`)
    .join("\n");

  const content = await invokeRoleModel("verification", [
    {
      role: "system",
      content: `You are an independent code verifier. You did not implement this work.
Return only JSON with: {"criterion_verdicts":{"AC-1":"PASS"},"blocking_defects":[],"regression_risks":[]}.
Use PASS, FAIL, INCONCLUSIVE, or NOT_APPLICABLE for every acceptance criterion.`,
    },
    {
      role: "user",
      content: `Contract: ${state.contract.id} - ${state.contract.title}

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

  await recordVerification({
    taskId: state.taskId,
    agentRunId: state.agentRunId,
    verdict: state.verdict,
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

  await transitionTaskStatus({
    taskId: state.taskId,
    to: state.verdict,
    actor: "verification-cell",
    payload: {
      agent_run_id: state.agentRunId,
      criterion_verdicts: state.criterionVerdicts,
    },
    completion: state.verdict === "COMPLETE" ? completionContext : undefined,
  });

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
