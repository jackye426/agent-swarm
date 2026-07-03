-- TaskGraph OS — migration 006
-- Conversational intake: per-chat requirement-gathering history so a
-- conversation survives intake restarts. Messages are a JSONB array of
-- { role: "user" | "assistant", content: string } entries.

create table if not exists chat_conversations (
  chat_id     text primary key,
  messages    jsonb not null default '[]',
  updated_at  timestamptz not null default now()
);
