---
version: 1
affects: [src/core/contract-executability.ts, src/cells/planning/workflow.ts, src/cells/engineering/workflow.ts]
---

# Context Packets

Context packets are the minimum approved information a worker receives. They are stored in Supabase and versioned per agent run.

## Packet kinds

| Kind | When created | Used by |
|------|--------------|---------|
| Planning seed packet | Task creation / smoke seed | Planning cell |
| `execution_ready` | After contract auto-approval | Engineering cell |

## execution_ready packet shape

Built by `buildExecutionReadyPacket()` after executability validation:

```yaml
kind: execution_ready
repo_full_name: owner/repo
user_context: "..."           # operator-provided goal context
planning_context: "..."       # formatted seed scan + user context
seed: { ... }                 # SeedRepoContext from repo scanner
contract_summary:
  title: ...
  goal: ...
  scope_in: [...]
  scope_out: [...]
  constraints: [...]
test_commands: [...]          # suggested commands for engineering
contract_test_commands: [...] # commands extracted from contract ACs
ac_classifications:           # AC id → verification kind[]
  AC-1: [command]
  AC-2: [diff_inspection]
```

## Test command resolution order

`resolveTestCommandsFromPacket()` picks commands in this precedence:

1. **Payload commands** — from queue job (`test_commands` in execution/rework payload)
2. **Packet `test_commands`** — from execution_ready packet
3. **Packet `contract_test_commands`** — extracted from contract ACs
4. **Seed `test_commands`** — from repo scanner (`package.json` scripts)
5. **Empty** — engineering falls back to `TASKGRAPH_DEFAULT_TEST_COMMANDS`

## Field contents

### user_context

Operator-provided text from seed command, Telegram `/task`, or GitHub issue body. Describes intent and constraints not visible in the repo scan.

### planning_context

Formatted string combining user_context and seed scan output:

- Repository name
- File tree (top levels)
- README excerpt
- Detected test commands
- Package manifest summary

Used by planning prompts and passed through to engineering via `formatContextForEngineering()`.

### seed

Structured `SeedRepoContext` from `repo-scanner.ts`. Used for executability validation (`testCommands` from seed) and compact review formatting.

## Executability context from packet

`executabilityContextFromPacket()` supplies `testCommands` to `validateContractExecutability()` using the same resolution order above. Mismatches between contract commands and seed commands produce warnings, not errors (see [evidence-and-verification.md](evidence-and-verification.md)).
