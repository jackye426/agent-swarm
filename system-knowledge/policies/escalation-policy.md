---
version: 1
affects: [src/cells/verification/workflow.ts, src/intake/notifications.ts, TASKGRAPH_MAX_REWORK_ATTEMPTS]
---

# Escalation Policy

## Rework cap

| Setting | Default | Env var |
|---------|---------|---------|
| Max rework attempts | 3 | `TASKGRAPH_MAX_REWORK_ATTEMPTS` |

When verification returns REWORK_REQUIRED and rework attempts ≥ cap, the effective verdict becomes **BLOCKED** instead.

## How rework attempts are counted

Counted via `getReworkAttemptCount()`:

```sql
SELECT COUNT(*) FROM agent_runs
WHERE task_id = $1 AND worker_type = 'rework-cell'
```

Each completed `task.rework.requested` queue job creates an agent run with worker type `rework-cell`. The count is checked **before** enqueueing the next rework.

See [003-rework-cap-mechanism.md](../decisions/003-rework-cap-mechanism.md).

## At rework cap

1. Verification saves verdict as BLOCKED (not REWORK_REQUIRED)
2. Task transitions to BLOCKED
3. `rework_escalated` human_notification artifact written
4. Supabase Realtime → Telegram via intake notification watcher

Operator action: revise contract scope, fix root cause manually, or reset task state.

## Notification type registry

All `human_notification` artifacts use a `type` field. Telegram formatting is in `src/intake/notifications.ts`.

### contract_auto_approved

**When:** Planning cell auto-approves contract → READY

**Payload fields:** `task_id`, `contract_title`, `message`, `agent_run_id`, `notified_at`

**Telegram format:**
```text
✅ *T-NNN* — contract auto-approved
*{title}*
Planning complete. Task is now READY for engineering.
Run `/status T-NNN` to check.
```

### contract_validation_failed

**When:** Executability validation fails after revision → stays AWAITING_APPROVAL

**Payload fields:** `task_id`, `contract_title`, `errors[]`, `message`, `agent_run_id`

**Telegram format:**
```text
⚠️ *T-NNN* — contract validation failed
*{title}*
Executability errors:
• {error 1}
• {error 2}
Check the contract_validation_failed artifact for details.
```

### task_complete

**When:** Verification passes → COMPLETE

**Payload fields:** `task_id`, `message`, `agent_run_id`

**Telegram format:**
```text
🎉 *T-NNN* — COMPLETE

{message}
```

### rework_escalated

**When:** Rework cap hit → BLOCKED

**Payload fields:** `task_id`, `message` (includes attempt count and blocking defects)

**Telegram format:**
```text
🚫 *T-NNN* — BLOCKED after max rework attempts

{message}

Revise the contract scope or intervene manually.
```
