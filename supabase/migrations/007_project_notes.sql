-- TaskGraph OS — migration 007
-- Conversational intake hardening:
--   notes — durable per-chat project memory. Each confirmed task chain appends
--           a dated summary, so later conversations can reference earlier work
--           ("add another page to the dashboard we built").
--   repo  — the repo this chat's current conversation has settled on, declared
--           by the intake agent, used to ground the conversation in a repo
--           snapshot on subsequent turns.

alter table chat_conversations
  add column if not exists notes text,
  add column if not exists repo text;
