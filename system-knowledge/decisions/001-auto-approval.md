---
status: accepted
date: 2026-07-03
task_id: T-002
---

# ADR 001: Planning Cell Auto-Approval

## Context

TaskGraph OS v1 dogfood needs to run planning → engineering → verification without a human sitting at an interrupt gate. The original planning graph had a `humanApprovalGate` LangGraph interrupt that blocked until explicit approval.

## Decision

Replace the human interrupt with `autoApproveContract`: after multi-agent review and executability validation, the planning cell self-approves, records approvals, and transitions to READY.

## Conditions

Auto-approval holds when:

- Plan A / Plan B / review / consensus pipeline completed
- Executability validation passes (no errors; warnings allowed for forward-looking commands)
- Contract revision loop failed to fix errors → task stays AWAITING_APPROVAL instead

## Alternatives considered

| Alternative | Why rejected for v1 |
|-------------|---------------------|
| Keep LangGraph interrupt | Blocks unattended pipeline; requires Telegram wiring before any dogfood |
| Skip approval records entirely | Breaks COMPLETE guard and audit trail |
| Require human for every task | Too slow for iterative dogfood on T-008 |

## Consequences

- All `approvals_required` roles satisfied by `planning-cell-auto-approver`
- Production must add real human gates for privacy/security/release (see approval-policy.md)
- `human_notification` artifact written on auto-approve for Telegram visibility
- Future: wire interrupt back for high-risk categories only
