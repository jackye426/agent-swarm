import { z } from "zod";

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
  blocking_defects: z.array(z.string()).default([]),
  missing_evidence: z.array(z.string()).default([]),
  rework_attempt: z.number().int().min(1),
});

export type PlanRequestedPayload = z.infer<typeof PlanRequestedPayloadSchema>;
export type ContractRevisionRequestedPayload = z.infer<typeof ContractRevisionRequestedPayloadSchema>;
export type ExecutionRequestedPayload = z.infer<typeof ExecutionRequestedPayloadSchema>;
export type VerificationRequestedPayload = z.infer<typeof VerificationRequestedPayloadSchema>;
export type ReworkRequestedPayload = z.infer<typeof ReworkRequestedPayloadSchema>;
