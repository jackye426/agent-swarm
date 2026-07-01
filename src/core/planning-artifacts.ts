import { z } from "zod";

/** v0 research uses model knowledge only — not cited web/docs research. */
export const ResearchBriefV0Schema = z.object({
  artifact_type: z.literal("research_brief_v0"),
  source_mode: z.literal("model_knowledge"),
  domain: z.string().min(1),
  summary: z.string().min(1),
  key_findings: z.array(z.string()).default([]),
  unresolved_unknowns: z.array(z.string()).default([]),
  /** Explicit disclaimer for planners/verifiers. */
  citation_status: z.literal("none"),
});

export type ResearchBriefV0 = z.infer<typeof ResearchBriefV0Schema>;

/** Proposed memory item — promoted only after review (conservative writeback). */
export const MemoryCandidateSchema = z.object({
  memory_type: z.enum([
    "user_product",
    "project",
    "codebase",
    "decision",
    "outcome",
    "research",
  ]),
  scope: z.string().min(1),
  subject: z.string().min(1),
  content: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1).default(0.7),
  rationale: z.string().min(1),
});

export const MemoryCandidateBatchSchema = z.object({
  artifact_type: z.literal("memory_candidates"),
  candidates: z.array(MemoryCandidateSchema).max(10),
  promoted_count: z.literal(0).default(0),
});

export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
