import type { CriterionVerdict, TaskContract, TaskVerdict } from "./types.js";

export interface ReworkContextInput {
  contract: TaskContract;
  baseContext: string;
  reworkAttempt: number;
  blockingDefects: string[];
  missingEvidence: string[];
  verdict?: TaskVerdict;
  criterionVerdicts?: Record<string, CriterionVerdict>;
}

function formatCriterionVerdictSummary(
  contract: TaskContract,
  criterionVerdicts: Record<string, CriterionVerdict> | undefined,
): string {
  if (!criterionVerdicts || Object.keys(criterionVerdicts).length === 0) {
    return contract.acceptance_criteria
      .map((ac) => `  ${ac.id}: (no prior verdict)`)
      .join("\n");
  }

  return contract.acceptance_criteria
    .map((ac) => {
      const verdict = criterionVerdicts[ac.id] ?? "INCONCLUSIVE";
      const tag =
        verdict === "PASS" || verdict === "NOT_APPLICABLE"
          ? "preserve"
          : verdict === "FAIL"
            ? "fix"
            : "verify";
      return `  ${ac.id}: ${verdict} (${tag}) — ${ac.requirement}`;
    })
    .join("\n");
}

function formatContractSummary(contract: TaskContract): string {
  const acList = contract.acceptance_criteria
    .map((ac) => `  ${ac.id}: ${ac.requirement} [verify: ${ac.verification.join(", ")}]`)
    .join("\n");

  return [
    `Contract: ${contract.id} — ${contract.title}`,
    `Goal: ${contract.goal}`,
    "",
    "Scope in:",
    ...contract.scope.in.map((s) => `  - ${s}`),
    "",
    "Scope out (do not modify):",
    ...(contract.scope.out.length > 0
      ? contract.scope.out.map((s) => `  - ${s}`)
      : ["  (none listed)"]),
    "",
    "Acceptance criteria:",
    acList,
  ].join("\n");
}

/** Engineering prompt context for rework: full contract + latest verdict + defect list. */
export function formatReworkContextForEngineering(input: ReworkContextInput): string {
  const sections = [
    input.baseContext.trim(),
    "",
    formatContractSummary(input.contract),
    "",
    `## Rework attempt ${input.reworkAttempt}`,
  ];

  if (input.verdict) {
    sections.push(`Latest verification verdict: ${input.verdict}`);
  }

  sections.push(
    "",
    "Criterion verdicts from last verification (preserve PASS/NOT_APPLICABLE; fix FAIL):",
    formatCriterionVerdictSummary(input.contract, input.criterionVerdicts),
  );

  if (input.blockingDefects.length > 0) {
    sections.push("", "Blocking defects to address:", ...input.blockingDefects.map((d) => `- ${d}`));
  }

  if (input.missingEvidence.length > 0) {
    sections.push("", "Missing evidence:", ...input.missingEvidence.map((e) => `- ${e}`));
  }

  sections.push(
    "",
    "Before committing: re-read the full contract above. Fix the listed defects without regressing any criterion " +
      "currently marked PASS or NOT_APPLICABLE. Run all required test commands and ensure evidence will satisfy " +
      "every acceptance criterion.",
  );

  return sections.filter((line) => line !== undefined).join("\n");
}
