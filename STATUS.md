# TaskGraph OS — Project Status

_Last updated: 2026-07-03 (Phases 3–4 verified; Phase 2 E2E next)_

---

## Milestone summary

| Milestone | Status | Evidence |
|-----------|--------|----------|
| **Line 1** — scripted pipeline → COMPLETE on external repo | **Done** | T-008 COMPLETE on `jackye426/swarm-sandbox` |
| **Line 2** — Telegram → COMPLETE unattended | **Not proven** | Intake + auto-dispatch ready; E2E pending |
| **24/7 ops stack** — pm2 + watchdog | **Verified** | `npm run verify:phase3-4` — 8 automated checks PASS (2026-07-03) |
| **24/7 production** — soak + declaration | **Pending** | Phase 5 soak; manual: healthchecks.io URL, reboot test |

---

## Current state

| Layer | Status |
|-------|--------|
| Core types, schemas, state machine | Complete |
| Supabase migrations 001–004 | Complete |
| Verification evidence reconciliation | Complete (`computeEffectiveMissingEvidence`) |
| Verification diff assembly | Complete (`assembleVerificationDiff`, cumulative rework diff) |
| Rework → auto re-verify loop | Complete (scheduler + pipeline loop + rework context) |
| Pipeline runner | Complete (multi-cycle, AWAITING_APPROVAL exit, BLOCKED recovery) |
| CI validation | Complete (strict contracts, T-003 evidence) |
| Harness hygiene | Complete (info/exclude, commit guard, scope-out restore) |
| Supabase transport retry | Complete (`retry-fetch.ts`) |
| Intake (Telegram + GitHub) | Code complete |
| Intake auto-dispatch | Complete (`TASKGRAPH_AUTO_ENQUEUE_*`) |
| Shallow healthcheck | Complete (Supabase + queues + env presence) |
| **Deep healthcheck** | **Complete + verified** (OpenRouter now probes authenticated `/api/v1/key`; bad keys rejected at startup) |
| **pm2 supervision** | **Verified** (`npm run verify:phase3-4` — restart intake/scheduler, gated start) |
| **Runtime watchdog** | **Verified** (stuck T-099 probe, OpenRouter 401 alert, pm2 app running) |
| **Shared notify module** | **Complete** (fetch-based Telegram; intake + watchdog unified) |
| Design / Release cells | Stub |

**Unit tests:** 81 passing (added 8 new watchdog-checks tests).

---

## T-008 dogfood — COMPLETE ✅

**Repo:** `jackye426/swarm-sandbox`  
**Goal:** Add negative-path self-test to `scripts/healthcheck.js`; zero dependencies.

| Field | Value |
|-------|-------|
| Status | **COMPLETE** |
| Contract version | 8 |
| Evidence commit | `c0725eb746d217189cace19ff8d3c6a577e2d761` |
| Final verification | All AC-1–AC-6 PASS (2026-07-03) |

**Do not re-seed T-008.** Use T-009+ for new dogfood.

### What T-008 proved

Full lifecycle on an external repo:

```text
planning → auto-approve → engineering → evidence → verification
  → REWORK_REQUIRED → rework → re-verify → COMPLETE
```

Platform fixes landed during this arc: harness pollution, cumulative rework diff, evidence/verdict reconciliation, Supabase retry, verification max tokens, rework context, `reseed:hygiene`.

---

## What we're ready for today

| Use case | Ready? |
|----------|--------|
| Dogfood via `smoke:seed` + `pipeline:run` on external repos | **Yes** |
| Rework loops with auto re-verify | **Yes** |
| Simple scoped tasks (`npm test`, small JS/TS changes) | **Yes** |
| Manual ops with `reseed:hygiene`, `recover:verdict`, `smoke:inspect` | **Yes** |
| Telegram/GitHub → COMPLETE with no manual enqueue | **Code ready** — Telegram E2E pending (Phase 2) |
| pm2 supervised 24/7 without babysitting | **Mostly** — stack running under pm2; set `HEALTHCHECKS_PING_URL`, run admin boot script, reboot test |
| Production deploy / auto-merge | **No** — out of scope for v1 |

---

## Next: 24/7 production

Active plans: **[`plans/production-readiness-execution.md`](plans/production-readiness-execution.md)** (75% — Phases 3–4 verified)

```text
Phase 6  Production declaration
Phase 5  Soak + failure injection (24–72h)
Phase 4  Runtime watchdog             ← VERIFIED (set HEALTHCHECKS_PING_URL for dead-man)
Phase 3  Process supervision          ← VERIFIED (admin boot script + reboot remain)
Phase 2  Line 2 intake E2E            ← NEXT
Phase 1  Deep healthcheck             ← DONE
Phase 0  Line 1 stable                ← DONE (T-008)
```

**Immediate next step:** Phase 2 Telegram E2E (T-009+). **Your manual steps:** healthchecks.io URL in `.env`, run `scripts/setup-pm2-windows.ps1` as Admin, one reboot test.

---

## Line 2 — intake (ready for E2E)

Set in `.env`:

```env
TASKGRAPH_AUTO_ENQUEUE_EXECUTION=true
TASKGRAPH_AUTO_ENQUEUE_VERIFICATION=true
GITHUB_CREATE_PR=true   # optional: gh pr diff for verification
```

```powershell
npm run healthcheck
pm2 start ecosystem.config.cjs       # production (recommended)
# or manual:
npm run scheduler      # terminal 1
npm run intake         # terminal 2
npm run verify:phase3-4   # re-run supervision + watchdog checks
```

### E2E checklist (Phase 2 of production plan)

| Path | Steps |
|------|--------|
| Telegram | `/repo set jackye426/swarm-sandbox` → `/task ...` → COMPLETE |
| GitHub | Issue + `taskgraph` label → same |
| agent-swarm | Scoped TS task on `jackye426/agent-swarm` (`npm run typecheck`, `npm test`) |

---

## Lessons learned (informing production plan)

1. **Shallow healthcheck masked credential failures** — OpenRouter 402 and missing Claude looked like platform bugs.
2. **Harness pollution mimicked agent failure** — `.gitignore` leaks and evidence in commits caused false scope AC failures.
3. **Re-seed without hygiene fails silently** — stale queue messages and evidence confuse verification; use `reseed:hygiene`.
4. **Rework needs full contract context** — defect-only prompts caused whack-a-mole; cumulative branch diff required.
5. **Transport blips need retry** — Supabase `fetch failed` is intermittent; retry-fetch helps but isn't a substitute for watchdog alerts.
6. **Two processes, no supervisor** — scheduler and intake are separate manual processes; 24/7 requires supervision.

Details and testing phases: [`plans/production-readiness.md`](plans/production-readiness.md).

---

## Key platform fixes (T-008 arc)

1. Evidence vs verdict reconciliation — PASS on diff AC with inconclusive engineering evidence no longer blocks COMPLETE.
2. Cumulative rework branch diff — verification sees all commits, not just the latest.
3. Harness isolation — `.git/info/exclude`, commit guard, scope-out restore from `base_sha`.
4. Rework context — full contract + preserve PASS criteria in engineering prompts.
5. Supabase retry-fetch — exponential backoff on transport failures.
6. Verification max tokens — default cap avoids OpenRouter 402 on long diffs.
7. Queue hygiene script — `npm run reseed:hygiene -- T-NNN`.

---

## Script reference

| Script | Purpose |
|--------|---------|
| `npm run healthcheck` | Deep pre-flight: Supabase, OpenRouter, Claude, git, worktree (+ `--json`, `--strict`) |
| `npm run scheduler` | Always-on queue worker (manual; use `pm2 start` for production) |
| `npm run intake` | Telegram bot + GitHub webhook + notifications (manual; use `pm2 start` for production) |
| `npm run watchdog [--once]` | Runtime monitor (stuck tasks, credits, queue depth, disk free, dead-man ping) |
| `npm run start:gated <scheduler\|intake>` | Healthcheck gate launcher (what pm2 invokes; exits 1 if probes fail) |
| `npm run reseed:hygiene -- T-NNN` | Drain queues, clear evidence, reset to DRAFT |
| `npm run verify:phase3-4` | Automated Phase 3–4 verification (pm2 + watchdog) |
| `scripts/setup-pm2-windows.ps1` | Admin: pm2-logrotate + boot persistence |
| `npm run smoke:seed -- T-NNN [--repo owner/repo]` | Seed planning with repo resolution |
| `npm run pipeline:run -- T-NNN` | Full planning → engineering → verification loop |
| `npm run smoke:seed:verification -- T-NNN` | Enqueue verification from worktree diff |
| `npm run recover:verdict -- T-NNN` | Apply saved verification verdict + enqueue rework |
| `npm run smoke:inspect -- T-NNN` | Full task inspection |
| `npm run validate:contracts:strict` | Contract + executability validation |

---

## Architecture (current dogfood path)

```text
seed → planning → auto-approve → READY
  → engineering (worktree, Claude Code, tests, commit)
  → AWAITING_EVIDENCE + evidence
  → verification (model review + effective missing evidence)
  → COMPLETE | REWORK_REQUIRED → rework → auto re-verify → ...
```

Target unattended path (Line 2 + 24/7):

```text
Telegram / GitHub intake → repo resolve → seed scan → planning → ...
  (scheduler + intake supervised, healthcheck gated, watchdog alerting)
```

---

## Related docs

| Doc | Purpose |
|-----|---------|
| [`plans/production-readiness.md`](plans/production-readiness.md) | Strategic 24/7 plan + testing methodology |
| [`plans/production-readiness-execution.md`](plans/production-readiness-execution.md) | **Active** — Task-by-task tracker for Phases 2–6; 55% complete (code done, testing pending) |
| [`plans/production-hardening.md`](plans/production-hardening.md) | Feature slices (~90% done) |
| [`system-knowledge/operations/re-seed-and-queue-hygiene.md`](system-knowledge/operations/re-seed-and-queue-hygiene.md) | Re-seed checklist |
| [`OPERATIONS.md`](OPERATIONS.md) | Production run checklist + pm2 supervised operation guide (updated) |
