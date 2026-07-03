# TaskGraph OS — System Knowledge

Version-controlled operational rules that complement runtime enforcement in code.

## When to read what

| Audience | Start here |
|----------|------------|
| **Operators** (re-seed, debug stuck tasks) | [operations/re-seed-and-queue-hygiene.md](operations/re-seed-and-queue-hygiene.md) |
| **Planning cell** | [policies/approval-policy.md](policies/approval-policy.md), [concepts/context-packets.md](concepts/context-packets.md) |
| **Engineering cell** | [policies/agent-permissions.md](policies/agent-permissions.md), [concepts/context-packets.md](concepts/context-packets.md) |
| **Verification cell** | [concepts/evidence-and-verification.md](concepts/evidence-and-verification.md) |
| **New contributors** | [concepts/task-lifecycle.md](concepts/task-lifecycle.md) → [concepts/evidence-and-verification.md](concepts/evidence-and-verification.md) |

## Concepts

- [task-lifecycle.md](concepts/task-lifecycle.md) — 11 statuses, legal transitions, READY/COMPLETE guards
- [evidence-and-verification.md](concepts/evidence-and-verification.md) — AC kinds, satisfaction rules, verdict priority
- [context-packets.md](concepts/context-packets.md) — execution_ready packet shape, test command resolution

## Policies

- [agent-permissions.md](policies/agent-permissions.md) — Claude Code permissions, commit exclusions, scope enforcement
- [approval-policy.md](policies/approval-policy.md) — human vs auto-approval, production requirements
- [escalation-policy.md](policies/escalation-policy.md) — rework cap, notification registry

## Operations

- [re-seed-and-queue-hygiene.md](operations/re-seed-and-queue-hygiene.md) — stale jobs, re-seed checklist

## Architecture decisions (ADRs)

- [001-auto-approval.md](decisions/001-auto-approval.md)
- [002-skip-permissions.md](decisions/002-skip-permissions.md)
- [003-rework-cap-mechanism.md](decisions/003-rework-cap-mechanism.md)

## Conventions

Each doc has YAML frontmatter with `version` and `affects` (source files / tables). Agent prompts that embed excerpts include a source comment pointing back to the doc path.

Related: `project_structure.md`, `OPERATIONS.md`, `STATUS.md`, `plans/system-knowledge-layer.md`.
