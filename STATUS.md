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
| Planning cell workflow | **Smoke-tested ✓** |
| LangGraph interrupt/resume | **Proven ✓** (MemorySaver) |
| Engineering cell workflow | Implemented — ready to smoke-test |
| Verification cell workflow | Implemented — ready to smoke-test |
| LangGraph approval gate (Postgres checkpointer) | Not yet wired |
| Design cell | Stub (not implemented) |
| Release cell | Stub (not implemented) |

---

## Completed Work

### Repository
- Pushed to [github.com/jackye426/agent-swarm](https://github.com/jackye426/agent-swarm) — 45 files, initial commit on `main`
- `.env` excluded; secrets never committed

### T-001 — Task contract and evidence system
- Status: **READY**
- 6 acceptance criteria, 6 evidence records (E-001 – E-006)
- `npm run validate` passes · `npm test` passes · `npm run typecheck` passes

### Planning cell smoke test (T-002)
- Status: **AWAITING_APPROVAL**
- All 6 artifacts produced: plan_a, plan_b, a_review_of_b, b_review_of_a, consensus, draft_contract
- Took 3 iterations to pass — bugs found and fixed (see below)

### LangGraph interrupt/resume (`npm run smoke:test:interrupt`)
- **Passes** — synthetic two-node graph with `MemorySaver`
- Proves: `interrupt()` pauses graph, `Command({ resume })` continues it, resume value received
- No API calls, instant

### Bugs fixed

| # | File | Bug | Fix |
|---|------|-----|-----|
| 1 | `cells/planning/workflow.ts` | `draftContract` used as both LangGraph state channel and node name | Renamed node to `generateDraftContract` |
| 2 | `core/model-router.ts` | Claude Opus wraps JSON in markdown fences despite `json_object` mode | Strip fences in `invokeRoleModel` for all `json_object` responses |
| 3 | `scheduler/index.ts` | Workflow errors stored in `state.error` but never surfaced; all runs marked complete | Capture `invoke()` return, throw if `.error` set — triggers `failAgentRun` |
| 4 | `cells/planning/workflow.ts` | Open-ended contract prompt caused model to invent wrong field shapes | Replaced with explicit JSON skeleton with exact field names and types |

---

## Next Steps

### 1. Engineering cell smoke test

One remaining prerequisite:
```powershell
mkdir C:\tmp\taskgraph-os   # worktree root (already a git repo from the push)
```

Run sequence:
```powershell
npm run smoke:seed:engineering -- T-002   # publish contract, record approvals, READY, enqueue
npm run scheduler:once                     # engineering cell: worktree → Claude Code → tests → evidence
npm run smoke:inspect -- T-002            # check artifacts, evidence records, task status
```

Pass criteria: task at `AWAITING_EVIDENCE` · artifacts include `implementation_report` + `test_report` · evidence records exist in Supabase.

### 2. Verification cell smoke test

Immediately after engineering passes:
```powershell
npm run smoke:seed:verification -- T-002  # reads worktree diff + test_report, enqueues verification
npm run scheduler:once                     # verification cell: model review → criterion verdicts → verdict
npm run smoke:inspect -- T-002            # check verification_records, final verdict
```

Pass criteria: `verification_records` row exists · task at `COMPLETE` or `REWORK_REQUIRED`.

### 3. LangGraph approval gate wiring

Interrupt/resume is proven. What's left to implement:

1. `npm install @langchain/langgraph-checkpoint-postgres`
2. Get Supabase direct Postgres connection string (dashboard → Settings → Database)
3. Add `DATABASE_URL` to `.env` + `.env.example`
4. Compile `planningWorkflow` with `PostgresSaver` (replaces `graph.compile()`)
5. Pass `{ configurable: { thread_id: agentRunId } }` to every `invoke()` call
6. Add a `langgraph_thread_id` column to `tasks` (or store in metadata) so the approval script can find the thread
7. Write `scripts/approve-task.ts` — calls `invoke(new Command({ resume: input }), config)` and handles the transition to READY

### 4. Full end-to-end

Once 1–3 are done: run a fresh task from DRAFT all the way to COMPLETE through the live approval gate. Target task: T-003 (TBD).

---

## Known Gaps

- No UI — task state visible only via `smoke:inspect` or direct Supabase queries
- No alerting when an agent run fails
- `GITHUB_CREATE_PR=false` — PR creation deferred, untested end-to-end
- `task.design.requested` and `task.release.requested` queue handlers not implemented (throw)
- Engineering cell error path doesn't transition task to BLOCKED — task stays IN_PROGRESS on failure

---

## Script Reference

| Script | Purpose |
|--------|---------|
| `npm run smoke:seed -- T-002` | Seed planning job |
| `npm run smoke:seed:engineering -- T-002` | Promote to READY, enqueue execution |
| `npm run smoke:seed:verification -- T-002` | Enqueue verification with real diff + CI output |
| `npm run smoke:inspect -- T-002` | Show task, runs, artifacts, evidence, verification |
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
  Engineering  ──▶  context packet → git worktree → Claude Code → tests → PR → evidence records
  Verification ──▶  read contract + evidence → model review → criterion verdicts → task verdict
      │
  Cell writes status transition + artifacts to Supabase
      │
  Scheduler: completeAgentRun + ack  (success)
             failAgentRun            (error — message re-queues after visibility timeout)
```

Source of truth: **Supabase Postgres** (not LangGraph checkpoints).
