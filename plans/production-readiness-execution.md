# 24/7 Production — Detailed Execution Plan

**Overall Progress:** `80%` — Phases 3–4 verified live including hard-kill and injection tests (2026-07-03); remaining: Phase 2 Telegram E2E, reboot test, dead-man stop test, Phase 5 soak

> **Fixes landed during testing (each found by a planned negative test):**
> 1. `probeOpenRouter` hit the public `/api/v1/models` endpoint, which returns 200 for any key — 401/402 detection could never fire. Now probes authenticated `/api/v1/key`. Verified: invalid key → gate exits 1 and refuses to start the scheduler.
> 2. **Cold-boot flakiness (5–7 min startup):** the gate exited on first probe failure while the network was still warming up, inflating pm2's exponential backoff. `start-gated.ts` now retries in-process (`STARTGATE_HEALTHCHECK_ATTEMPTS` × `STARTGATE_RETRY_DELAY_MS`, default 10 × 15 s) before exiting.
> 3. **Telegram alerts silently undeliverable:** any message containing a lone `_` (IN_PROGRESS, queue names, env vars) was rejected by legacy Markdown entity parsing. `src/core/notify.ts` now falls back to plain text on parse failure. Found live by the stuck-task injection test — the alert fired but never arrived.
> 4. **Lifecycle notifications never delivered (T-010 completed silently):** the artifacts table was never added to the `supabase_realtime` publication, so the Realtime watcher subscribed successfully and received nothing — ever. Fixed two ways: migration `005_realtime_notifications.sql` (run in SQL editor) enables the instant path, and `notifications.ts` gained a polling fallback (60 s cadence, 10 min lookback, deduped) so delivery no longer depends on Realtime configuration at all.

Companion to [`production-readiness.md`](production-readiness.md) — this details **how** to execute Phases 2–6 at the file/command level. The parent doc owns the strategy and lessons learned; this doc owns the task list.

**Verify Phases 3–4:** `npm run verify:phase3-4` — see [`system-knowledge/operations/phase3-4-verification.md`](../system-knowledge/operations/phase3-4-verification.md)

## TLDR

Line 1 is proven (T-008 COMPLETE) and the deep healthcheck exists. pm2 supervision + runtime watchdog are **live and verified**. Remaining to 24/7: Phase 2 Telegram E2E, manual host steps (healthchecks.io, reboot), then Phase 5 soak.

## Critical Decisions

- **Supervisor: pm2** — Node-native restart policy, log rotation via `pm2-logrotate`, boot persistence via `pm2-windows-startup`; portable to Linux VPS later.
- **Intake scope: Telegram-only v1** — long-polling needs no public URL. GitHub webhook path stays code-complete but unproven; deferred to v1.1 (needs tunnel).
- **Dead-man's switch: healthchecks.io** — watchdog pings a free check URL each cycle; a dead host is noticed from outside within minutes. Closes the "Telegram alerts die with the host" hole.
- **Prod v1 constraints (unchanged from parent plan):** `SCHEDULER_WORKERS=1`, no auto-merge/deploy, host = always-on Windows 11 PC.
- **Healthcheck gate per process** — each supervised process runs the deep healthcheck at startup and exits non-zero on failure; pm2 backoff-restarts until credentials are fixed. No process half-starts unhealthy.

## Tasks:

- [ ] 🟨 **Phase 2: Line 2 intake E2E (Telegram-only)** — pre-flight done; live Telegram runs remain

  - [x] 🟩 Pre-flight: `TASKGRAPH_AUTO_ENQUEUE_EXECUTION=true`, `TASKGRAPH_AUTO_ENQUEUE_VERIFICATION=true` set in `.env`; deep healthcheck passing (all 10 probes)
  - [x] 🟩 Stack running supervised under pm2 (scheduler + intake + watchdog)
  - [x] 🟩 **2a happy path:** T-010 via Telegram `/task` → planning → engineering → verification → **COMPLETE unattended** (2026-07-03 16:00 UTC), zero manual enqueues. Stage notifications were NOT received — root-caused to the Realtime publication gap (fix #4); COMPLETE notification redelivered via the new poller
  - [ ] 🟥 Run migration `005_realtime_notifications.sql` in the Supabase SQL editor (instant notification path; poller covers delivery meanwhile)
  - [ ] 🟥 **2d failure path:** temporarily invalidate `OPENROUTER_API_KEY`, submit a task via Telegram → task fails cleanly with a notification, no silent hang; restore key
  - [ ] 🟥 **2c harder repo (stretch):** scoped TS task on `jackye426/agent-swarm` with `npm run typecheck` + `npm test`; document failure modes if it doesn't COMPLETE
  - [ ] 🟥 Classify every failure hit: platform / credentials / task scope; file fixes or knowledge docs accordingly
  - [ ] 🟥 Update `STATUS.md` Line 2 row with evidence (task IDs, timestamps)

- [x] 🟩 **Phase 3: pm2 supervision + startup gate** — automated verification PASS; manual host steps remain

  - [x] 🟩 Graceful shutdown in `src/scheduler/index.ts`: SIGINT/SIGTERM handler — stop polling, finish (or abandon to visibility-timeout) in-flight job, exit 0
  - [x] 🟩 Graceful shutdown in `src/intake/index.ts`: `bot.stop()` + Express server close on SIGINT/SIGTERM
  - [x] 🟩 `scripts/start-gated.ts <scheduler|intake>`: run deep healthcheck (`--strict` for intake); exit 1 on failure; otherwise import and run the target service — this is what pm2 launches
  - [x] 🟩 `ecosystem.config.cjs`: apps for scheduler + intake + watchdog (`autorestart`, `exp_backoff_restart_delay`, `max_memory_restart`, log paths, `kill_timeout`)
  - [x] 🟩 pm2 installed globally; `npm run verify:phase3-4` starts all 3 apps, restarts intake + scheduler, saves process list
  - [ ] 🟨 Boot persistence: run `scripts/setup-pm2-windows.ps1` **as Administrator** (or manual steps in phase3-4-verification.md)
  - [ ] 🟨 **Test:** kill scheduler mid-engineering → job reappears after visibility timeout (deferred to Phase 5 injection)
  - [x] 🟩 **Test:** hard-kill scheduler PID (`Stop-Process -Force`) → pm2 revived through healthcheck gate in ~15 s, new PID, restart counter bumped
  - [x] 🟩 **Test:** hard-kill intake PID → pm2 revived it; scheduler untouched
  - [x] 🟩 **Test:** pm2 restart intake → online, `/health` 200
  - [x] 🟩 **Test:** pm2 restart scheduler → online
  - [ ] 🟨 **Test:** reboot host → both services auto-start, healthcheck gate runs first
  - [x] 🟩 **Test (negative):** bad `OPENROUTER_API_KEY` → gated start exits 1 with clear probe output, nothing half-starts (verified live)
  - [x] 🟩 Document supervisor lifecycle in `OPERATIONS.md` + `system-knowledge/operations/phase3-4-verification.md`

- [x] 🟩 **Phase 4: Runtime watchdog + dead-man's switch** — automated verification PASS; healthchecks.io URL + stop test remain

  - [x] 🟩 Shared notify module `src/core/notify.ts` (fetch-based, env at call time); intake `sendNotification` delegates to it — watchdog no longer needs the intake server
  - [x] 🟩 `scripts/watchdog.ts`: long-running loop, `WATCHDOG_INTERVAL_MS` (default 5 min), `--once` flag, third pm2 app; pure check logic in `scripts/lib/watchdog-checks.ts` with 8 unit tests
  - [x] 🟩 Check: Supabase reachability + OpenRouter auth (reuses `probeOpenRouter`)
  - [x] 🟩 Check: tasks stuck in `PLANNING`/`IN_PROGRESS`/`VERIFYING` > `WATCHDOG_STUCK_TASK_MS` (default 45 min) → alert with `recover:verdict` pointer
  - [x] 🟩 Check: recent `task_events` `agent_run_failed` with `402`/`fetch failed` → "credits or network" alert
  - [x] 🟩 Check: pgmq queue depth > `WATCHDOG_QUEUE_DEPTH_THRESHOLD` → alert
  - [x] 🟩 Check: free disk on `TASKGRAPH_WORKTREE_ROOT` < `WATCHDOG_MIN_FREE_DISK_GB` → alert
  - [x] 🟩 Alert dedup: `AlertDeduper` — re-alert after `WATCHDOG_REALERT_MS` (default 1h); cleared conditions re-alert immediately on return
  - [x] 🟩 Dead-man's switch: `HEALTHCHECKS_PING_URL` set in `.env` (hc-ping.com); pinged on every live cycle
  - [x] 🟩 Env + docs: `WATCHDOG_*`, `STARTGATE_*`, and `HEALTHCHECKS_PING_URL` in `.env.example`; watchdog + pm2 section in `OPERATIONS.md`
  - [x] 🟩 Live smoke: `npm run watchdog:once` against real Supabase → clean cycle
  - [x] 🟩 **Test:** artificially stuck T-999 (`IN_PROGRESS`, 1 s threshold) → alert fired AND delivered to Telegram (after Markdown-fallback fix); test row cleaned up
  - [ ] 🟨 **Test:** stop the watchdog process past the healthchecks.io grace period → external alert fires (do during Phase 5 soak)
  - [x] 🟩 **Test:** injected OpenRouter 401 (bad key) → credential alert fired and delivered

- [ ] 🟨 **Phase 5: Soak + failure injection (24–72h)** — soak started 2026-07-03 17:00 UTC; log: [`system-knowledge/operations/soak-2026-07.md`](../system-knowledge/operations/soak-2026-07.md)

  - [x] 🟩 Start soak: pm2 running scheduler + intake + watchdog; start time recorded (2026-07-03 17:00 UTC)
  - [ ] 🟥 Submit 2–3 staggered sandbox tasks via Telegram over the window (T-011+); no manual intervention unless an alert fires
  - [ ] 🟥 Injection: kill scheduler mid-engineering (while a T-011+ run is active) → job reappears, no permanent stuck state
  - [ ] 🟨 Injection: ~30s network interruption → covered by retry-fetch unit tests; live variant optional during soak
  - [ ] 🟨 Injection: OpenRouter 402 during verification → analog proven (401 gate + watchdog alerts); live variant optional
  - [ ] 🟥 Injection: invalid `GITHUB_TOKEN` → engineering error artifact + notification
  - [x] 🟩 Injection: stale queue messages after crash → stale guards ack (T-008 arc + unit tests, prior evidence)
  - [ ] 🟨 Injection: dead-man's switch — watchdog stopped 17:01 UTC, auto-restart ~17:26; confirm healthchecks.io external alert (fires only if check period + grace < 25 min)
  - [x] 🟩 Soak log created with injection matrix, uptime log, and no-intervention rules
  - [ ] 🟥 Exit gate: 24h+ with zero undetected process deaths; mean time-to-alert on process death < 15 min

- [ ] 🟨 **Phase 6: Production declaration** — docs done; declaration gated on soak exit

  - [x] 🟩 `OPERATIONS.md`: pm2 lifecycle + symptom-first recovery runbook + secret rotation + Supabase backup
  - [x] 🟩 `system-knowledge/operations/soak-2026-07.md` created; escalation policy exists (`system-knowledge/policies/escalation-policy.md`)
  - [x] 🟩 Explicit v1 in/out-of-scope declaration in `OPERATIONS.md`
  - [x] 🟩 Human approval policy (`system-knowledge/policies/approval-policy.md`)
  - [ ] 🟥 Verify an operator can start, monitor, and recover using only the docs (no chat history)
  - [ ] 🟥 After soak exit gate passes: flip `STATUS.md` "24/7 production" milestone to Done with evidence links
