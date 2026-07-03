# Conversational Intake Hardening

**Overall Progress:** `75%` — Steps 1–3 implemented, tested (92/92), deployed; Step 4 shakedown remains (needs live Telegram use + migration 007)

## TLDR

The conversational intake layer is deployed but works blind: it knows repo names, not contents; nothing gates when it may propose a breakdown; and it forgets everything after creating tasks. This plan grounds the conversation in real repo context (reusing the existing seed scanner), adds an explicit readiness checklist, and gives each chat durable project notes across conversations.

## Critical Decisions

- **Model: `deepseek/deepseek-v4-pro`** — matches the cheap stack; now explicit in `.env`. If shakedown shows weak decomposition or premature `create_tasks`, the single-line upgrade path is Sonnet/Opus.
- **Project notes: yes** — compact per-chat decisions summary persists across conversations (extends `chat_conversations` with a `notes` column; no new table).
- **Repo grounding reuses `scanRepoSeedContext`** — already cached (10 min), already produces file tree / README / test commands / recent commits. No new scanning machinery.
- **Readiness is prompt-enforced, not code-enforced** — a checklist the model must satisfy before proposing a breakdown, plus a `create_tasks` guard: the JSON must include a `requirements_summary` field, giving us an audit trail of what the agent believed it knew.

## Tasks:

- [x] 🟩 **Step 1: Repo-grounded conversation**
  - [x] 🟩 `loadRepoSnapshot` in `conversation.ts`: when a repo is settled (persisted `repo` column or chat default), `scanRepoSeedContext` (10-min cache) → compact snapshot into the system prompt
  - [x] 🟩 `formatRepoSnapshot` caps at 2,500 chars with per-section truncation; labeled "Current repo snapshot" + ground-truth instruction
  - [x] 🟩 Turn-by-turn detection: the model declares `repo` on reply actions (validated via `parseRepoFullName`, persisted); next turn is grounded
  - [x] 🟩 Prompt instructs informed questions referencing real files/scripts/commands

- [x] 🟩 **Step 2: Readiness checklist + audit trail**
  - [x] 🟩 READINESS CHECKLIST in system prompt: outcome, repo, per-task mechanical "done", constraints, stated assumptions — gates breakdown proposals
  - [x] 🟩 `requirements_summary` required on `create_tasks`; parser rejects without it
  - [x] 🟩 Summary stored in each task's `source_context` AND prepended to each task's planning context ("Agreed requirements (from intake conversation)")
  - [x] 🟩 Unit tests: 11 conversation tests (parser field enforcement, repo declaration, snapshot format/cap, prompt embedding, notes cap) — suite 92/92

- [x] 🟩 **Step 3: Project notes (cross-conversation memory)**
  - [x] 🟩 Migration 007: adds `notes` + `repo` columns to `chat_conversations` (code degrades gracefully pre-migration via `select("*")`)
  - [x] 🟩 On successful `create_tasks`: dated note appended (date, repo, task IDs, requirements summary) — `appendProjectNote` keeps most-recent 4,000 chars
  - [x] 🟩 Notes injected into system prompt ("What this chat has built before")
  - [x] 🟩 `/reset` keeps notes + repo; `/forget` wipes the chat's row entirely

- [ ] 🟥 **Step 4: Shakedown + soak integration**
  - [ ] 🟥 Live test: vague multi-part ask → verify informed questions reference real repo files → confirm → chain created with dependencies → tasks execute in order → notifications arrive per task
  - [ ] 🟥 Verify a second conversation in the same chat recalls project notes
  - [ ] 🟥 Record outcomes in `system-knowledge/operations/soak-2026-07.md` (this doubles as soak task submissions)
  - [ ] 🟥 If deepseek shows premature/oversized `create_tasks`: bump `MODEL_INTAKE_CONVERSATION` one tier and re-test before touching prompt further
