-- Forward-only ACL repair for installations that already ran migration 002.
-- Does not recreate functions, touch queue data, or change other role grants.
-- Review runtime callers and approve the target before production deployment.
begin;

-- Backend-only RPCs: src/db/client.ts requires SUPABASE_SERVICE_ROLE_KEY.
-- PUBLIC must be revoked too: named-role revokes do not override inherited access.
revoke execute on function
  public.pgmq_send(text, jsonb),
  public.pgmq_read(text, integer, integer),
  public.pgmq_delete(text, bigint),
  public.pgmq_metrics(text)
from PUBLIC, anon, authenticated;

grant execute on function
  public.pgmq_send(text, jsonb),
  public.pgmq_read(text, integer, integer),
  public.pgmq_delete(text, bigint),
  public.pgmq_metrics(text)
to service_role;

commit;
