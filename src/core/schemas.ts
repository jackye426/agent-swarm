import { z } from "zod";

// ---- Shared primitives ----

const taskStatusValues = [
  "DRAFT",
  "PLANNING",
  "AWAITING_APPROVAL",
  "READY",
  "IN_PROGRESS",
  "AWAITING_EVIDENCE",
  "VERIFYING",
  "COMPLETE",
  "REWORK_REQUIRED",
  "BLOCKED",
  "CANCELLED",
] as const;

const evidenceTypeValues = [
  "integration_test",
  "unit_test",
  "browser_test",
  "ci_run",
  "migration_dry_run",
  "security_check",
  "model_review",
  "human_approval",
  "audit_log_assertion",
  "other",
] as const;

// ---- Contract schema ----

export const AcceptanceCriterionSchema = z.object({
  id: z.string().regex(/^AC-\d+$/, "Criterion id must match AC-<number>"),
  requirement: z.string().min(1),
  verification: z.array(z.string().min(1)).min(1, "Each criterion must name at least one verification method"),
});

export const RiskSchema = z.object({
  risk: z.string().min(1),
  mitigation: z.string().min(1),
});

export const TaskOwnerSchema = z.object({
  product: z.string().min(1),
  engineering: z.string().min(1),
});

export const TaskScopeSchema = z.object({
  in: z.array(z.string().min(1)).min(1),
  out: z.array(z.string().min(1)),
});

export const TaskContractSchema = z
  .object({
    id: z.string().regex(/^T-\d+$/, "Task id must match T-<number>"),
    title: z.string().min(1),
    goal: z.string().min(1),
    status: z.enum(taskStatusValues),
    owner: TaskOwnerSchema,
    scope: TaskScopeSchema,
    dependencies: z.array(z.string()),
    constraints: z.array(z.string()),
    acceptance_criteria: z
      .array(AcceptanceCriterionSchema)
      .min(1, "Contract must define at least one acceptance criterion"),
    risks: z.array(RiskSchema),
    rollback: z.array(z.string()),
    approvals_required: z.array(z.string()).min(1, "At least one approval is required"),
  })
  .superRefine((contract, ctx) => {
    const seenAcIds = new Set<string>();
    for (const [index, ac] of contract.acceptance_criteria.entries()) {
      if (seenAcIds.has(ac.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate acceptance criterion id ${ac.id}`,
          path: ["acceptance_criteria", index, "id"],
        });
      }
      seenAcIds.add(ac.id);
    }
  });

export type ValidatedContract = z.infer<typeof TaskContractSchema>;

// ---- Evidence record schema ----

export const EvidenceRecordSchema = z
  .object({
    evidence_id: z.string().regex(/^E-\d+$/, "Evidence id must match E-<number>"),
    task_id: z.string().regex(/^T-\d+$/, "Task id must match T-<number>"),
    acceptance_criteria: z
      .array(z.string().regex(/^AC-\d+$/, "Each AC ref must match AC-<number>"))
      .min(1, "Evidence must reference at least one acceptance criterion"),
    type: z.enum(evidenceTypeValues),
    status: z.enum(["pass", "fail", "inconclusive"]),
    commit_sha: z.string().optional(),
    source: z.string().url("source must be a valid URL"),
    command: z.string().optional(),
    timestamp: z.preprocess(
      (value) => value instanceof Date ? value.toISOString() : value,
      z.string().datetime({ message: "timestamp must be ISO 8601" })
    ),
    summary: z.string().min(1),
  })
  .superRefine((e, ctx) => {
    const placeholderValues = ["PLACEHOLDER", "placeholder", "your-org", "your-repo"];
    const fieldsToCheck = [
      ["commit_sha", e.commit_sha],
      ["source", e.source],
      ["command", e.command],
      ["summary", e.summary],
    ] as const;

    for (const [field, value] of fieldsToCheck) {
      if (value && placeholderValues.some((placeholder) => value.includes(placeholder))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must not contain placeholder values`,
          path: [field],
        });
      }
    }

    if (e.commit_sha && !/^[0-9a-f]{7,40}$/i.test(e.commit_sha)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "commit_sha must be a 7 to 40 character hexadecimal Git SHA",
        path: ["commit_sha"],
      });
    }
  })
  .refine(
    (e) => e.type !== "ci_run" || e.commit_sha !== undefined,
    { message: "CI run evidence must include a commit_sha", path: ["commit_sha"] }
  )
  .refine(
    (e) => e.type !== "integration_test" || e.commit_sha !== undefined,
    { message: "Integration test evidence must include a commit_sha", path: ["commit_sha"] }
  );

export type ValidatedEvidence = z.infer<typeof EvidenceRecordSchema>;

// ---- Cross-validation: evidence ACs must exist in contract ----

export function validateEvidenceAgainstContract(
  evidence: ValidatedEvidence,
  contract: ValidatedContract
): string[] {
  const errors: string[] = [];
  const validAcIds = new Set(contract.acceptance_criteria.map((ac) => ac.id));

  for (const acRef of evidence.acceptance_criteria) {
    if (!validAcIds.has(acRef)) {
      errors.push(
        `Evidence ${evidence.evidence_id} references unknown criterion ${acRef} (not in contract ${contract.id})`
      );
    }
  }

  return errors;
}

// ---- Completeness check: all ACs must have at least one passing evidence item ----

export function checkCriteriaFullyCovered(
  contract: ValidatedContract,
  evidenceList: ValidatedEvidence[]
): { covered: Set<string>; missing: string[] } {
  const covered = new Set<string>();

  for (const e of evidenceList) {
    if (e.status === "pass") {
      for (const acRef of e.acceptance_criteria) {
        covered.add(acRef);
      }
    }
  }

  const missing = contract.acceptance_criteria
    .map((ac) => ac.id)
    .filter((id) => !covered.has(id));

  return { covered, missing };
}
