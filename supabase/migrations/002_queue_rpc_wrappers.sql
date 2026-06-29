-- Expose Supabase Queues / pgmq operations through public RPC functions.
-- PostgREST only exposes configured schemas; these wrappers let the backend
-- call queues through Supabase JS without exposing the pgmq schema directly.

create or replace function public.pgmq_send(queue_name text, message jsonb)
returns bigint
language sql
security definer
set search_path = pgmq, public
as $$
  select pgmq.send(queue_name, message);
$$;

create or replace function public.pgmq_read(queue_name text, vt integer, qty integer)
returns table (
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
)
language sql
security definer
set search_path = pgmq, public
as $$
  select *
  from pgmq.read(queue_name, vt, qty);
$$;

create or replace function public.pgmq_delete(queue_name text, msg_id bigint)
returns boolean
language sql
security definer
set search_path = pgmq, public
as $$
  select pgmq.delete(queue_name, msg_id);
$$;

create or replace function public.pgmq_metrics(queue_name text)
returns table (
  queue_name text,
  queue_length bigint,
  newest_msg_age_sec integer,
  oldest_msg_age_sec integer,
  total_messages bigint,
  scrape_time timestamptz
)
language sql
security definer
set search_path = pgmq, public
as $$
  select *
  from pgmq.metrics(queue_name);
$$;
