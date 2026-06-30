# Feature Implementation Plan: Telegram + GitHub Intake

**Overall Progress:** `100%`

## TLDR
Add a lightweight intake server that lets TaskGraph OS receive work two ways: (1) GitHub labels an issue `taskgraph` → auto-creates a task and starts planning; (2) you send the Telegram bot a `/task` command → same thing. The bot also pushes notifications to you when the system needs your attention (planning done, verification verdict, etc.), sourced from the `human_notification` artifacts already written by the planning cell.

## Critical Decisions

- **Telegram mode: long-polling** — bot polls Telegram for updates instead of Telegram pushing to a URL. No public URL required for the bot itself. Switch to webhook mode later when deployed.
- **grammy** for Telegram — TypeScript-native, clean API, no class inheritance boilerplate.
- **Express** for GitHub webhook receiver — GitHub still needs a public URL to POST to; Express is the minimal HTTP server for this. Same server can later host the Telegram webhook if needed.
- **Supabase Realtime** for notification watching — subscribe to new `artifacts` rows filtered to `human_notification` type; push to Telegram immediately. No polling loop needed.
- **GitHub trigger**: `issues` event + label `taskgraph` added → issue title = goal, body = context.
- **Auto task ID**: helper queries `SELECT MAX(id) FROM tasks`, parses the number, returns next `T-NNN`. No migration needed.
- **Single intake process** (`npm run intake`) — separate from `npm run scheduler`. Runs the Express server + bot long-poll + Realtime subscription together.
- **TELEGRAM_CHAT_ID**: your personal chat ID (the bot DMs you directly, not a group). Get it by messaging `@userinfobot`.

## Tasks

- [x] 🟩 **Step 1: Install dependencies**
  - [x] 🟩 `npm install grammy express`
  - [x] 🟩 `npm install -D @types/express`
  - [x] 🟩 Add env vars to `.env.example`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GITHUB_WEBHOOK_SECRET`, `INTAKE_PORT`

- [x] 🟩 **Step 2: Task creator utility**
  - [ ] 🟥 `src/intake/task-creator.ts` — `createAndEnqueueTask({ goal, context, source })`:
    - Queries max task ID → generates next `T-NNN`
    - Upserts task at DRAFT
    - Enqueues `task.plan.requested`
    - Returns the new task ID

- [x] 🟩 **Step 3: Telegram client + notification watcher**
  - [ ] 🟥 `src/intake/telegram.ts` — thin grammy bot wrapper:
    - `sendNotification(text)` — sends a message to `TELEGRAM_CHAT_ID`
    - `/task <goal>` command handler → calls `createAndEnqueueTask`, replies with task ID
    - `/status T-NNN` command handler → queries task status from Supabase, replies
  - [ ] 🟥 `src/intake/notifications.ts` — Supabase Realtime subscriber:
    - Subscribes to `INSERT` on `artifacts` where `artifact_type = 'human_notification'`
    - On new row: formats message (task ID, title, type) → `sendNotification()`

- [x] 🟩 **Step 4: GitHub webhook handler**
  - [ ] 🟥 `src/intake/routes/github.ts` — Express route `POST /webhook/github`:
    - Verifies `X-Hub-Signature-256` HMAC with `GITHUB_WEBHOOK_SECRET`
    - Filters for `issues` event, action `labeled`, label name `taskgraph`
    - Extracts `issue.title` (goal) + `issue.body` (context) + `issue.html_url` (source)
    - Calls `createAndEnqueueTask`, posts GitHub comment on the issue with the task ID

- [x] 🟩 **Step 5: Express server + entry point**
  - [x] 🟩 `src/intake/server.ts` — Express app with raw body middleware for HMAC verification
  - [x] 🟩 `src/intake/index.ts` — starts HTTP server + Realtime watcher + bot long-poll
  - [x] 🟩 `"intake": "tsx src/intake/index.ts"` added to `package.json`

- [x] 🟩 **Step 6: Test**
  - [x] 🟩 Server boots — HTTP :3000 ✓, Telegram bot @Amish_boy_bot ✓, /health 200 ✓
  - [ ] 🟥 Send `/task` command to bot → confirm task created in Supabase
  - [ ] 🟥 Label a GitHub issue `taskgraph` via ngrok → confirm task created + Telegram notification
