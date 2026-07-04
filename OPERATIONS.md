# TaskGraph OS Operations

## Production Run Checklist

1. Create a Supabase project and apply `supabase/migrations/001_initial.sql`.
2. Confirm the migration created these physical queues:
   - `task_plan_requested`
   - `task_design_requested`
   - `task_execution_requested`
   - `task_verification_requested`
   - `task_release_requested`
   - `task_rework_requested`
3. Copy `.env.example` to `.env` and set real secrets.
4. Install and authenticate required CLIs on the scheduler host:
   - `git`
   - Claude Code CLI matching `CLAUDE_CODE_COMMAND` (optional `CLAUDE_CODE_MODEL` for `--model`)
   - `gh` if `GITHUB_CREATE_PR=true`
5. Run local gates:
   - `npm run typecheck`
   - `npm run validate`
   - `npm test`
6. **Deep healthcheck** (mandatory before scheduler/intake):
   - `npm run healthcheck`
   - Probes: Supabase tables/queues, OpenRouter API key (surfaces 401/402), Claude Code CLI, git, writable worktree root
   - Conditional: GitHub (`GITHUB_TOKEN` or `GITHUB_CREATE_PR=true`), Postgres checkpoint (`DATABASE_URL`), Telegram bot (`TELEGRAM_BOT_TOKEN`)
   - `npm run healthcheck -- --json` for machine-readable output
   - `npm run healthcheck -- --strict` when starting intake (fails on missing `TELEGRAM_CHAT_ID` / `GITHUB_WEBHOOK_SECRET`)
7. Start the scheduler:
   - `npm run scheduler` (manual) — or supervised via pm2, see below
8. Start intake (Line 2, separate process):
   - `npm run intake` (manual) — or supervised via pm2, see below
9. Enqueue jobs (manual path):
   - `npm run enqueue -- task.plan.requested ./payload.json`

## 24/7 Supervised Operation (pm2)

For unattended operation, run all three services under pm2 instead of bare `npm run`:

```powershell
npm install -g pm2 pm2-windows-startup
pm2 install pm2-logrotate          # bounded log files

pm2 start ecosystem.config.cjs     # scheduler + intake + watchdog
pm2 save                           # snapshot the process list
pm2-startup install                # resurrect on Windows boot
```

How the pieces fit:

- **Healthcheck gate:** scheduler and intake launch through `scripts/start-gated.ts`,
  which runs the deep healthcheck first (strict for intake) and exits 1 on failure.
  pm2's exponential backoff keeps retrying until credentials are fixed — nothing
  half-starts unhealthy.
- **Graceful shutdown:** both services handle SIGINT/SIGTERM. The scheduler
  finishes its in-flight job before exiting (pm2 `kill_timeout` 30 s); a hard
  crash is still safe because the unacked queue message reappears after the
  visibility timeout.
- **Watchdog (`npm run watchdog`):** every `WATCHDOG_INTERVAL_MS` checks
  Supabase/OpenRouter health, stuck tasks (`PLANNING`/`IN_PROGRESS`/`VERIFYING`
  older than `WATCHDOG_STUCK_TASK_MS`), credit/network failures in recent
  `agent_run_failed` events, queue depth, and free disk. Alerts go to Telegram,
  deduped to re-alert at most every `WATCHDOG_REALERT_MS`.
- **Dead-man's switch:** set `HEALTHCHECKS_PING_URL` to a free
  [healthchecks.io](https://healthchecks.io) check. The watchdog pings it each
  cycle; if the host dies (power, sleep, forced reboot), the missed ping raises
  an alert from outside the machine. Set the check's period to
  `WATCHDOG_INTERVAL_MS` with a few minutes' grace.

Day-to-day:

```powershell
pm2 status                         # process health at a glance
pm2 logs taskgraph-scheduler       # follow a service's logs (./logs/*.log)
pm2 restart taskgraph-intake       # bounce one service
pm2 stop all                       # planned maintenance
npm run watchdog:once              # manual one-shot check cycle
npm run verify:phase3-4            # re-run Phase 3–4 automated checks
```

Boot persistence (once, **Administrator** PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-pm2-windows.ps1
```

Host settings for 24/7: disable sleep/hibernate, and set Windows Update active
hours so forced reboots land when a `pm2 save` + startup hook can recover.

## Recovery Runbook

Symptom-first. Every path below assumes `pm2 status` and Telegram alerts as the
starting signal. Never fix state by hand before capturing it (`smoke:inspect`).

| Symptom | Likely cause | Recovery |
|---------|--------------|----------|
| Telegram alert: task stuck in `IN_PROGRESS`/`VERIFYING` | Cell crashed mid-run or verdict saved but transition failed | `npm run smoke:inspect -- T-NNN`; if a verification record exists → `npm run recover:verdict -- T-NNN`; else wait one visibility timeout (job redelivers), then inspect again |
| Telegram alert: credits/network failures | OpenRouter credits exhausted or Supabase transport blips | Check https://openrouter.ai/credits; top up. Transport blips self-heal via retry-fetch — recurring ones warrant a look at `pm2 logs` |
| Telegram alert: queue depth over threshold | Scheduler down or wedged | `pm2 status` → if stopped/errored: `pm2 restart taskgraph-scheduler`; then confirm depth drains on the next watchdog cycle |
| healthchecks.io alert (no Telegram) | Host or watchdog dead — Telegram alerts die with the host | Check the machine: power, sleep, Windows Update reboot. After boot: `pm2 status`; if empty, `pm2 resurrect` |
| A gated service restart-loops | Bad/expired credential — gate is refusing to start it (by design) | `pm2 logs <app> --lines 50` shows which probe fails; fix the secret in `.env`; the next backoff retry picks it up |
| Task failed after max rework | Contract scope vs verifier mismatch or genuinely hard task | Read the `rework_escalated` notification defects; revise scope and re-seed per `system-knowledge/operations/re-seed-and-queue-hygiene.md` |
| Notification you expected never arrived | Realtime publication missing (migration 005) or intake down > poll lookback | `pm2 logs taskgraph-intake` for `[Notifications] Delivered ...` lines; run migration 005; poller redelivers anything within `NOTIFY_POLL_LOOKBACK_MS` |

## Secret Rotation

All secrets live in `.env` only (never committed; `.gitignore` enforced).

1. Rotate at the provider: Supabase (service role key), OpenRouter, Telegram
   (@BotFather `/revoke`), GitHub (token), webhook secret (GitHub repo settings).
2. Update `.env`.
3. `pm2 restart all --update-env` — the healthcheck gate validates the new
   credentials before either service starts; a typo means backoff-retries, not
   a half-started stack.
4. Rotate on suspicion, not schedule, for v1 — but the service role key and
   `GITHUB_TOKEN` are the two with real blast radius; prefer fine-grained,
   repo-scoped GitHub tokens.

## Supabase Backup

- Supabase Pro keeps daily automatic backups; on the free tier, export weekly:
  dashboard → Database → Backups, or `pg_dump` via the connection string.
- The tables that matter for audit/recovery: `tasks`, `task_events`,
  `contracts`, `evidence_records`, `verification_records`, `artifacts`,
  `agent_runs`. Queues (`pgmq_*`) are transient — do not bother restoring them.
- After a restore, run `npm run reseed:hygiene -- T-NNN` on any task that was
  mid-flight when the snapshot was taken.

## Production v1 — Scope Declaration

In scope (proven): Telegram `/task` → COMPLETE unattended on external repos;
pm2-supervised scheduler + intake + watchdog; deep healthcheck gating; runtime
alerting with off-host dead-man's switch; rework loop with cap + escalation.

**Explicitly out of scope for v1:**

- `SCHEDULER_WORKERS > 1` (parallel workers stay at 1)
- Auto-merge / auto-deploy of produced PRs
- GitHub webhook intake (code-complete, unproven — needs public tunnel; v1.1)
- Browser/staging verification
- Design / Release cells (stubs)
- Deep planning memory (`deep-planning-memory.md`)
- Multi-host scheduler fleet; APM beyond Telegram + logs
- Automatic secret rotation

Declaration gate: Phase 5 soak (24 h+, zero undetected process deaths,
time-to-alert < 15 min) recorded in
`system-knowledge/operations/soak-2026-07.md`.

## Queue Payloads

Logical queue names use dotted event names in code. Physical pgmq queues use underscores.

Planning:

```json
{
  "task_id": "T-002",
  "goal": "Generate two independent implementation plans.",
  "context": "Relevant architecture and repository context."
}
```

Engineering:

```json
{
  "task_id": "T-003",
  "context": {
    "allowed_paths": ["src/**", "tests/**"],
    "notes": "Approved context packet."
  },
  "test_commands": ["npm run typecheck", "npm test", "npm run validate"]
}
```

Verification:

```json
{
  "task_id": "T-004",
  "pr_diff": "Unified diff or PR diff text.",
  "ci_output": "CI log text.",
  "commit_sha": "abcdef1234567890abcdef1234567890abcdef12",
  "source_url": "https://github.com/org/repo/actions/runs/123"
}
```

## Human Approval Gate

The Planning Cell accepts either:

```text
approved
```

or explicit approval JSON:

```json
{
  "decision": "approved",
  "approver": "Jane Owner",
  "roles": ["Product", "Engineering"]
}
```

For production runs, prefer explicit JSON so approval records are attributable.

## Failure Semantics

- The scheduler creates an `agent_runs` row before invoking a cell.
- It marks the run `complete` only after the cell finishes durable writes.
- It marks the run `failed` and leaves the queue message unacked if processing fails.
- A task can become `COMPLETE` only through the guarded transition path with evidence, CI, independent verification, and approvals.

## Current External Assumptions

- Supabase service role key is available only to trusted backend/scheduler runtime.
- Role-based Planning and Verification model calls go through OpenRouter using `OPENROUTER_API_KEY`.
- Model choices are configured per role with `MODEL_PLANNING_A`, `MODEL_PLANNING_B`, `MODEL_PLANNING_A_REVIEW`, `MODEL_PLANNING_B_REVIEW`, `MODEL_PLANNING_CONSENSUS`, `MODEL_CONTRACT_DRAFT`, `MODEL_CONTRACT_REVISION`, `MODEL_ENGINEERING_PLAN`, and `MODEL_VERIFICATION`. The engineering **implementation** worker (Claude Code CLI) uses `CLAUDE_CODE_MODEL` separately — it is not routed through OpenRouter.
- The scheduler host has filesystem permission to create git worktrees under `TASKGRAPH_WORKTREE_ROOT`.
- Claude Code and GitHub CLI authentication are managed outside the repository.
