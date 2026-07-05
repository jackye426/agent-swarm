import { z } from "zod";

export function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        const summary = obj.summary ?? obj.description ?? obj.message ?? obj.error;
        const id = typeof obj.id === "string" ? `${obj.id}: ` : "";
        if (typeof summary === "string" && summary.trim()) return `${id}${summary}`.trim();
        try {
          return JSON.stringify(obj);
        } catch {
          return String(item);
        }
      }
      return String(item);
    })
    .map((item) => item.trim())
    .filter(Boolean);
}

const TextListSchema = z.preprocess((value) => normalizeTextList(value), z.array(z.string()));

export const PlanRequestedPayloadSchema = z.object({
  task_id: z.string().regex(/^T-\d+$/),
  goal: z.string().min(1),
  context: z.string().default(""),
  stop_after_draft: z.boolean().default(false),
  repo_full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  repo_url: z.string().url().optional(),
});

export const ContractRevisionRequestedPayloadSchema = z.object({
  task_id: z.string().regex(/^T-\d+$/),
  failed_ac_ids: z.array(z.string().regex(/^AC-\d+$/)).default([]),
  failure_summary: z.string().default(""),
  recommended_next_step: z.string().default(""),
  question_for_user: z.string().optional(),
  verifier_reason: z.string().default(""),
});

export const ExecutionRequestedPayloadSchema = z.object({
  task_id: z.string().regex(/^T-\d+$/),
  context: z.record(z.unknown()).optional(),
  test_commands: z.array(z.string().min(1)).optional(),
});

export const VerificationRequestedPayloadSchema = z.object({
  task_id: z.string().regex(/^T-\d+$/),
  pr_diff: z.string().default(""),
  ci_output: z.string().default(""),
  commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
  source_url: z.string().url().optional(),
});

export const ReworkRequestedPayloadSchema = z.object({
  task_id: z.string().regex(/^T-\d+$/),
  blocking_defects: TextListSchema.default([]),
  missing_evidence: TextListSchema.default([]),
  rework_attempt: z.number().int().min(1),
});

export type PlanRequestedPayload = z.infer<typeof PlanRequestedPayloadSchema>;
export type ContractRevisionRequestedPayload = z.infer<typeof ContractRevisionRequestedPayloadSchema>;
export type ExecutionRequestedPayload = z.infer<typeof ExecutionRequestedPayloadSchema>;
export type VerificationRequestedPayload = z.infer<typeof VerificationRequestedPayloadSchema>;
export type ReworkRequestedPayload = z.infer<typeof ReworkRequestedPayloadSchema>;
