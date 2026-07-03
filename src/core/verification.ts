import type { CriterionVerdict, EvidenceRecord, TaskContract, TaskVerdict } from "./types.js";
import {
  classifyAcceptanceCriterion,
  primaryAcKind,
} from "./contract-executability.js";
import { checkCriteriaFullyCovered } from "./schemas.js";

export function findMissingEvidence(contract: TaskContract, evidenceRecords: EvidenceRecord[]): string[] {
  const { missing } = checkCriteriaFullyCovered(contract, evidenceRecords);
  return missing.map((acId) => `${acId}: no passing evidence record found`);
}

/** AC id prefix from a findMissingEvidence entry ("AC-1: no passing..."). */
function acIdFromMissingEntry(entry: string): string | null {
  const match = entry.match(/^(AC-\d+):/);
  return match?.[1] ?? null;
}

/**
 * Reconcile raw missing-evidence with model verdicts and AC verification kinds.
 * Diff-inspection ACs with PASS/NOT_APPLICABLE verdicts are satisfied without ci_run pass evidence.
 * Command ACs require both a PASS verdict and passing ci_run evidence.
 */
export function computeEffectiveMissingEvidence(
  contract: TaskContract,
  evidenceRecords: EvidenceRecord[],
  criterionVerdicts: Record<string, CriterionVerdict>,
): string[] {
  const raw = findMissingEvidence(contract, evidenceRecords);
  const resolvedAcIds = new Set<string>();

  for (const ac of contract.acceptance_criteria) {
    const verdict = criterionVerdicts[ac.id];
    if (verdict !== "PASS" && verdict !== "NOT_APPLICABLE") continue;

    const primary = primaryAcKind(classifyAcceptanceCriterion(ac));

    if (primary === "diff_inspection") {
      resolvedAcIds.add(ac.id);
      continue;
    }

    if (primary === "command") {
      const hasPassingCiRun = evidenceRecords.some(
        (record) =>
          record.status === "pass" &&
          record.type === "ci_run" &&
          record.acceptance_criteria.includes(ac.id),
      );
      if (hasPassingCiRun) {
        resolvedAcIds.add(ac.id);
      }
    }
  }

  return raw.filter((entry) => {
    const acId = acIdFromMissingEntry(entry);
    return acId !== null && !resolvedAcIds.has(acId);
  });
}

export function deriveTaskVerdict(input: {
  criterionVerdicts: Record<string, CriterionVerdict>;
  missingEvidence: string[];
  blockingDefects: string[];
}): TaskVerdict {
  const values = Object.values(input.criterionVerdicts);

  if (input.blockingDefects.length > 0) return "REWORK_REQUIRED";
  if (values.some((value) => value === "FAIL")) return "REWORK_REQUIRED";
  if (values.length === 0 || values.some((value) => value === "INCONCLUSIVE")) return "BLOCKED";
  if (input.missingEvidence.length > 0) return "REWORK_REQUIRED";
  if (values.every((value) => value === "PASS" || value === "NOT_APPLICABLE")) return "COMPLETE";
  return "BLOCKED";
}
