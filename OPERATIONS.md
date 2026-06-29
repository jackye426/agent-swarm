# TaskGraph OS Operations

## Production Run Checklist

1. Create a Supabase project and apply `supabase/migrations/001_initial.sql`.
2. Confirm the migration created these physical queues:
   - `task_plan_requested`
   - `task_design_requested`
   - `task_execution_requested`
   - `task_verification_requested`
   - `task_release_requested`
   - `task_rework_requested`
3. Copy `.env.example` to `.env` and set real secrets.
4. Install and authenticate required CLIs on the scheduler host:
   - `git`
   - Claude Code CLI matching `CLAUDE_CODE_COMMAND`
   - `gh` if `GITHUB_CREATE_PR=true`
5. Run local gates:
   - `npm run typecheck`
   - `npm run validate`
   - `npm test`
6. Check the runtime connection:
   - `npm run healthcheck`
7. Start the scheduler:
   - `npm run scheduler`
8. Enqueue jobs:
   - `npm run enqueue -- task.plan.requested ./payload.json`

## Queue Payloads

Logical queue names use dotted event names in code. Physical pgmq queues use underscores.

Planning:

```json
{
  "task_id": "T-002",
  "goal": "Generate two independent implementation plans.",
  "context": "Relevant architecture and repository context."
}
```

Engineering:

```json
{
  "task_id": "T-003",
  "context": {
    "allowed_paths": ["src/**", "tests/**"],
    "notes": "Approved context packet."
  },
  "test_commands": ["npm run typecheck", "npm test", "npm run validate"]
}
```

Verification:

```json
{
  "task_id": "T-004",
  "pr_diff": "Unified diff or PR diff text.",
  "ci_output": "CI log text.",
  "commit_sha": "abcdef1234567890abcdef1234567890abcdef12",
  "source_url": "https://github.com/org/repo/actions/runs/123"
}
```

## Human Approval Gate

The Planning Cell accepts either:

```text
approved
```

or explicit approval JSON:

```json
{
  "decision": "approved",
  "approver": "Jane Owner",
  "roles": ["Product", "Engineering"]
}
```

For production runs, prefer explicit JSON so approval records are attributable.

## Failure Semantics

- The scheduler creates an `agent_runs` row before invoking a cell.
- It marks the run `complete` only after the cell finishes durable writes.
- It marks the run `failed` and leaves the queue message unacked if processing fails.
- A task can become `COMPLETE` only through the guarded transition path with evidence, CI, independent verification, and approvals.

## Current External Assumptions

- Supabase service role key is available only to trusted backend/scheduler runtime.
- Role-based Planning and Verification model calls go through OpenRouter using `OPENROUTER_API_KEY`.
- Model choices are configured per role with `MODEL_PLANNING_A`, `MODEL_PLANNING_B`, `MODEL_PLANNING_A_REVIEW`, `MODEL_PLANNING_B_REVIEW`, `MODEL_PLANNING_CONSENSUS`, `MODEL_CONTRACT_DRAFT`, `MODEL_CONTRACT_REVISION`, `MODEL_ENGINEERING_PLAN`, and `MODEL_VERIFICATION`.
- The scheduler host has filesystem permission to create git worktrees under `TASKGRAPH_WORKTREE_ROOT`.
- Claude Code and GitHub CLI authentication are managed outside the repository.
