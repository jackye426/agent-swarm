-- TaskGraph OS — initial schema
-- All durable work state lives here. LangGraph checkpoints task-internal state separately.

create extension if not exists "pgcrypto";
create extension if not exists "pgmq";

-- ============================================================
-- Enums
-- ============================================================

create type task_status as enum (
  'DRAFT',
  'PLANNING',
  'AWAITING_APPROVAL',
  'READY',
  'IN_PROGRESS',
  'AWAITING_EVIDENCE',
  'VERIFYING',
  'COMPLETE',
  'REWORK_REQUIRED',
  'BLOCKED',
  'CANCELLED'
);

create type task_verdict as enum (
  'COMPLETE',
  'REWORK_REQUIRED',
  'BLOCKED',
  'CANCELLED'
);

create type criterion_verdict as enum (
  'PASS',
  'FAIL',
  'INCONCLUSIVE',
  'NOT_APPLICABLE'
);

create type cell_type as enum (
  'planning',
  'design',
  'engineering',
  'verification',
  'release'
);

create type evidence_type as enum (
  'integration_test',
  'unit_test',
  'browser_test',
  'ci_run',
  'migration_dry_run',
  'security_check',
  'model_review',
  'human_approval',
  'audit_log_assertion',
  'other'
);

create type evidence_status as enum (
  'pass',
  'fail',
  'inconclusive'
);

create type agent_run_status as enum (
  'running',
  'complete',
  'failed'
);

create sequence goal_seq start 1;

-- ============================================================
-- Goals
-- ============================================================

create table goals (
  id          text primary key default 'G-' || nextval('goal_seq')::text,
  title       text not null,
  description text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- Tasks
-- ============================================================

create table tasks (
  id               text primary key,           -- T-001, T-002, …
  goal_id          text references goals(id),
  title            text not null,
  status           task_status not null default 'DRAFT',
  cell             cell_type not null default 'planning',
  contract_version integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index tasks_status_idx on tasks(status);
create index tasks_goal_idx   on tasks(goal_id);

-- ============================================================
-- Task dependencies
-- ============================================================

create table task_dependencies (
  task_id        text not null references tasks(id) on delete cascade,
  depends_on_id  text not null references tasks(id) on delete cascade,
  primary key (task_id, depends_on_id)
);

-- ============================================================
-- Task contract versions
-- ============================================================

create table task_contract_versions (
  id          uuid primary key default gen_random_uuid(),
  task_id     text not null references tasks(id) on delete cascade,
  version     integer not null,
  contract    jsonb not null,             -- full contract snapshot
  created_at  timestamptz not null default now(),
  unique (task_id, version)
);

-- ============================================================
-- Context packets
-- ============================================================

create table context_packets (
  id          uuid primary key default gen_random_uuid(),
  task_id     text not null references tasks(id) on delete cascade,
  version     integer not null,
  content     jsonb not null,             -- approved minimal context for one run
  created_at  timestamptz not null default now(),
  unique (task_id, version)
);

-- ============================================================
-- Artifacts
-- ============================================================

create table artifacts (
  id          uuid primary key default gen_random_uuid(),
  task_id     text not null references tasks(id) on delete cascade,
  artifact_type text not null,            -- e.g. 'pr', 'migration', 'design_spec'
  url         text,
  content     jsonb,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- Agent runs
-- ============================================================

create table agent_runs (
  id                 uuid primary key default gen_random_uuid(),
  task_id            text not null references tasks(id) on delete cascade,
  cell               cell_type not null,
  worker_type        text not null,       -- 'claude-code', 'codex-reviewer', 'human', …
  started_at         timestamptz not null default now(),
  completed_at       timestamptz,
  status             agent_run_status not null default 'running',
  context_packet_id  uuid references context_packets(id)
);

create index agent_runs_task_idx on agent_runs(task_id);

-- ============================================================
-- Evidence records
-- ============================================================

create table evidence_records (
  id                  text primary key,     -- E-001, E-002, …
  task_id             text not null references tasks(id) on delete cascade,
  agent_run_id        uuid references agent_runs(id),
  acceptance_criteria text[] not null,      -- ['AC-1', 'AC-2']
  evidence_type       evidence_type not null,
  status              evidence_status not null,
  commit_sha          text,
  source              text not null,        -- URL to CI run / PR / audit log
  command             text,
  recorded_at         timestamptz not null default now(),
  summary             text not null
);

create index evidence_task_idx on evidence_records(task_id);

-- ============================================================
-- Verification records
-- ============================================================

create table verification_records (
  id                uuid primary key default gen_random_uuid(),
  task_id           text not null references tasks(id) on delete cascade,
  agent_run_id      uuid not null references agent_runs(id),
  verdict           task_verdict not null,
  blocking_defects  text[] not null default '{}',
  missing_evidence  text[] not null default '{}',
  regression_risks  text[] not null default '{}',
  criterion_verdicts jsonb not null default '{}', -- { "AC-1": "PASS", "AC-2": "FAIL" }
  created_at        timestamptz not null default now()
);

-- ============================================================
-- Decision records
-- ============================================================

create table decision_records (
  id          uuid primary key default gen_random_uuid(),
  task_id     text references tasks(id),
  title       text not null,
  decision    text not null,
  rationale   text not null,
  made_by     text not null,
  made_at     timestamptz not null default now()
);

-- ============================================================
-- Approval records
-- ============================================================

create table approval_records (
  id          uuid primary key default gen_random_uuid(),
  task_id     text not null references tasks(id) on delete cascade,
  approver    text not null,
  role        text not null,              -- 'Product', 'Engineering', 'Privacy'
  approved_at timestamptz not null default now(),
  notes       text
);

create index approval_task_idx on approval_records(task_id);

-- ============================================================
-- Task events (append-only audit log)
-- ============================================================

create table task_events (
  id          bigserial primary key,
  task_id     text not null references tasks(id) on delete cascade,
  event_type  text not null,              -- e.g. 'status_changed', 'evidence_added'
  from_status task_status,
  to_status   task_status,
  actor       text,
  payload     jsonb,
  occurred_at timestamptz not null default now()
);

create index task_events_task_idx on task_events(task_id);

-- ============================================================
-- Queues (pgmq / Supabase Queues)
-- Logical event names in code use dots, but physical queue names use
-- underscores so pgmq can create SQL-safe queue tables.
-- ============================================================

select pgmq.create('task_plan_requested');
select pgmq.create('task_design_requested');
select pgmq.create('task_execution_requested');
select pgmq.create('task_verification_requested');
select pgmq.create('task_release_requested');
select pgmq.create('task_rework_requested');

-- ============================================================
-- updated_at triggers
-- ============================================================

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger goals_updated_at before update on goals
  for each row execute procedure set_updated_at();

create trigger tasks_updated_at before update on tasks
  for each row execute procedure set_updated_at();

-- ============================================================
-- Helper: check if a task's dependencies are all COMPLETE
-- ============================================================

create or replace function task_dependencies_complete(p_task_id text)
returns boolean language sql stable as $$
  select not exists (
    select 1
    from task_dependencies td
    join tasks t on t.id = td.depends_on_id
    where td.task_id = p_task_id
      and t.status != 'COMPLETE'
  );
$$;

-- ============================================================
-- Helper: check if all required approvals are recorded
-- ============================================================

create or replace function task_approvals_complete(p_task_id text, p_required_roles text[])
returns boolean language sql stable as $$
  select (
    select count(distinct role)
    from approval_records
    where task_id = p_task_id
      and role = any(p_required_roles)
  ) = array_length(p_required_roles, 1);
$$;
