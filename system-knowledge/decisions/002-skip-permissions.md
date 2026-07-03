---
status: accepted
date: 2026-07-03
task_id: T-003
---

# ADR 002: Claude Code --dangerously-skip-permissions

## Context

Claude Code prompts interactive approval when it detects sensitive operations or approval-gate language in the input. Task contracts often contain phrases like "requires human approval" or scope constraints that trigger false stops mid-implementation.

## Decision

Invoke Claude Code with `--dangerously-skip-permissions` when fed the implementation plan via stdin pipe. Wrap the plan in an AUTHORIZATION header stating the task is IN_PROGRESS and approvals are recorded.

## Authorization preconditions

Must be true before invocation:

1. Task transitioned to IN_PROGRESS by scheduler (not DRAFT/READY)
2. `approval_records` exist for required roles
3. Engineering cell owns git commit — worker must not commit

## What it does not bypass

- TaskGraph state machine transitions
- Commit exclusion guard (`commit-guard.ts`)
- Independent verification cell review
- Test command execution and evidence collection

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Strip approval language from contract | Loses important constraints for the model |
| Human-in-loop per file edit | Defeats automation goal |
| Different worker without permission gates | Claude Code is the v1 implementation worker |

## Consequences

- Operator must trust the approval preconditions are enforced upstream
- Windows requires stdin pipe (not embedding plan in `--print` args) due to shell length limits
- Documented in agent-permissions.md for audit
