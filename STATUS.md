# TaskGraph OS - Project Status

_Last updated: 2026-07-01 (session 5 — commit discipline fix)_

---

## Current State

| Layer | Status |
|-------|--------|
| Core types, schemas, state machine | Complete |
| Supabase migrations 001-004 | Complete (run in Supabase) |
| Queue RPC wrappers | Complete |
| Model router (OpenRouter) | Complete |
| Scheduler (plan/execution/verification/rework) | Complete + stale-job guards added |
| Intake server (Telegram + GitHub + notifications) | Implemented, partial E2E |
| Repo resolution + seed scan | Smoke-tested (T-004) |
| Multi-repo engineering worktrees | Dogfood-tested (T-005/T-006 on `jackye426/swarm-sandbox`) |
| Planning cell (fast path) | Smoke-tested |
| Engineering cell | **Commit guard implemented** (contract + `.taskgraph*` excluded) |
| Verification cell | Dogfood-tested T-005/T-006 |
| Rework loop | Auto-enqueued on REWORK_REQUIRED |
| Design / Release cells | Stub |

---

## Active Focus

**Commit discipline fix landed.** Engineering now unstages `tasks/{id}/contract.yaml` and `.taskgraph*` before commit, repairs Claude self-commits when needed, and writes worktree `.gitignore` on all worktree paths.

**Next:** Re-run `npm run pipeline:run -- T-007` once OpenRouter credits are topped up (T-007 seed exists; planning failed at 402 insufficient credits).

Do not start compact deep planning or memory until T-007 (or T-008) completes a clean verification pass.

---

## Session 5 — Commit discipline fix

### Code changes

| Module | Purpose |
|--------|---------|
| `src/cells/engineering/commit-guard.ts` | Path rules for excluded commit files |
| `src/cells/engineering/commit-staging.ts` | Git staging + soft/mixed reset repair |
| `src/cells/engineering/worktree-support.ts` | Contract copy + worktree `.gitignore` |
| `src/cells/engineering/workflow.ts` | Wired into `createWorktree`, `commitChanges`, Claude prompt |
| `src/cells/planning/workflow.ts` | Contract draft scope.out/in rules for contract + `.taskgraph*` |

### Tests

- `tests/commit-guard.test.ts` — path matching unit tests
- `tests/commit-staging.test.ts` — git integration: only product files staged

### T-007 dogfood

- Seeded on `jackye426/swarm-sandbox` with incremental healthcheck goal
- Pipeline blocked at planning: OpenRouter 402 (insufficient credits for `planning_b`)
- Re-run: `npm run pipeline:run -- T-007` after adding credits

## T-005 Dogfood Run — `jackye426/swarm-sandbox`

First end-to-end run against an **external empty repo**.

### What worked

| Step | Result |
|------|--------|
| Planning on `jackye426/swarm-sandbox` | Draft contract reasonable and bounded |
| Engineering on external repo | Cloned empty repo, implemented healthcheck project |
| Tests in sandbox | `npm test` passes |
| Evidence | 6 passing evidence records (E-005001–E-005006) at commit `0b09a79` |
| Verification model review | Ran; verdict **REWORK_REQUIRED** recorded |

### Edge cases fixed during the run

- Empty external repos — orphan branch when remote has no `HEAD`
- Git author identity — `TASKGRAPH_GIT_AUTHOR_NAME` / `TASKGRAPH_GIT_AUTHOR_EMAIL` for agent commits
- Existing clone with empty remote `HEAD` — fetch/reset no longer fails
- Reusing repo root when task branch already checked out
- Generated `.taskgraph*` files excluded from commits
- Zero-dependency `package.json` with no lockfile — skip `npm install`
- Verification seed reads `engineering_worktree` artifact path (not assumed local layout)

### Verification outcome (expected)

Verifier returned **REWORK_REQUIRED** with all ACs **INCONCLUSIVE** because the PR diff/CI payload could not independently prove file contents (diff quality issue, not engineering failure). Blocking defects cited missing README/package.json/healthcheck.js in the diff.

This is a **good verifier test** — it catches weak verification inputs.

### Takeover fixes (session 4)

1. **Stale queue jobs** — A leftover `task.execution.requested` re-ran while T-005 was past READY, failed tests, moved task to **BLOCKED**, then blocked verification status transition.
2. **Scheduler guards** — Execution only when `READY`; rework only when `REWORK_REQUIRED`; verification only when `AWAITING_EVIDENCE` or `VERIFYING`; stale jobs are acked.
3. **Verification transition** — Uses `transitionTaskStatusIfLegal`; saves record even if transition fails (no throw).
4. **Recovery script** — `npm run recover:verdict -- T-005` applied saved verdict `BLOCKED → REWORK_REQUIRED` and enqueued rework.

**Current T-005 status:** `REWORK_REQUIRED` (rework job enqueued, not yet processed).

---

## Completed Work (historical)

### T-001 — Contract and evidence foundation
- Status: READY · validation passes

### T-002 — Planning smoke
- AWAITING_APPROVAL with `stop_after_draft: true` · 6 planning artifacts

### T-003 — Engineering + verification smoke (local repo)
- REWORK_REQUIRED (verifier caught out-of-scope files) · contract scope tightened

### T-004 — Slice 0 repo resolution smoke
- `repo_full_name` + `seed_repo_context` confirmed

### Intake + checkpointer
- Intake server boots; Telegram/GitHub E2E partial
- Postgres checkpointer wired; `TASKGRAPH_DISABLE_POSTGRES_CHECKPOINT=true` escape hatch for local smoke

---

## Known Issues

| Issue | Notes |
|-------|-------|
| Stale queue messages | Guarded in scheduler; drain with `scheduler:once` until stale jobs ack |
| Verification diff quality | `smoke:seed:verification` diff may be empty/thin for first commit; verifier correctly returns INCONCLUSIVE |
| T-003 evidence missing | `npm run validate` fails honestly — no fake evidence |
| Contract immutability | **Fixed** — `commitChanges` unstages contract + `.taskgraph*`; worktree `.gitignore` |
| Transient network | Supabase/OpenRouter `fetch failed` on long routes; retry wrapper still useful |

---

## Script Reference

| Script | Purpose |
|--------|---------|
| `npm run smoke:seed -- T-NNN [--repo owner/repo]` | Seed planning with repo resolution |
| `npm run smoke:seed:engineering -- T-NNN` | Enqueue execution |
| `npm run smoke:seed:verification -- T-NNN` | Enqueue verification from worktree diff |
| `npm run recover:verdict -- T-NNN` | Apply saved verification verdict after failed transition |
| `npm run smoke:inspect -- T-NNN` | Full task inspection |
| `npm run scheduler:once` | One poll cycle (plan/execution/verification/rework) |
| `npm run intake` | Telegram + GitHub + notifications |

---

## Architecture (current dogfood path)

```text
resolve repo (jackye426/swarm-sandbox)
  -> seed scan -> fast planning -> auto-approve -> READY
  -> engineering (clone empty repo, worktree, Claude Code, tests, commit)
  -> AWAITING_EVIDENCE + evidence records
  -> verification (model review + verdict)
  -> REWORK_REQUIRED (rework enqueued)
```

---

## Plan Docs

| Doc | Status |
|-----|--------|
| `plans/production-hardening.md` | Slices 0-3 implemented; T-005 validates multi-repo engineering |
| `plans/deep-planning-memory.md` | Not started — wait until dogfood stable |
| `plans/postgres-checkpointer.md` | Wired; full smoke pending `DATABASE_URL` |
