# TaskGraph OS — Project Status

_Last updated: 2026-06-29_

---

## Current State

| Layer | Status |
|-------|--------|
| Core types, schemas, state machine | Complete |
| Supabase migrations (001, 002) | Complete |
| Queue RPC wrappers | Complete |
| Model router (OpenRouter) | Complete |
| Scheduler (poll + --once) | Complete |
| Planning cell workflow | Complete (smoke-tested) |
| Engineering cell workflow | Implemented, not yet smoke-tested |
| Verification cell workflow | Implemented, not yet smoke-tested |
| Design cell | Stub (not implemented) |
| Release cell | Stub (not implemented) |

---

## Completed Work

### T-001 — Task contract and evidence system
- Status: **READY**
- All 6 acceptance criteria defined; 6 evidence records (E-001 – E-006) written
- `npm run validate` passes (contract schema + evidence schema + cross-validation)
- `npm test` passes
- `npm run typecheck` passes

### Planning cell smoke test (T-002)
- Status: **AWAITING_APPROVAL** (correct — `stop_after_draft: true`)
- Agent run: **complete**
- Artifacts produced: planning_plan_a, planning_plan_b, planning_a_review_of_b, planning_b_review_of_a, planning_consensus, draft_contract

**Bugs fixed during smoke test:**

1. **LangGraph node/channel name collision** (`workflow.ts:340`)
   - `draftContract` was registered as both a state channel and a node name
   - Fixed: renamed node to `generateDraftContract`

2. **Claude returns markdown-fenced JSON** (`model-router.ts`)
   - Claude Opus ignores `response_format: { type: "json_object" }` via OpenRouter and wraps output in ` ```json ``` `
   - Fixed: strip markdown fences in `invokeRoleModel` for all `json_object` calls

3. **Scheduler marks workflow errors as success** (`scheduler/index.ts`)
   - `planningWorkflow.invoke()` return value was ignored; `state.error` never surfaced
   - Fixed: capture return value, throw if `planResult.error` is set → triggers `failAgentRun`

4. **Contract prompt produced wrong field shapes** (`workflow.ts` `draftContract` node)
   - Model invented `owner.author/implementer`, object-typed `rollback` and `approvals_required`, extra `id` field on risks
   - Fixed: replaced open-ended description with explicit JSON skeleton specifying exact field names and types

---

## To Do

### Next — Engineering cell smoke test
Prerequisites (one-time setup):
```powershell
git init; git add -A; git commit -m "init"   # make the project a git repo
mkdir C:\tmp\taskgraph-os                     # or set TASKGRAPH_WORKTREE_ROOT
```
Run sequence:
```powershell
npm run smoke:seed:engineering -- T-002      # promote to READY, enqueue execution
npm run scheduler:once                        # runs engineering cell
npm run smoke:inspect -- T-002               # check artifacts + evidence
```
Assert: task at `AWAITING_EVIDENCE`, artifacts include `implementation_report` + `test_report`, evidence records exist.

### After engineering — Verification cell smoke test
```powershell
npm run smoke:seed:verification -- T-002     # reads worktree diff + test_report, enqueues verification
npm run scheduler:once                        # runs verification cell
npm run smoke:inspect -- T-002               # check verification records + verdict
```
Assert: `verification_records` row exists, task at `COMPLETE` or `REWORK_REQUIRED`.

### LangGraph interrupt wiring (approval gate) — ready to implement
The interrupt/resume mechanism is proven (`npm run smoke:test:interrupt` passes).
To wire into the real planning cell:
1. Install `@langchain/langgraph-checkpoint-postgres`
2. Get Supabase direct Postgres connection string (Settings > Database in Supabase dashboard)
3. Add `DATABASE_URL` to `.env` and `.env.example`
4. Compile `planningWorkflow` with `PostgresSaver` instead of nothing
5. Pass `{ configurable: { thread_id: agentRunId } }` to all `invoke()` calls
6. Store thread_id on the task record (add a `langgraph_thread_id` column or use task metadata)
7. Expose an `npm run approve -- T-002` script that calls `invoke(new Command({ resume: ... }), config)`

### Known gaps
- No UI or dashboard — task state is only visible via `smoke:inspect` or direct Supabase queries
- No alerting when a run fails
- `GITHUB_CREATE_PR` defaults to `false` — real PR creation is untested end-to-end
- `task.design.requested` and `task.release.requested` queue handlers throw (not implemented)

---

## How to Run the Smoke Test

```powershell
# 1. Seed a task and enqueue a planning job
npm run smoke:seed -- T-002

# 2. Process one queue poll cycle
npm run scheduler:once

# 3. Inspect the result
npm run smoke:inspect -- T-002
```

Expected result: task status = `AWAITING_APPROVAL`, one complete agent run, 6 artifacts.

---

## Architecture Quick Reference

```
Queue job arrives
      │
  Scheduler polls (scheduler/index.ts)
      │
  Creates agent_run record
      │
  Dispatches to cell workflow (LangGraph)
      │
  Planning ──▶ dual plans → peer reviews → consensus → draft contract
  Engineering ▶ worktree → Claude Code → tests → PR → evidence
  Verification ▶ read contract+evidence → model review → criterion verdicts
      │
  Cell updates task status in Supabase
  Cell stores artifacts in Supabase
      │
  Scheduler: completeAgentRun / failAgentRun
  Scheduler: ack message (on success only)
```

Source of truth: **Supabase Postgres** (not LangGraph checkpoints).
