#!/usr/bin/env tsx
/**
 * Idempotent seed of system-knowledge ADRs into decision_records.
 * Usage: npm run seed:decisions
 */

import "dotenv/config";
import { findDecisionByTitle, recordDecision } from "../src/db/records.js";

const DECISIONS = [
  {
    title: "ADR 001: Planning Cell Auto-Approval",
    taskId: null,
    decision:
      "Replace humanApprovalGate interrupt with autoApproveContract after multi-agent review and executability validation.",
    rationale:
      "v1 dogfood requires unattended planning → engineering → verification. Auto-approval records all approvals_required roles under planning-cell-auto-approver. Production must add real human gates for privacy/security/release.",
    madeBy: "system-knowledge-layer",
  },
  {
    title: "ADR 002: Claude Code --dangerously-skip-permissions",
    taskId: null,
    decision:
      "Invoke Claude Code with --dangerously-skip-permissions when task is IN_PROGRESS and approvals are recorded.",
    rationale:
      "Contract language triggers false approval stops. Flag skips Claude interactive prompts only; does not bypass TaskGraph verification or commit guard.",
    madeBy: "system-knowledge-layer",
  },
  {
    title: "ADR 003: Rework Cap via agent_runs.worker_type",
    taskId: null,
    decision:
      "Count rework attempts via agent_runs WHERE worker_type = rework-cell instead of a dedicated counter column.",
    rationale:
      "Rework history is auditable via agent_runs. Shared WORKER_TYPE_REWORK constant prevents silent drift between scheduler and getReworkAttemptCount.",
    madeBy: "system-knowledge-layer",
  },
] as const;

async function main(): Promise<void> {
  for (const adr of DECISIONS) {
    const existing = await findDecisionByTitle(adr.title);
    if (existing) {
      console.log(`[skip] ${adr.title} already exists (${existing.id})`);
      continue;
    }

    const id = await recordDecision({
      taskId: adr.taskId,
      title: adr.title,
      decision: adr.decision,
      rationale: adr.rationale,
      madeBy: adr.madeBy,
    });
    console.log(`[seed] ${adr.title} → ${id}`);
  }

  console.log("Decision seed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
