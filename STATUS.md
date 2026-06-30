# TaskGraph OS — Project Status

_Last updated: 2026-06-30 (session 2)_

---

## Current State

| Layer | Status |
|-------|--------|
| Core types, schemas, state machine | Complete |
| Supabase migrations (001, 002) | Complete |
| Queue RPC wrappers | Complete |
| Model router (OpenRouter) | Complete |
| Scheduler (poll + --once) | Complete |
| Planning cell workflow | **Smoke-tested ✓** (auto-approve wired, pending DATABASE_URL smoke test) |
| LangGraph interrupt/resume | **Proven ✓** (MemorySaver) |
| Engineering cell workflow | **Smoke-tested ✓** (T-003) |
| Verification cell workflow | **Smoke-tested ✓** (T-003) |
| LangGraph Postgres checkpointer | **Wired ✓** (pending DATABASE_URL + smoke test) |
| Design cell | Stub (not implemented) |
| Release cell | Stub (not implemented) |

---

## Completed Work

### Repository
- Pushed to [github.com/jackye426/agent-swarm](https://github.com/jackye426/agent-swarm) — initial commit on `main`
- `.env` excluded; secrets never committed

### T-001 — Task contract and evidence system
- Status: **READY**
- 6 acceptance criteria, 6 evidence records (E-001 – E-006)
- `npm run validate` passes · `npm test` passes · `npm run typecheck` passes

### Planning cell smoke test (T-002)
- Status: **AWAITING_APPROVAL** (correct — `stop_after_draft: true`)
- All 6 artifacts produced: plan_a, plan_b, a_review_of_b, b_review_of_a, consensus, draft_contract

### LangGraph Postgres checkpointer + auto-approve (implemented, pending smoke test)
- `@langchain/langgraph-checkpoint-postgres@0.0.5` installed (compatible with our `@langchain/core@0.3.x`)
- `humanApprovalGate` + `reviseContract` nodes removed from planning workflow
- `autoApproveContract` node added: records `human_notification` artifact (Telegram hook), publishes contract, records approvals, transitions to READY
- `getPlanningWorkflow()` lazy factory: uses `PostgresSaver` if `DATABASE_URL` set, falls back to `MemorySaver`
- Scheduler passes `{ configurable: { thread_id: agentRunId } }` to `planningWorkflow.invoke()`
- Migration `003_paused_status.sql` written + run in Supabase
- Smoke test pending: needs `DATABASE_URL` password (Supabase direct connection, port 5432)
- Expected result: T-002 ends at READY with `human_notification` + `approved_contract` artifacts

### Engineering + Verification cell smoke test (T-003)
- Task: Add GitHub Actions CI workflow (`.github/workflows/ci.yml`)
- Engineering run: **complete** — typecheck ✓, 9/9 unit tests ✓, commit made ✓
- Verification run: **complete** — all 5 ACs PASS ✓
- Final status: **REWORK_REQUIRED** (correct — out-of-scope files committed; `.taskgraph_impl_plan.txt` now gitignored, contract scope updated)
- Verification correctly identified scope violation without missing any criterion

### LangGraph interrupt/resume (`npm run smoke:test:interrupt`)
- **Passes** — synthetic two-node graph with `MemorySaver`

---

## Bugs Fixed (Full History)

| # | Cell | File | Bug | Fix |
|---|------|------|-----|-----|
| 1 | Planning | `cells/planning/workflow.ts` | `draftContract` used as both LangGraph state channel and node name | Renamed node to `generateDraftContract` |
| 2 | Planning | `core/model-router.ts` | Claude Opus wraps JSON in markdown fences despite `json_object` mode | Strip fences after receiving content |
| 3 | Planning | `scheduler/index.ts` | Workflow errors stored in `state.error` but never surfaced | Capture `invoke()` return, throw if `.error` set |
| 4 | Planning | `cells/planning/workflow.ts` | Contract prompt produced wrong field shapes | Explicit JSON skeleton in system prompt |
| 5 | Engineering | `cells/engineering/workflow.ts` | `claude` is a `.ps1` on Windows; `execFile` can't run it | Use `runShellCommand` (wraps in `powershell.exe`) |
| 6 | Engineering | `cells/engineering/workflow.ts` | Claude Code stopped at approval gate in T-002 contract | Prepend authorization header to plan prompt |
| 7 | Engineering | `cells/engineering/workflow.ts` | `\|\|` invalid in PowerShell 5.1 in `installDependencies` | Split into sequential TypeScript calls |
| 8 | Engineering | `cells/engineering/workflow.ts` | Worktree has no `node_modules` | Added `installDependencies` node (`npm ci`) |
| 9 | Engineering | `cells/engineering/workflow.ts` | `validate-contract.ts` fails — no `contract.yaml` in worktree | `createWorktree` writes contract as YAML before anything else |
| 10 | Engineering | `.env` + `workflow.ts` | `TASKGRAPH_DEFAULT_TEST_COMMANDS` env var included `validate` | Removed `npm run validate` — it's a repo CI gate, not a per-task test |
| 11 | Engineering | `cells/engineering/workflow.ts` | Changes never committed; verification diff was empty | Added `commitChanges` node between `runTests` and `createPullRequest` |
| 12 | All | `.gitignore` | `.taskgraph_impl_plan.txt` swept up by `git add -A` | Added to `.gitignore` |

---

## Known Issues / Next Steps

### 1. Planning cell Postgres checkpointer smoke test
All code is wired. Blocked on `DATABASE_URL` password (Supabase Settings → Database → Reset database password — safe, no data loss).

Once unblocked:
1. Add password to `DATABASE_URL` in `.env`
2. `npm run smoke:seed -- T-002` (resets T-002 to DRAFT, enqueues full pipeline)
3. `npm run scheduler:once`
4. Expect T-002 → READY, `human_notification` + `approved_contract` artifacts written

### 2. Contract scope — evidence directory
Future task contracts should explicitly include `tasks/{taskId}/evidence/` in scope.
Claude Code naturally creates evidence files; without this the verifier flags them as out-of-scope.

### 3. Contract YAML immutability
Claude Code updated `tasks/T-003/contract.yaml` status field to `DONE`.
`commitChanges` should exclude the contract file from `git add` or the authorization prompt should say not to modify it.

### 4. Transient network errors (Bali → EU → US routing)
Two runs hit `ECONNRESET` / `fetch failed` during Supabase writes or OpenRouter calls.
Retry mechanism (visibility timeout) works but adds latency. A retry wrapper around `recordArtifact` and OpenRouter calls would improve robustness.

---

## Script Reference

| Script | Purpose |
|--------|---------|
| `npm run smoke:seed -- T-002` | Seed planning job |
| `npm run smoke:seed:engineering -- T-002` | Promote T-002 to READY, enqueue execution |
| `npm run smoke:reset:engineering -- T-NNN` | Drain stale messages, reset to READY, re-enqueue |
| `npm run seed:t003` | Seed T-003 directly to READY (skips planning) |
| `npm run smoke:seed:verification -- T-NNN` | Enqueue verification with real diff + CI output |
| `npm run smoke:inspect -- T-NNN` | Show task, runs, artifacts, evidence, verification |
| `npm run smoke:test:interrupt` | MemorySaver interrupt/resume proof (no API calls) |
| `npm run scheduler:once` | Process one round of all queues |
| `npm run scheduler` | Continuous poll loop |
| `npm run validate` | Contract + evidence schema validation |
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript check |

---

## Architecture Quick Reference

```
Queue job arrives
      │
  Scheduler polls (src/scheduler/index.ts)
      │
  Creates agent_run record in Supabase
      │
  Dispatches to cell workflow (LangGraph)
      │
  Planning     ──▶  plan_a + plan_b (parallel) → peer reviews → consensus → draft contract
  Engineering  ──▶  context packet → git worktree → npm ci → plan → Claude Code
                    → tests (typecheck + npm test) → commit → PR deferred → evidence records
  Verification ──▶  read contract + diff + CI output → model review → criterion verdicts → verdict
      │
  Cell writes status transition + artifacts to Supabase
      │
  Scheduler: completeAgentRun + ack  (success)
             failAgentRun            (error — message re-queues after visibility timeout)
```

Source of truth: **Supabase Postgres** (not LangGraph checkpoints).
