# Feature Implementation Plan: LangGraph Postgres Checkpointer

**Overall Progress:** `80%`

## TLDR
Wire the `@langchain/langgraph-checkpoint-postgres` checkpointer into the planning cell for crash recovery on long runs. Replace the blocking `humanApprovalGate` (interrupt) with an autonomous `autoApproveContract` node that records a notification artifact and self-approves. The `reviseContract` loop is removed — no human feedback means nothing to iterate on. Add `paused` to the `agent_run_status` enum for future Telegram escalation.

## Critical Decisions
- **Auto-approve over interrupt** — planning already runs 5 rounds of model review; a 6th reviewer is redundant. Real quality gate is the verification cell.
- **Remove reviseContract loop** — it exists for human feedback iteration; without a human in the loop it has no trigger.
- **Checkpointer still wired** — provides crash recovery on the 6-node planning run even without `interrupt()`. If the process crashes mid-run, the scheduler resumes from the last checkpoint instead of restarting.
- **thread_id = agentRunId** — already a UUID, already stored in `agent_runs`, no new column needed.
- **Ack on interrupt detection** — if `interrupt()` is ever triggered (future escalation path), ack the queue immediately; durable state lives in the checkpointer, not the queue.
- **`paused` status added now** — enum value reserved for future Telegram escalation; not used in this implementation.

## Tasks

- [x] 🟩 **Step 1: Install dependency + env**
  - [x] 🟩 `npm install @langchain/langgraph-checkpoint-postgres@0.0.5` (1.x incompatible with our @langchain/core@0.3.x)
  - [x] 🟩 Add `DATABASE_URL` placeholder to `.env.example`

- [x] 🟩 **Step 2: Migration — add `paused` to agent_run_status enum**
  - [x] 🟩 Created `supabase/migrations/003_paused_status.sql`
  - [ ] 🟥 Run migration against Supabase (copy-paste SQL in dashboard → SQL editor)

- [x] 🟩 **Step 3: Rewrite planning workflow**
  - [x] 🟩 Removed `humanApprovalGate`, `reviseContract`, `publishContract` nodes
  - [x] 🟩 Removed `humanFeedback`, `approval`, `approvedContract` state channels
  - [x] 🟩 Added `autoApproveContract` node: records `human_notification` artifact, publishes contract, records approvals, transitions to `READY`
  - [x] 🟩 Rewired graph: `generateDraftContract` → `autoApproveContract` → `__end__`
  - [x] 🟩 Lazy `getPlanningWorkflow()` factory: uses `PostgresSaver` if `DATABASE_URL` set, falls back to `MemorySaver`

- [x] 🟩 **Step 4: Wire checkpointer in scheduler**
  - [x] 🟩 Import `getPlanningWorkflow` (replaces static `planningWorkflow` export)
  - [x] 🟩 Pass `{ configurable: { thread_id: agentRunId } }` to `planningWorkflow.invoke()`
  - [x] 🟩 Interrupt branch removed — `autoApproveContract` never interrupts; future escalation path wires here

- [ ] 🟥 **Step 5: Smoke test**
  - [ ] 🟥 Reset T-002 to DRAFT, re-seed planning job (`npm run smoke:seed -- T-002`)
  - [ ] 🟥 Run `npm run scheduler:once` — expect T-002 → READY (not AWAITING_APPROVAL)
  - [ ] 🟥 Inspect artifacts: `human_notification` artifact exists, `approved_contract` artifact exists
  - [ ] 🟥 Update STATUS.md and memory
