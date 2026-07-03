---
version: 1
affects: [ecosystem.config.cjs, scripts/verify-phase3-4.ts, scripts/watchdog.ts]
---

# Phase 3–4 Verification (pm2 + watchdog)

Run the automated suite:

```powershell
npm run verify:phase3-4
```

## What it proves (automated)

| Check | Phase |
|-------|-------|
| Gated start rejects invalid OpenRouter key | 3 |
| pm2 starts scheduler + intake + watchdog | 3 |
| Intake `/health` responds after healthcheck gate | 3 |
| pm2 restart intake and scheduler | 3 |
| pm2 save process list | 3 |
| Watchdog stuck-task alert (injects T-099 probe) | 4 |
| Watchdog OpenRouter credential alert | 4 |

## Manual follow-ups (required for full sign-off)

### Phase 3

1. **pm2 boot persistence** (elevated PowerShell):
   ```powershell
   npm install -g pm2 pm2-windows-startup
   pm2 install pm2-logrotate
   pm2 save
   pm2-startup install
   ```
2. **Reboot test:** reboot host → `pm2 status` → all three apps online.
3. **Disable sleep/hibernate** on the 24/7 host.

### Phase 4 — healthchecks.io dead-man's switch

1. Create a free check at [healthchecks.io](https://healthchecks.io) (period ≈ `WATCHDOG_INTERVAL_MS` + grace, e.g. 10 min).
2. Copy the ping URL into `.env`:
   ```env
   HEALTHCHECKS_PING_URL=https://hc-ping.com/your-uuid-here
   ```
3. Restart watchdog: `pm2 restart taskgraph-watchdog`
4. Confirm ping succeeds: `npm run watchdog:once` (check healthchecks.io “last ping”).
5. **Stop test:** `pm2 stop taskgraph-watchdog` → wait for healthchecks.io alert → `pm2 start taskgraph-watchdog`

## Last run (2026-07-03)

Automated: gated start, pm2 stack, watchdog stuck + OpenRouter alerts — **PASS**.

Pending manual: `HEALTHCHECKS_PING_URL`, `pm2-startup install` (admin), host reboot, disable sleep.
