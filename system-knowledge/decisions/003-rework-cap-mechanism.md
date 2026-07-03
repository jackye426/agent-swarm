---
status: accepted
date: 2026-07-03
task_id: null
---

# ADR 003: Rework Cap via agent_runs.worker_type

## Context

Verification can return REWORK_REQUIRED indefinitely. Production hardening requires a cap (`TASKGRAPH_MAX_REWORK_ATTEMPTS`, default 3) after which the task escalates to BLOCKED with human notification.

## Decision

Count rework attempts by querying `agent_runs` where `worker_type = 'rework-cell'`. No dedicated `rework_count` column on tasks.

## Why not a counter column

- Rework attempts are already auditable via agent_runs
- Avoids migration and sync bugs between counter and actual runs
- Cap check uses count at verification time before next enqueue

## Coupling created

The string `'rework-cell'` must match in:

- `src/scheduler/index.ts` — `queueWorkerType()` for `task.rework.requested`
- `src/db/records.ts` — `getReworkAttemptCount()`

A typo in either location breaks counting silently: cap never triggers, or triggers too early.

## Mitigation

Shared constants in `src/core/worker-types.ts` (Phase 2). All rework queue dispatches must use `WORKER_TYPE_REWORK`.

## What breaks silently if string drifts

| Symptom | Cause |
|---------|-------|
| Infinite rework loop | Count always 0 — scheduler uses wrong worker_type |
| Immediate BLOCKED on first rework | Count includes non-rework runs with wrong type |
| recover-task-verdict wrong attempt number | Stale count query |

## Alternatives considered

| Alternative | Why rejected for v1 |
|-------------|---------------------|
| `tasks.rework_count` column | Extra write on every rework; can desync from runs |
| Count REWORK_REQUIRED transitions in task_events | Harder to query; includes failed/skipped transitions |
| Env-only cap with no persistence | No audit trail |

## Consequences

- Operator inspects rework history via `agent_runs` filtered by worker_type
- Escalation policy documents the counting mechanism
- Future: consider generated enum or DB check constraint on worker_type values
