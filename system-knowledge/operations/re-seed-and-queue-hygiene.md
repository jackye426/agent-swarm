---
version: 1
affects: [src/scheduler/guards.ts, src/scheduler/index.ts]
---

# Re-seed and Queue Hygiene

Operational procedure for re-running a task after a failed or partial pipeline run.

## Stale job rules

The scheduler acks queue messages without processing when the task status doesn't match expectations (`src/scheduler/guards.ts`):

| Queue job | Processed when status is | Stale (acked, skipped) otherwise |
|-----------|--------------------------|----------------------------------|
| `task.plan.requested` | DRAFT or PLANNING | Any other status |
| `task.execution.requested` | READY | Any other status |
| `task.rework.requested` | REWORK_REQUIRED | Any other status |
| `task.verification.requested` | AWAITING_EVIDENCE or VERIFYING | Any other status |

Stale jobs are logged and acked to prevent infinite redelivery. They do **not** change task state.

## Why re-seeds fail without hygiene

Common failure mode (T-008):

1. Prior run left task in VERIFYING or REWORK_REQUIRED
2. Old queue messages still visible
3. Stale evidence records from prior commits confuse verification
4. Re-seed with new goal but old artifacts remain

## Re-seed checklist

Before re-seeding a task for a clean run:

1. **Check current status**
   ```powershell
   npm run smoke:inspect -- T-NNN
   ```

2. **Drain stale queue messages** — in Supabase SQL editor or pgmq admin, purge or archive messages for the task's queues if messages exist from prior runs

3. **Reset task state if needed** — use reset scripts or manual DB update:
   ```powershell
   npm run smoke:reset:engineering -- T-NNN   # if stuck in engineering
   ```

4. **Re-seed with explicit context**
   ```powershell
   npm run smoke:seed -- T-NNN --repo owner/repo `
     --goal "Clear goal statement" `
     --context "Use only npm test for verification. Only product files in commits."
   ```

5. **Run pipeline**
   ```powershell
   npm run pipeline:run -- T-NNN
   npm run smoke:inspect -- T-NNN
   ```

6. **Recover stuck verdict** (if verification saved but transition failed):
   ```powershell
   npm run recover:verdict -- T-NNN
   ```

## Executability on re-seed

If the contract references commands the repo doesn't have yet (e.g. `npm run healthcheck` before engineering adds it), auto-approval records a **warning** not an error. Ensure seed `--context` aligns with verification intent to avoid verifier scope mismatches.

## Always-on intake path

When using Telegram/GitHub intake with auto-dispatch:

- Keep scheduler running: `npm run scheduler`
- Set `TASKGRAPH_AUTO_ENQUEUE_EXECUTION=true` and `TASKGRAPH_AUTO_ENQUEUE_VERIFICATION=true` in `.env`

See `STATUS.md` T-008 section for the current dogfood example.
