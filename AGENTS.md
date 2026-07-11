# AGENTS.md

## Cursor Cloud specific instructions

TaskGraph OS is a Node.js + TypeScript (ESM, run via `tsx`, no build step) control plane.
Standard scripts live in `package.json`; setup/run docs are in `README.md`. Node 22 is the
CI-pinned version (`.github/workflows/validate.yml`).

### What runs with no external credentials (dev toolchain)
These are the CI checks and work offline after the update script:
- `npm run typecheck` (this is the compile check — there is no separate build)
- `npm run validate:contracts` / `npm run validate:evidence` (the contract/executability engine)
- `npm test` (full unit suite via `tsx --test`)

### Test suite needs env vars to even import (non-obvious)
Several modules instantiate the Supabase and Telegram clients at import time and throw if
their env vars are unset, which makes whole test files fail before any assertion. The suite
needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`
to be present (any non-empty value is fine — no network call happens at construction). A `.env`
copied from `.env.example` satisfies this, and the update script creates it if missing.
`dotenv` does NOT override already-set process env, so real injected secrets still take
precedence over the `.env` placeholders.

### Running the actual services requires real external services (not available by default)
The pipeline (`npm run scheduler`, `npm run intake`, `npm run watchdog`) is only functional
with real credentials for: a hosted Supabase project (with `supabase/migrations/` applied) via
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `DATABASE_URL`, an `OPENROUTER_API_KEY`, the
Claude Code CLI installed + authenticated (`CLAUDE_CODE_COMMAND`), and a Telegram bot
(`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`). Add these via the Secrets panel to run end to end.
`npm run healthcheck` reports exactly which of these are missing.

### Gotchas
- `npm run intake` binds the Express server on port 3000 first, then calls `bot.start()`, which
  exits the process if `TELEGRAM_BOT_TOKEN` is invalid. To exercise just the HTTP layer
  (`/health`, GitHub webhook HMAC gate) without a valid token, start the server module directly:
  `npx tsx -e 'import("./src/intake/server.ts").then(m=>m.startServer(3000))'`.
- `.env.example` defaults are Windows-oriented. On Linux set `TASKGRAPH_WORKTREE_ROOT` to a POSIX
  path (e.g. `/tmp/taskgraph-os`) before running the engineering cell; otherwise a literal
  `C:\tmp\taskgraph-os` directory gets created in the repo root.
- CI on `main` currently fails at `validate:contracts:strict` (the `tasks/T-003` contract
  references harness-only paths). This is pre-existing repo content, not an environment issue.
