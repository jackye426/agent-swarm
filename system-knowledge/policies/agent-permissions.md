---
version: 1
affects: [src/cells/engineering/workflow.ts, src/cells/engineering/commit-guard.ts]
---

# Agent Permissions (Engineering Cell)

Rules for Claude Code and other implementation workers invoked by the engineering cell.

## What the worker may do

- Modify product source files within the task worktree
- Run test commands specified in the context packet
- Create migrations, tests, and documentation required by the contract

## What the worker must not do

- Modify `tasks/{taskId}/contract.yaml` — contract is immutable during implementation
- Create or commit `.taskgraph*` files — these are engineering-cell internals
- Run `git commit` — the engineering cell stages, excludes, and commits
- Modify files that fall under **scope.out** areas listed in the contract
- Expand scope beyond the contract without declaring scope expansion (engineering cell tracks this flag)

## Scope enforcement

**Gap (v1):** `scope.out` in the contract is text-only. There is no runtime file-path filter during implementation. Enforcement relies on:

1. Explicit instructions in the authorized prompt (see Scope enforcement section below)
2. Independent verification flagging scope violations in the PR diff

### Scope enforcement (prompt excerpt)

Source: this section. Wired into `invokeClaudeCode` authorized prompt.

```text
SCOPE RULES:
- Only modify files required to satisfy scope.in items.
- Do NOT modify files or areas listed in scope.out.
- If a change seems necessary for scope.out, stop and note it in the implementation report instead of making the change.
- Do not modify tasks/{taskId}/contract.yaml.
- Do not create or commit .taskgraph* files.
- Do not run git commit.
```

## --dangerously-skip-permissions

Claude Code is invoked with `--dangerously-skip-permissions` because:

1. The task is already **IN_PROGRESS** — human approvals were recorded before engineering started
2. The contract may contain language that triggers Claude's built-in approval gates
3. The engineering cell wraps the plan in an **AUTHORIZATION** header stating approvals are complete

This flag skips Claude Code's interactive permission prompts. It does **not** bypass TaskGraph's state machine, verification, or commit guard.

Preconditions that must hold before invocation:

- Task status is IN_PROGRESS (or REWORK_REQUIRED → IN_PROGRESS transition completed)
- `approvals_required` roles recorded in `approval_records`
- Contract published and context packet available

See [002-skip-permissions.md](../decisions/002-skip-permissions.md).

## Commit exclusion rules

The engineering cell excludes these paths from product-repo commits (`commit-guard.ts`):

| Path pattern | Purpose |
|--------------|---------|
| `.taskgraph_impl_plan.txt` | Implementation plan fed to Claude via stdin |
| `.taskgraph-seed-scan.json` | Cached repo scan |
| `tasks/{taskId}/contract.yaml` | Task contract lives in control plane, not product repo |
| Any path containing `.taskgraph` | Catch-all for cell-internal files |

Worktree `.gitignore` entries prevent accidental staging of `.taskgraph*` and the contract file.

If excluded paths appear in a commit, the cell attempts to undo the commit and re-stage without them.
