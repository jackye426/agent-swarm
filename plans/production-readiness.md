# 24/7 Production Readiness Plan

**Overall progress:** `30%` (Line 1 proven; Phase 1 deep healthcheck complete)

**North star:** A task submitted via Telegram or GitHub reaches `COMPLETE` or a well-notified `BLOCKED` without manual intervention. Scheduler and intake stay up 24/7; credential and infrastructure failures are caught before work starts or alerted within minutes while running.

---

## TLDR

Line 1 is **proven** (T-008 COMPLETE on external repo). Line 2 intake is **built but not E2E-validated**. The gap to 24/7 production is an **ops/SRE lane**, not more feature cells.

This plan works **backward** from unattended production, incorporates everything we learned from the T-008 dogfood arc, and defines a **testing phase per layer** so we do not confuse "healthcheck passes" with "production ready."

**Relationship to other plans:**

| Plan | Scope | Status |
|------|-------|--------|
| `production-hardening.md` | Repo context, rework cap, parallel workers | ~90% — feature slices largely done |
| `telegram-github-intake.md` | Intake server | Code complete; E2E not proven |
| `postgres-checkpointer.md` | Planning crash recovery | Wired; optional via `DATABASE_URL` |
| `deep-planning-memory.md` | Product quality | **Deferred** until ops lane passes Phase 5 |
| **This plan** | Uptime, credentials, supervision, soak proof | **Active** |
| [`production-readiness-execution.md`](production-readiness-execution.md) | File/command-level task list for Phases 2–6 | **Active companion** |

---

## Lessons learned (T-008 and prior dogfood)

These failures drove platform fixes. The 24/7 plan must **prevent recurrence** or **detect early**.

### 1. Credential vs platform confusion

| Symptom | Root cause | Fix / mitigation |
|---------|------------|------------------|
| Planning stuck at `PLANNING` | OpenRouter 402 (credits) | `MODEL_VERIFICATION_MAX_TOKENS=8192`; healthcheck must probe API |
| Engineering never starts | Missing Claude CLI | Deep healthcheck: `CLAUDE_CODE_COMMAND --version` |
| Clone failures | GitHub network / token | Offline fallback when local HEAD exists; probe `gh auth status` |
| Task stuck `IN_PROGRESS` after verify | Verifier threw 402; transition never applied | `recover:verdict`; watchdog for stuck runs |
| "Platform broken" when credentials bad | Shallow healthcheck only checked env presence | Phase 1 deep probes |

**Rule for 24/7:** Every external dependency gets a **startup probe** and a **runtime re-probe** (Phase 4 watchdog).

### 2. Harness pollution (looked like agent failure, was platform bug)

| Symptom | Root cause | Fix |
|---------|------------|-----|
| AC scope failures on `.gitignore` | Harness wrote to target repo `.gitignore` | `.git/info/exclude` in `worktree-support.ts` |
| Evidence files in product commits | Staging included `tasks/*/evidence/` | Commit guard + staging filter |
| Scope-out files deleted (`package-lock.json`) | Rework commits didn't restore scope-out | `restoreScopeOutFilesBeforeCommit` with `base_sha` |
| Rework "fixed AC-3, broke AC-5" | Single-commit diff on rework branch | Cumulative branch diff in `verification-diff.ts` |
| Defect-only rework whack-a-mole | Rework prompt lacked full contract | `formatReworkContextForEngineering` |

**Rule for 24/7:** Harness regressions are **P0** — covered by `worktree-support`, `commit-guard`, `verification-diff`, `rework-context` tests (59 total).

### 3. Queue and state hygiene (looked like flaky pipeline)

| Symptom | Root cause | Fix |
|---------|------------|-----|
| Re-seed runs fail mysteriously | Stale queue messages + old evidence | `npm run reseed:hygiene -- T-NNN` |
| Jobs silently skipped | Task status mismatch (stale job guards) | Documented in `system-knowledge/operations/re-seed-and-queue-hygiene.md` |
| Polluted worktree from prior runs | Branch/worktree not cleaned | Manual delete + reseed checklist |

**Rule for 24/7:** Intake-created tasks start clean (no re-seed). For dogfood resets, **always run hygiene first**. Watchdog should detect tasks stuck in intermediate states > threshold.

### 4. Verification and evidence edge cases

| Symptom | Root cause | Fix |
|---------|------------|-----|
| BLOCKED despite PASS verdict on diff AC | Engineering evidence inconclusive | `computeEffectiveMissingEvidence` |
| BLOCKED on README AC | Diff missing from verification payload | Robust diff fallback chain |
| Executability warning on re-seed | Contract references future command (`npm run healthcheck`) | Seed `--context` alignment; warning not error |

### 5. Windows / host specifics

| Symptom | Root cause | Fix |
|---------|------------|-----|
| Claude Code fails on long plans | Args too long on Windows | Pipe plan via stdin |
| Supabase `TypeError: fetch failed` | Transient HTTPS | `retry-fetch.ts` with exponential backoff |

### 6. Process model gaps (still open)

| Gap | Impact on 24/7 |
|-----|----------------|
| Scheduler + intake are manual `npm run` | Process death = total outage |
| No startup credential gate beyond shallow healthcheck | Wasted runs, false "platform broken" |
| No runtime watchdog | Silent failure until user notices |
| Telegram alerts only on `human_notification` artifacts | Process death not alerted |
| Postgres checkpoint optional | Planning crash may restart from scratch if `DATABASE_URL` unset |

---

## Current platform inventory

### Proven (Line 1)

```text
smoke:seed [--repo] → planning (dual-plan + consensus + auto-approve)
  → engineering (worktree, Claude Code, tests, commit)
  → evidence → verification (model review + effective missing evidence)
  → COMPLETE | REWORK_REQUIRED → rework → auto re-verify → ...
```

**Evidence:** T-008 COMPLETE, contract v8, commit `c0725eb`, 59 unit tests.

### Built, not E2E-proven (Line 2)

```text
Telegram /task or GitHub issue+label
  → repo resolution → seed scan → task.plan.requested
  → [auto-dispatch] execution → verification
  → Telegram notifications via Realtime
```

**Requires:** `TASKGRAPH_AUTO_ENQUEUE_EXECUTION=true`, `TASKGRAPH_AUTO_ENQUEUE_VERIFICATION=true`, scheduler + intake both running.

### Residual risks for 24/7

| Risk | Severity | Addressed in phase |
|------|----------|-------------------|
| OpenRouter credits exhausted mid-run | High | 1 (probe), 4 (alert) |
| Scheduler process dies | High | 3 (supervisor), 4 (watchdog) |
| Supabase sustained outage | Medium | 1 + 4; retry mitigates blips |
| Stuck `IN_PROGRESS` / `VERIFYING` | Medium | 4 (watchdog), existing `recover:verdict` |
| Disk full on worktree root | Medium | 4 |
| GitHub webhook unreachable (no tunnel) | Low for Telegram-first MVP | 2 (E2E scope) |
| Parallel workers race conditions | Low | Keep `SCHEDULER_WORKERS=1` in prod v1 |

---

## Backward chain

Work from the goal backward. Do not skip layers.

```text
Phase 6  Production declaration          ← written ops contract
Phase 5  Soak + failure injection        ← 24–72h proof
Phase 4  Runtime watchdog                ← detect while running
Phase 3  Process supervision             ← restart on crash
Phase 2  Line 2 intake E2E               ← unattended happy path
Phase 1  Deep healthcheck                ← credentials before work
Phase 0  Line 1 stable                   ← DONE (T-008)
```

---

## Phase 0 — Line 1 stable ✅

**Status:** Complete (2026-07-03).

| Gate | Evidence |
|------|----------|
| External repo COMPLETE | T-008 on `jackye426/swarm-sandbox` |
| Rework loop | Scheduler auto re-verify; cumulative diff |
| Harness hygiene | worktree-support, commit-guard, scope-out restore |
| Transport resilience | Supabase retry-fetch |
| Model affordability | Verification max tokens cap |
| Unit coverage | 59 tests |

**Do not re-seed T-008.** Use T-009+ for new dogfood.

---

## Phase 1 — Deep healthcheck

**Goal:** Fail fast with actionable errors before enqueueing work.

### Probes

| Probe | When required | Pass criteria |
|-------|---------------|---------------|
| Supabase REST | always | `tasks` read + all 6 queue `pgmq_metrics` |
| OpenRouter | always | Auth check; surface 401/402 with clear message |
| Claude Code | always | `CLAUDE_CODE_COMMAND --version` or `--help` exits 0 |
| Git | always | `git --version` |
| Worktree root | always | `TASKGRAPH_WORKTREE_ROOT` exists and writable |
| GitHub | `GITHUB_TOKEN` or `GITHUB_CREATE_PR=true` | `gh auth status` or API reachability |
| Postgres checkpoint | `DATABASE_URL` set, checkpoint not disabled | Connect + `SELECT 1` |
| Telegram | intake mode (`TELEGRAM_BOT_TOKEN`) | `getMe` API call |
| Webhook secret | GitHub intake enabled | Secret present |

### Implementation

- `scripts/lib/health-probes.ts` — individual probes returning `{ name, ok, message, optional }`
- `scripts/healthcheck.ts` — orchestrator; flags `--json`, `--strict`
- `.env.example` — document probe matrix
- `OPERATIONS.md` — mandatory pre-start gate

### Testing phase

| Test | Type | Pass |
|------|------|------|
| Mocked probe unit tests | CI | Each probe success/failure path |
| Missing `OPENROUTER_API_KEY` | Manual | Exit 1, clear message |
| Invalid OpenRouter key | Manual | Exit 1, 401 message |
| Dead Claude command | Manual | Exit 1 before enqueue |
| Full probe pass | Manual | Matches live `.env` |

### Exit criteria

- [x] All T-008 postmortem credential failure modes caught at startup
- [x] Probe unit tests in CI (`tests/health-probes.test.ts`)
- [x] Documented in `OPERATIONS.md`

**Estimate:** 1–2 days — **done 2026-07-03**

---

## Phase 2 — Line 2 intake E2E

**Goal:** Prove unattended path from human input (not smoke scripts).

### Prerequisites

```env
TASKGRAPH_AUTO_ENQUEUE_EXECUTION=true
TASKGRAPH_AUTO_ENQUEUE_VERIFICATION=true
```

```powershell
npm run healthcheck    # Phase 1 must pass
npm run scheduler      # terminal 1
npm run intake         # terminal 2
```

### Test matrix

| ID | Path | Scenario | Success |
|----|------|----------|---------|
| 2a | Telegram | `/repo set jackye426/swarm-sandbox` → small `/task` | COMPLETE + stage notifications |
| 2b | GitHub | Issue + `taskgraph` label (ngrok or public host) | Task created + lifecycle |
| 2c | agent-swarm | Scoped TS task on `jackye426/agent-swarm` | COMPLETE with typecheck + test |
| 2d | Failure | Submit task with healthcheck failing (revoke OpenRouter key) | Task fails cleanly; no silent hang |

### Testing phase

| Test | Type | Pass |
|------|------|------|
| 2a Telegram E2E | Manual soak | COMPLETE without manual enqueue |
| 2b GitHub E2E | Manual | Task row + comment with T-NNN |
| 2c Real repo | Manual | Harder scope; documents failure modes |
| Notification delivery | Manual | Telegram at draft, verdict, BLOCKED |

### Exit criteria

- [ ] At least one Telegram path COMPLETE unattended
- [ ] Failures classified: platform vs credentials vs task scope
- [ ] `STATUS.md` reflects Line 2 status

**Estimate:** 1 day active testing

---

## Phase 3 — Process supervision + startup gate

**Goal:** Scheduler and intake survive crashes and reboots; never start unhealthy.

### Deliverables

- `scripts/start-production.ts` or pm2/systemd/Task Scheduler config:
  1. Run deep healthcheck (exit 1 → abort start)
  2. Start scheduler (`SCHEDULER_WORKERS=1` for prod v1)
  3. Start intake
- SIGTERM graceful shutdown (let visibility timeout release in-flight jobs)
- Log location + rotation guidance

### Host recommendation (MVP)

**Always-on Windows PC** (Claude Code already here) + **pm2** or Windows Task Scheduler with restart policy. Revisit Linux VPS when Claude Code path is validated on Linux.

### Testing phase

| Test | Type | Pass |
|------|------|------|
| Kill scheduler mid-engineering | Failure injection | Job visible again after VT; supervisor restarts |
| Kill intake | Failure injection | Scheduler continues; Telegram stops until restart |
| Reboot host | Soak prep | Both services auto-start; healthcheck runs first |
| Start with bad `.env` | Negative | Process exits; no partial start |

### Exit criteria

- [ ] Documented supervisor config in `OPERATIONS.md`
- [ ] Restart after kill -9 verified

**Estimate:** 1 day

---

## Phase 4 — Runtime watchdog

**Goal:** Detect problems while running, not only at startup.

### Checks (every 5–15 min)

| Check | On failure |
|-------|------------|
| Supabase + OpenRouter subset | Telegram alert |
| Tasks stuck `IN_PROGRESS` / `VERIFYING` > 2× `SCHEDULER_VISIBILITY_TIMEOUT_S` | Telegram alert + runbook link |
| Recent `agent_runs` with 402 / fetch failed | "Credits or network" alert |
| Queue depth > threshold on one queue | Alert |
| Free disk on `TASKGRAPH_WORKTREE_ROOT` | Alert |

### Implementation

- `scripts/watchdog.ts` — callable from cron, Task Scheduler, or pm2 cron
- Reuse Telegram `sendNotification` from intake layer (shared module)
- v1: alert only; v1.1: optional auto-fail stuck runs

### Testing phase

| Test | Type | Pass |
|------|------|------|
| Simulated Supabase outage | Failure injection | Alert within one interval |
| Leave task IN_PROGRESS artificially | Manual | Detected and surfaced |
| OpenRouter 402 in run error | Failure injection | Credit alert |

### Exit criteria

- [ ] Watchdog runs on schedule alongside supervised processes
- [ ] At least one injected failure produces Telegram alert

**Estimate:** 1–2 days

---

## Phase 5 — Soak + failure injection

**Goal:** Evidence of 24/7 readiness, not belief.

### Soak protocol (24–72 hours)

1. Supervisor running scheduler + intake + watchdog
2. Submit 2–3 small sandbox tasks over the window (staggered)
3. Log: process uptime, task outcomes, alerts received
4. No manual intervention unless alert fires

### Failure injection checklist

| Inject | Expected |
|--------|----------|
| Kill scheduler mid-engineering | Job reappears; no permanent stuck state |
| Supabase blip ~30s | Retry succeeds |
| OpenRouter 402 during verification | Run fails; task not falsely COMPLETE; alert |
| Invalid `GITHUB_TOKEN` | Engineering error artifact + notification |
| Stale queue after crash | Stale guards ack; no infinite loop |

### Exit criteria

- [ ] 24h soak with zero undetected process deaths
- [ ] All injection scenarios documented with actual behavior
- [ ] Mean time to alert on process death < 15 min

**Estimate:** ~3 days (mostly waiting)

---

## Phase 6 — Production declaration

**Goal:** Written contract for operating this for real.

### Deliverables

- [ ] `OPERATIONS.md` updated: supervisor, watchdog, secret rotation, Supabase backup
- [ ] `system-knowledge/operations/` — link soak results and escalation runbook
- [ ] Explicit **v1 out of scope:**
  - `SCHEDULER_WORKERS > 1` in production
  - Auto-deploy to production environments
  - Browser/staging verification
  - Deep planning / memory (`deep-planning-memory.md`)
  - Design / Release cells
- [ ] Human approval policy for production gates (`approval-policy.md`)

### Exit criteria

- [ ] Operator can follow docs to start, monitor, and recover without chat history

**Estimate:** 0.5 day

---

## Execution timeline

```text
Week 1   Phase 1 (healthcheck) + Phase 2 (intake E2E)
Week 2   Phase 3 (supervision) + Phase 4 (watchdog)
Week 3   Phase 5 (soak) + Phase 6 (declaration)
```

**Critical path:** Phase 2 before declaring ready. Deep healthcheck alone only protects the manual script path.

---

## Success metrics

| Metric | Target |
|--------|--------|
| Credential failures caught before enqueue | 100% of T-008 postmortem modes |
| Unattended sandbox COMPLETE rate | ≥ 80% first attempt (simple scope) |
| Undetected scheduler downtime in 24h soak | 0 |
| Mean time to Telegram alert on process death | < 15 min |
| False "platform broken" incidents from bad credentials | 0 after Phase 1 |

---

## Deferred (explicitly not in this plan)

- Deep planning / memory graph
- Design / Release cells
- Multi-host scheduler fleet
- Datadog / full APM (Telegram + logs sufficient for MVP)
- Automatic secret rotation
- Parallel workers > 1 in production
- Browser-based verification

Resume deferred work only after Phase 5 soak passes.
