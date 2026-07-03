---
version: 1
affects: [src/core/state-machine.ts, tasks, task_events]
---

# Task Lifecycle

TaskGraph OS tracks work through 11 statuses. Legal transitions are enforced in `src/core/state-machine.ts`; every transition is also logged to `task_events`.

## Status flow

```text
DRAFT
  → PLANNING → AWAITING_APPROVAL → READY
  → IN_PROGRESS → AWAITING_EVIDENCE → VERIFYING
  → COMPLETE | REWORK_REQUIRED | BLOCKED | CANCELLED
```

REWORK_REQUIRED loops back to IN_PROGRESS via the scheduler (`task.rework.requested`).

## Legal transitions

| From | To |
|------|-----|
| DRAFT | PLANNING, CANCELLED |
| PLANNING | AWAITING_APPROVAL, BLOCKED, CANCELLED |
| AWAITING_APPROVAL | READY, PLANNING, CANCELLED |
| READY | IN_PROGRESS, CANCELLED |
| IN_PROGRESS | AWAITING_EVIDENCE, REWORK_REQUIRED, BLOCKED, CANCELLED |
| AWAITING_EVIDENCE | VERIFYING, IN_PROGRESS, BLOCKED |
| VERIFYING | COMPLETE, REWORK_REQUIRED, BLOCKED, CANCELLED |
| REWORK_REQUIRED | IN_PROGRESS, CANCELLED |
| BLOCKED | READY, CANCELLED |

## Terminal states

| Status | Why terminal |
|--------|--------------|
| **COMPLETE** | All acceptance criteria satisfied, evidence reconciled, verification passed. No further work. |
| **CANCELLED** | Work abandoned. No further transitions. |

Non-terminal but blocking:

| Status | Meaning |
|--------|---------|
| **BLOCKED** | Cannot proceed without human intervention (inconclusive verification, rework cap hit, missing context). Can return to READY after fix. |
| **REWORK_REQUIRED** | Verification failed; engineering must re-run. Auto-enqueues rework when configured. |

## READY guard conditions

A task may become READY only when all of `assertReady()` pass:

1. **Contract valid** — schema and executability validation passed
2. **Dependencies complete** — all dependency tasks are COMPLETE
3. **Approvals recorded** — every role in `approvals_required` has an `approval_records` row
4. **Context packet available** — execution context stored for engineering

In v1 dogfood, the planning cell auto-records approvals via `planning-cell-auto-approver`. See [approval-policy.md](../policies/approval-policy.md).

## COMPLETE guard conditions

A task may become COMPLETE only when all of `assertComplete()` pass:

1. **All criteria have verdicts** — every AC id has PASS, FAIL, INCONCLUSIVE, or NOT_APPLICABLE
2. **All required evidence exists** — after `computeEffectiveMissingEvidence` reconciliation
3. **CI checks passed** — no evidence record with `status: fail`
4. **Independent verification passed** — no blocking defects; all verdicts PASS or NOT_APPLICABLE
5. **Required approvals recorded** — same check as READY

A task is not complete because code was written. It completes when the approved contract is satisfied with evidence and independent verification.
