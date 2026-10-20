# Queue RPC permissions

The backend's `src/db/queue.ts` invokes send/read/delete and `scripts/watchdog.ts`
invokes metrics. Both use `src/db/client.ts`, which requires
`SUPABASE_SERVICE_ROLE_KEY`. These SECURITY DEFINER wrappers must not be available
to browser/anonymous roles, regardless of table RLS.

Migration 002 now grants EXECUTE explicitly to service_role and revokes it from
PUBLIC, anon and authenticated in the same transaction as function creation.
Migration 010 applies the same contract to existing installations without
replacing functions or changing queue contents. Other explicit role grants remain
unchanged. This is deliberately not a blanket default-privilege change.

## Test (no credentials)

Run `npm ci --ignore-scripts` then `npm run test:queue-acl`. The dedicated CI job
runs this independently of unrelated contract validations. An isolated in-memory
PGlite database supplies synthetic pgmq function stubs and queue records. Tests
check effective privileges, actual denied calls, allowed backend send/read/delete
and metrics, repeatability, legacy broad grants, and custom-role preservation.
They do not test the real pgmq extension, PostgREST JWT routing, or production
configuration. Stub read does not model visibility semantics.

## Deployment gate

Before deployment, verify which Supabase project the active workers and watchdog
actually target without printing keys. Source-level service-role configuration is
verified; deployed configuration and additional external callers are not.
Inventory role memberships/custom grants too: inherited grants from another role
can still confer access. Test the actual extension and PostgREST with disposable
staging queues and synthetic messages. Do not invoke production pgmq_read as a
read-only probe: it changes message visibility.

After explicit approval for the target security change, apply
`migrations/010_queue_rpc_backend_only.sql` as the function owner through the
normal migration process. Its complete scope is EXECUTE on these four functions:

- public.pgmq_send(text,jsonb)
- public.pgmq_read(text,integer,integer)
- public.pgmq_delete(text,bigint)
- public.pgmq_metrics(text)

It removes PUBLIC/anon/authenticated execution and explicitly retains service_role
execution. Workers using client-role JWTs will stop working and must be identified
before deployment. Verify effective privileges using has_function_privilege and
pg_proc ACL metadata, not live queue operations. Do not automatically restore
PUBLIC access as rollback; correct a verified missing backend-role grant only
with approval. No production permissions are applied by preparing this patch.
