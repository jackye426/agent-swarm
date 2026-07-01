# Feature Implementation Plan: Minimal Production Hardening

**Overall Progress:** `90%` (Slices 0–4 implemented; Slice 0 planning smoke passed)

## TLDR
Keep production hardening focused on the runtime pieces that make the next task safer and better. Do not implement the full autonomous-dev-team stack at once.

The immediate goal is Slice 0:

```text
resolve repo
  -> store repo/source context on task
  -> seed-scan repo
  -> pass context into existing planning
```

This grounds planning in a real repo without changing the current fast planning/engineering/verification pipeline.

## Simplification Rule

Add a layer only if it directly improves one of these:
- the planner knows which repo it is working on;
- the planner sees enough repo context to avoid hallucinating architecture;
- engineering can operate on the right repo;
- verification/rework cannot loop forever.

Everything else is deferred.

## Current Shared Lifecycle

V1 should be:

```text
intake
  -> repo resolution
  -> create task with repo/source context
  -> seed codebase context
  -> existing fast planning
  -> engineering
  -> verification
```

Then add:

```text
optional compact deep planning
  -> rework cap
  -> short lesson memory
```

Live browser/staging verification, web research, parallel workers, and auto-spawned roadmaps are later.

## Critical Decisions

- **Repo resolution is required before planning** for Telegram/manual intake.
- **Repo resolution order:** `--repo flag > GitHub webhook payload > Telegram chat binding > TASKGRAPH_DEFAULT_REPO env > ask`.
- **Telegram repo clarification happens before task creation**.
- **Product clarification happens later in planning**, not in Slice 0.
- **New repo creation is manual for MVP**.
- **Seed codebase context is enough for now** - deeper repo memory comes later.
- **Notifications remain artifact-driven** through `human_notification`.
- **Rework cap is important, but it is not Slice 0**.
- **Parallel workers are deferred** until single-worker behavior is solid.

## Slice 0 Scope

Slice 0 includes only:
- repo/source fields on tasks;
- Telegram `/repo set`, `/repo current`, and `/task --repo`;
- GitHub issue intake stores repo context;
- seed repo scanner;
- seed context passed into planning;
- smoke scripts support repo resolution.

Slice 0 does not include:
- memory table;
- deep planning graph;
- research artifacts;
- rework loop;
- dependency enforcement;
- multi-repo engineering worktrees;
- parallel scheduler workers.

## Tasks

- [x] **Step 1: DB migration - repo fields + chat bindings**
  - [x] `supabase/migrations/004_multi_repo.sql`:
    - `ALTER TABLE tasks ADD COLUMN repo_url text`
    - `ALTER TABLE tasks ADD COLUMN repo_full_name text`
    - `ALTER TABLE tasks ADD COLUMN source text`
    - `ALTER TABLE tasks ADD COLUMN source_context jsonb`
    - `CREATE TABLE chat_repo_bindings (...)`
  - [ ] Run migration in Supabase SQL editor.

- [x] **Step 2: Repo resolution + Telegram commands**
  - [x] `getChatRepoBinding(chatId)` and `setChatRepoBinding(chatId, repoFullName)`.
  - [x] `/repo set owner/repo`.
  - [x] `/repo current`.
  - [x] `/task ... --repo owner/repo`.
  - [x] Resolution chain: flag -> GitHub payload -> chat binding -> env -> ask.
  - [x] Add `TASKGRAPH_DEFAULT_REPO` to `.env.example`.

- [x] **Step 3: Task creation carries repo/source context**
  - [x] Task creator accepts repo and source context.
  - [x] Store repo/source fields on the task row.
  - [x] GitHub webhook sets repo/source context from payload.
  - [x] Smoke planning script can resolve repo via `--repo` or local git fallback.

- [x] **Step 4: Seed codebase context**
  - [x] `repo-scanner.ts` captures:
    - top-level file tree;
    - README excerpt;
    - package/project manifest;
    - detected test commands;
    - recent commits.
  - [x] Task creator runs scanner after repo resolution.
  - [x] Planning payload includes seed context.
  - [x] Seed context stored as context packet/artifact.
  - [x] `REPO_CACHE_MAX_AGE_MS` added.

- [ ] **Step 5: Slice 0 verification**
  - [x] Run typecheck/tests.
  - [x] Smoke seed planning with `--repo`.
  - [ ] Confirm `tasks.repo_full_name` is stored.
  - [x] Confirm seed context appears as `seed_repo_context` artifact.
  - [ ] Confirm Telegram `/repo current` and `/task --repo` behavior.
  - [ ] Confirm GitHub webhook path still creates tasks.

## Next Small Slices

Do these only after Slice 0 is verified.

### Slice 1: Multi-Repo Engineering Worktrees ✅

- [x] `getTaskRepo(taskId)` in `db/records.ts`.
- [x] `resolveRepoRoot` node in engineering workflow — clones external repo if needed, falls back to CWD.
- [x] `createWorktree` uses `state.repoRoot` as the git CWD.
- [x] `GITHUB_TOKEN` in `.env.example`.

### Slice 2: Rework Cap ✅

- [x] `getReworkAttemptCount(taskId)` in `db/records.ts` (counts `agent_runs` with `worker_type='rework-cell'`).
- [x] `publishVerificationRecord` checks cap before transitioning — escalates to `BLOCKED` at cap.
- [x] Auto-enqueues `task.rework.requested` with defects when under cap.
- [x] `human_notification` artifact written on escalation → Realtime → Telegram.
- [x] `TASKGRAPH_MAX_REWORK_ATTEMPTS=3` in `.env.example`.

### Slice 3: Dependency Enforcement ✅

- [x] Scheduler checks `dependenciesComplete()` before `task.execution.requested` and `task.rework.requested`.
- [x] Returns `"skip"` signal — message is NOT acked, becomes visible again after visibility timeout.

### Slice 4: Parallel Workers ✅

- [x] `SCHEDULER_WORKERS` env var (default 1).
- [x] `run()` spawns N concurrent `poll()` loops via `Promise.all`.
- [x] pgmq visibility timeout prevents double-processing across workers.

### Slice 5: Compact Deep Planning
Implemented from `plans/deep-planning-memory.md`.

- [ ] Mode router.
- [ ] Three-pass deep path.
- [ ] Optional explicit clarification.

### Slice 6: Simple Memory
Only after deep planning exists.

- [ ] Minimal `memory_items` table.
- [ ] Small retrieval packet.
- [ ] Short lesson writeback.

## Deferred

- Web/docs research.
- Embedding memory search.
- Auto-created roadmap task rows.
- Dedicated planning artifact table.
- Automatic new repo creation.
- Browser/staging verification.

## Success Criteria For Slice 0

- Every new Telegram/GitHub/manual planning task can resolve one repo.
- Repo/source context is persisted on `tasks`.
- Planning receives useful seed repo context.
- Existing fast planning still works.
- No deep-planning machinery is required for Slice 0 to be useful.
