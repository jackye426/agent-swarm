# 24/7 Production — Detailed Execution Plan

**Overall Progress:** `75%` — Phases 3–4 automated verification **PASS** (2026-07-03); manual host steps remain (healthchecks.io URL, admin pm2-startup, reboot test)

> **Fix landed during Phase 3 negative testing:** `probeOpenRouter` hit the public `/api/v1/models` endpoint, which returns 200 for any key — the 401/402 detection could never fire, silently defeating the healthcheck's core purpose. Now probes authenticated `/api/v1/key`. Verified: invalid key → gate exits 1 and refuses to start the scheduler.

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
  - [ ] 🟥 Start `npm run scheduler` (terminal 1) + `npm run intake` (terminal 2) — or use `pm2 start ecosystem.config.cjs`
  - [ ] 🟥 **2a happy path:** Telegram `/repo set jackye426/swarm-sandbox` → `/task` (small scoped goal, T-009) → COMPLETE with zero manual enqueue; capture stage notifications received
  - [ ] 🟥 **2d failure path:** temporarily invalidate `OPENROUTER_API_KEY`, submit T-010 via Telegram → task fails cleanly with a notification, no silent hang; restore key
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
  - [ ] 🟨 Dead-man's switch: create free healthchecks.io check, set `HEALTHCHECKS_PING_URL` in `.env`; ping code verified when URL set
  - [x] 🟩 Env + docs: `WATCHDOG_*` and `HEALTHCHECKS_PING_URL` in `.env.example`; watchdog + pm2 section in `OPERATIONS.md`
  - [x] 🟩 Live smoke: `npm run watchdog:once` against real Supabase → clean cycle
  - [x] 🟩 **Test:** artificially stuck T-099 probe → alert within one watchdog cycle (`verify:phase3-4`)
  - [ ] 🟨 **Test:** stop the watchdog process → healthchecks.io external alert fires (requires `HEALTHCHECKS_PING_URL`)
  - [x] 🟩 **Test:** injected OpenRouter 401 (bad key) → credential alert (`verify:phase3-4`)

- [ ] 🟥 **Phase 5: Soak + failure injection (24–72h)** — ~3 days elapsed

  - [ ] 🟥 Start soak: pm2 running scheduler + intake + watchdog; record start time
  - [ ] 🟥 Submit 2–3 staggered sandbox tasks via Telegram over the window (T-011+); no manual intervention unless an alert fires
  - [ ] 🟥 Injection: kill scheduler mid-engineering → job reappears, no permanent stuck state
  - [ ] 🟥 Injection: ~30s network interruption → Supabase retry-fetch absorbs it
  - [ ] 🟥 Injection: OpenRouter 402 during verification → run fails, task not falsely COMPLETE, alert received
  - [ ] 🟥 Injection: invalid `GITHUB_TOKEN` → engineering error artifact + notification
  - [ ] 🟥 Injection: kill process leaving stale queue messages → stale guards ack; no infinite loop
  - [ ] 🟥 Record everything in `system-knowledge/operations/soak-2026-07.md`: uptime, task outcomes, alerts, time-to-alert per injection
  - [ ] 🟥 Exit gate: 24h+ with zero undetected process deaths; mean time-to-alert on process death < 15 min

- [ ] 🟥 **Phase 6: Production declaration** — ~0.5 day

  - [ ] 🟥 Rewrite `OPERATIONS.md` around the supervised path: pm2 lifecycle, watchdog, recovery runbook, secret rotation, Supabase backup
  - [ ] 🟥 `system-knowledge/operations/`: escalation runbook + link soak results
  - [ ] 🟥 Write explicit v1 out-of-scope list (workers > 1, auto-deploy, GitHub webhook intake, design/release cells, deep planning memory)
  - [ ] 🟥 Human approval policy for production gates (`system-knowledge/policies/approval-policy.md`)
  - [ ] 🟥 Verify an operator can start, monitor, and recover using only the docs (no chat history)
  - [ ] 🟥 Update `STATUS.md`: flip "24/7 production" milestone to Done with evidence links
