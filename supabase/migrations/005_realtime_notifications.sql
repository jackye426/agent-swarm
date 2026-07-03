-- ============================================================
-- 005: Enable Realtime events for notification delivery
-- ============================================================
-- Supabase Realtime only emits postgres_changes events for tables in the
-- supabase_realtime publication. The intake notification watcher subscribes
-- to artifacts INSERTs; without this, it subscribes successfully and then
-- receives nothing — human_notification artifacts are written but never
-- forwarded to Telegram (observed: T-010 completed silently, 2026-07-03).
--
-- The watcher also has a polling fallback, so this is an optimization for
-- instant delivery rather than a hard dependency.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'artifacts'
  ) then
    alter publication supabase_realtime add table artifacts;
  end if;
end $$;
