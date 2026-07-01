-- TaskGraph OS — migration 004
-- Repo/source context on tasks + Telegram chat → default repo bindings.

alter table tasks
  add column if not exists repo_url text,
  add column if not exists repo_full_name text,
  add column if not exists source text,
  add column if not exists source_context jsonb;

create table if not exists chat_repo_bindings (
  chat_id         text primary key,
  repo_full_name  text not null,
  updated_at      timestamptz not null default now()
);

create index if not exists tasks_repo_full_name_idx on tasks (repo_full_name);
