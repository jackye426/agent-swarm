import type { CriterionVerdict, EvidenceRecord, TaskContract, TaskVerdict } from "./types.js";
import { checkCriteriaFullyCovered } from "./schemas.js";

export function findMissingEvidence(contract: TaskContract, evidenceRecords: EvidenceRecord[]): string[] {
  const { missing } = checkCriteriaFullyCovered(contract, evidenceRecords);
  return missing.map((acId) => `${acId}: no passing evidence record found`);
}

export function deriveTaskVerdict(input: {
  criterionVerdicts: Record<string, CriterionVerdict>;
  missingEvidence: string[];
  blockingDefects: string[];
}): TaskVerdict {
  const values = Object.values(input.criterionVerdicts);

  if (input.blockingDefects.length > 0) return "REWORK_REQUIRED";
  if (values.some((value) => value === "FAIL")) return "REWORK_REQUIRED";
  if (input.missingEvidence.length > 0) return "REWORK_REQUIRED";
  if (values.length === 0 || values.some((value) => value === "INCONCLUSIVE")) return "BLOCKED";
  if (values.every((value) => value === "PASS" || value === "NOT_APPLICABLE")) return "COMPLETE";
  return "BLOCKED";
}
