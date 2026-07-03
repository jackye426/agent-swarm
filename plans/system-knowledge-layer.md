# Feature Implementation Plan: System Knowledge Layer

**Overall Progress:** `100%`

## TLDR

TaskGraph OS has strong runtime enforcement (state machine, Zod validators, DB guards) but critical operational rules live only in code comments, developer memory, or are absent entirely. Three of the four T-008 failure causes trace directly to knowledge gaps; the fourth is operational hygiene (stale queue/evidence on re-seed).

This plan adds a minimal, version-controlled knowledge layer in three phases:

1. **Write the documents** — documentation-only, can land immediately.
2. **Close code-level string contract gaps** — bundle with delivery plan Phase 3 (`notifications.ts`, worker types, executability warnings).
3. **Wire excerpts into agent context** — after Line 1 reaches COMPLETE reliably (Line 2 gate).

No parsing framework, no new tables beyond seeding existing `decision_records`.

## Problem Evidence (T-008)

| Failure | Root cause | Addressed by |
|---------|------------|--------------|
| AC scope / `.gitignore` violations (AC-3, AC-7) | `scope.out` is text-only; verifier/engineer not grounded in policy | Phase 1 docs + Phase 3 engineering prompt |
| README missing from diff payload (AC-6) | Code bug in `verification-diff.ts` (not knowledge alone) | Cross-ref delivery plan; not fixed here |
| Executability mismatch (`npm run healthcheck` vs seed `[npm test]`) | Validator checks current seed commands, not future ones | Phase 2 warnings |
| Stale queue/evidence on re-seed | Undocumented ops procedure | Phase 1 ops doc |

## Critical Decisions

- **Markdown files, not a framework** — extend the existing `plans/` and `project_structure.md` convention; no parsing infrastructure yet.
- **Phase 1 is documentation-only** — zero code changes; can land before or in parallel with the delivery plan.
- **Phase 2 bundles with delivery plan Phase 3** — both touch `scheduler/index.ts` and `notifications.ts`; do them together.
- **Phase 3 gates on Line 1 COMPLETE** — don't wire knowledge into prompts until the pipeline reaches COMPLETE reliably.
- **Executability validator: warn, don't block, on command/seed mismatches** — when a contract command does not match any seed-detected command, write a **warning** into `ExecutabilityResult.warnings` instead of adding to `errors`. Still fail on unclassifiable (`unknown`) or human-only ACs. This fixes T-008 re-seed without weakening protection against vague verification methods.
- **`--strict` CI treats warnings as non-fatal** — log `[WARN]`; only `errors` fail exit code.
- **Phase 3 is sync, not net-new** — verification already has inline AC-kind rules in `runModelReview`; Phase 3 replaces duplication with doc-sourced excerpts and adds anti-drift comments.
- **Approval auto-satisfaction is documented, not changed** — `planning-cell-auto-approver` records every role in `approvals_required` (including Privacy); doc must flag this as v1 dogfood behavior.

## Directory Layout

```text
system-knowledge/
  README.md                          # index + when to read each doc
  concepts/
    task-lifecycle.md
    evidence-and-verification.md
    context-packets.md
  policies/
    agent-permissions.md
    approval-policy.md
    escalation-policy.md
  operations/
    re-seed-and-queue-hygiene.md
  decisions/
    001-auto-approval.md
    002-skip-permissions.md
    003-rework-cap-mechanism.md
```

Each doc includes YAML frontmatter:

```yaml
---
version: 1
affects: [path/to/source.ts, table_name]
---
```

## Phase 1: Write the Knowledge Documents

Documentation-only. No code changes.

- [x] 🟩 **Index**
  - [x] Create `system-knowledge/README.md` — links to all docs, audience (ops / planning / engineering / verification), and reading order.

- [x] 🟩 **Concepts**
  - [x] Create `system-knowledge/concepts/task-lifecycle.md`
    - 11-status lifecycle, legal transitions (`src/core/state-machine.ts`)
    - Why each terminal state is terminal
    - READY guard conditions (`assertReady`)
    - COMPLETE guard conditions (`assertComplete`)
    - Frontmatter `affects`: `[state-machine.ts, tasks, task_events]`

  - [ ] Create `system-knowledge/concepts/evidence-and-verification.md`
    - Three AC kinds: `command`, `diff_inspection`, `human` (from `contract-executability.ts`)
    - What satisfies each kind
    - Rule: model PASS on `diff_inspection` AC is sufficient without passing `ci_run` evidence (`computeEffectiveMissingEvidence`)
    - `deriveTaskVerdict` priority chain: blocking defects → FAIL → INCONCLUSIVE → missing evidence → COMPLETE
    - Known constraint: executability validation checks **current** seed commands, not commands the task will add
    - Frontmatter `affects`: `[verification.ts, contract-executability.ts, evidence_records]`

  - [ ] Create `system-knowledge/concepts/context-packets.md`
    - `execution_ready` packet shape (`buildExecutionReadyPacket`)
    - Test command resolution order: payload → packet → contract → seed (`resolveTestCommandsFromPacket`)
    - What planning_context / user_context / seed contain
    - Frontmatter `affects`: `[contract-executability.ts, planning/workflow.ts, engineering/workflow.ts]`

- [ ] 🟥 **Policies**
  - [ ] Create `system-knowledge/policies/agent-permissions.md`
    - What Claude Code can and cannot do
    - Why `--dangerously-skip-permissions` is used (task already IN_PROGRESS; approvals recorded before engineering)
    - Commit exclusion rules and purpose (`commit-guard.ts`)
    - Scope enforcement gap: `scope.out` is text-only; verification cell is the gate
    - Frontmatter `affects`: `[engineering/workflow.ts, commit-guard.ts]`

  - [ ] Create `system-knowledge/policies/approval-policy.md`
    - Distinction: human approval vs `planning-cell-auto-approver`
    - When auto-approval is acceptable (multi-agent review + executability validation passed)
    - When human approval is required in production (privacy, security, production release)
    - **Known v1 limitation:** auto-approver satisfies all roles in `approvals_required`, including Privacy
    - Frontmatter `affects`: `[approval_records, planning/workflow.ts]`

  - [ ] Create `system-knowledge/policies/escalation-policy.md`
    - Rework cap (default 3, `TASKGRAPH_MAX_REWORK_ATTEMPTS`)
    - How attempts are counted (`agent_runs WHERE worker_type='rework-cell'`)
    - At cap: BLOCKED + `rework_escalated` human_notification
    - Notification type registry (all valid `type` values + expected Telegram format):
      - `contract_auto_approved`
      - `contract_validation_failed`
      - `task_complete`
      - `rework_escalated`
    - Frontmatter `affects`: `[verification/workflow.ts, notifications.ts, TASKGRAPH_MAX_REWORK_ATTEMPTS]`

- [ ] 🟥 **Operations**
  - [ ] Create `system-knowledge/operations/re-seed-and-queue-hygiene.md`
    - Stale job rules (`src/scheduler/guards.ts`) — when jobs are acked without processing
    - Re-seed checklist: drain stale queue messages, reset task state, clear stale evidence
    - Reference commands from `STATUS.md` T-008 section
    - Frontmatter `affects`: `[scheduler/guards.ts, scheduler/index.ts]`

- [ ] 🟥 **ADRs**
  - [ ] Create `system-knowledge/decisions/001-auto-approval.md`
    - Why planning cell auto-approves; alternatives considered; conditions under which it holds
    - Status: accepted

  - [ ] Create `system-knowledge/decisions/002-skip-permissions.md`
    - Why `--dangerously-skip-permissions`; authorization preconditions; what it does not bypass
    - Status: accepted

  - [ ] Create `system-knowledge/decisions/003-rework-cap-mechanism.md`
    - Why rework attempts counted via `agent_runs.worker_type` not a dedicated counter
    - Coupling created; what breaks silently if the string drifts
    - Status: accepted

## Phase 2: Close Code-Level String Contract Gaps

Bundle with delivery plan Phase 3. Requires code + test changes.

- [ ] 🟥 **`contract_validation_failed` notification**
  - [ ] Add explicit case to `formatNotification` in `src/intake/notifications.ts`
  - [ ] Format: task id, contract title, bulleted `errors[]`, pointer to `contract_validation_failed` artifact
  - [ ] Add unit test for notification formatting (new test file or extend existing)

- [ ] 🟥 **Worker type constants**
  - [ ] Create `src/core/worker-types.ts` with shared constants:
    - `WORKER_TYPE_PLANNING = "planning-cell"`
    - `WORKER_TYPE_ENGINEERING = "engineering-cell"`
    - `WORKER_TYPE_VERIFICATION = "verification-cell"`
    - `WORKER_TYPE_REWORK = "rework-cell"`
    - (design, release as needed)
  - [ ] Import in `src/scheduler/index.ts::queueWorkerType()`
  - [ ] Import in `src/db/records.ts::getReworkAttemptCount()`
  - [ ] Grep for other hardcoded worker_type strings and consolidate

- [ ] 🟥 **Executability warnings (not errors) on command/seed mismatch**
  - [ ] Add `warnings: string[]` to `ExecutabilityResult` in `src/core/contract-executability.ts`
  - [ ] Move seed command mismatch from `errors` to `warnings` (lines ~183–189)
  - [ ] `ok` remains false only when `errors.length > 0`
  - [ ] Update `autoApproveContract` to include `warnings` in `contract_auto_approved` artifact
  - [ ] Update `scripts/validate-contract.ts --strict`: log warnings as `[WARN]`, fail only on errors
  - [ ] Update `tests/core.test.ts`:
    - Rename/adjust test *"executability flags command mismatch"* → expect `ok: true`, `warnings.length > 0`
    - Keep tests for human-only and unknown AC rejection unchanged

## Phase 3: Wire Knowledge into Agent Context

**Gate:** Line 1 COMPLETE on T-008 (or equivalent dogfood task) before starting.

- [ ] 🟥 **Anti-drift helper (minimal)**
  - [ ] Add `src/core/knowledge-excerpt.ts`:
    - `readKnowledgeExcerpt(relativePath: string, sectionHeading?: string): string`
    - Reads from `system-knowledge/` at runtime; truncates to max chars
  - [ ] Alternative acceptable: inline excerpt with `// Source: system-knowledge/...` comment if helper is overkill

- [ ] 🟥 **Verification cell — sync prompt to docs**
  - [ ] Replace inline judging rules in `src/cells/verification/workflow.ts::runModelReview` with excerpt from `evidence-and-verification.md`
  - [ ] Ensure diff_inspection satisfaction rule and scope violation flag remain present
  - [ ] Add source comment pointing to doc path + version frontmatter

- [ ] 🟥 **Engineering cell — scope enforcement in prompt**
  - [ ] Add excerpt from `agent-permissions.md` scope section to `invokeClaudeCode` authorized prompt
  - [ ] Explicit instruction: do not modify files matching `scope.out` areas
  - [ ] Add source comment pointing to doc path

- [ ] 🟥 **Seed decision records**
  - [ ] Add `recordDecision()` to `src/db/records.ts` (insert into `decision_records`)
  - [ ] Create `scripts/seed-decisions.ts` — idempotent insert of ADRs 001–003
  - [ ] Link to milestone tasks where applicable (`T-002` for auto-approval, `T-003` for skip-permissions, null or hardening task for rework cap)
  - [ ] Add npm script: `"seed:decisions": "tsx scripts/seed-decisions.ts"`

## Out of Scope

- Parsing frontmatter or building a knowledge query API
- Fixing README/diff payload assembly (`verification-diff.ts`) — stays on delivery plan
- Changing auto-approval to require real human approvers for Privacy/Security roles
- Wiring knowledge into planning cell prompts (planning already has multi-agent review; defer until deep planning)

## Dependencies

| Phase | Depends on |
|-------|------------|
| Phase 1 | Nothing — can start now |
| Phase 2 | Phase 1 docs for ADR cross-references (soft); delivery plan Phase 3 scheduling |
| Phase 3 | Line 1 COMPLETE; Phase 1 docs exist; Phase 2 worker types landed |

## Test Plan

| Phase | Verification |
|-------|--------------|
| Phase 1 | Manual review; docs reference real code paths; frontmatter `affects` is accurate |
| Phase 2 | `npm test` passes; notification test for `contract_validation_failed`; executability mismatch → warning not error; worker type constant used in scheduler + records |
| Phase 3 | `npm run typecheck`; verification/engineering prompts load excerpts; `npm run seed:decisions` idempotent; decision_records populated |

## Success Criteria

- [ ] A new operator can read `system-knowledge/README.md` and understand lifecycle, evidence rules, and re-seed procedure without asking a developer.
- [ ] T-008 re-seed with forward-looking `npm run healthcheck` AC passes auto-approval (warning recorded, not blocked).
- [ ] Telegram receives formatted message on `contract_validation_failed`, not generic fallback.
- [ ] Typo in rework worker type would fail at import site (shared constant).
- [ ] After Line 1 COMPLETE, engineering prompt explicitly cites `scope.out`; verification prompt cites diff_inspection rule from docs.

## Cross-References

- `project_structure.md` — product thesis and cell definitions
- `STATUS.md` — T-008 dogfood status and re-seed commands
- `OPERATIONS.md` — production run checklist
- `plans/production-hardening.md` — delivery plan Phase 3 bundle target
