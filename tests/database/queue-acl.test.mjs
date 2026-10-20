import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const creation = readFileSync(new URL('../../supabase/migrations/002_queue_rpc_wrappers.sql', import.meta.url), 'utf8');
const repair = readFileSync(new URL('../../supabase/migrations/010_queue_rpc_backend_only.sql', import.meta.url), 'utf8');
const signatures = ['pgmq_send(text,jsonb)', 'pgmq_read(text,integer,integer)', 'pgmq_delete(text,bigint)', 'pgmq_metrics(text)'];
// Synthetic pgmq stubs test SQL signatures, role enforcement and forwarding only.
// No environment variables, network client, production extension or patient data.
const fixture = `
create role anon; create role authenticated; create role service_role;
create role unrelated_worker; create role public_only;
grant usage on schema public to public;
create schema pgmq;
create table pgmq.messages(id bigint generated always as identity, queue text, body jsonb);
create function pgmq.send(text,jsonb) returns bigint language sql as $$
 insert into pgmq.messages(queue,body) values ($1,$2) returning id;
$$;
create function pgmq.read(text,integer,integer)
returns table(msg_id bigint,read_ct integer,enqueued_at timestamptz,vt timestamptz,message jsonb)
language sql as $$ select id,1,now(),now()+$2*interval '1 second',body from pgmq.messages where queue=$1 limit $3; $$;
create function pgmq.delete(text,bigint) returns boolean language sql as $$
 with removed as (delete from pgmq.messages where queue=$1 and id=$2 returning id)
 select exists(select 1 from removed);
$$;
create function pgmq.metrics(text)
returns table(queue_name text,queue_length bigint,newest_msg_age_sec integer,oldest_msg_age_sec integer,total_messages bigint,scrape_time timestamptz)
language sql as $$ select $1,count(*),0,0,count(*),now() from pgmq.messages where queue=$1; $$;
`;

async function checkContract(db) {
  for (const signature of signatures) {
    for (const role of ['anon', 'authenticated', 'public_only', 'service_role']) {
      const { rows } = await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, `public.${signature}`]);
      assert.equal(rows[0].allowed, role === 'service_role', `${role}: ${signature}`);
    }
  }
  const calls = ["public.pgmq_send('synthetic', '{}'::jsonb)", "public.pgmq_read('synthetic', 30, 1)", "public.pgmq_delete('synthetic', 1::bigint)", "public.pgmq_metrics('synthetic')"];
  for (const role of ['anon', 'authenticated', 'public_only']) {
    await db.exec(`set role ${role}`);
    for (const call of calls) {
      await assert.rejects(db.query(`select * from ${call}`), (error) => error.code === '42501');
    }
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  const sent = await db.query("select public.pgmq_send('synthetic', '{\"task_id\":\"fixture\"}'::jsonb) as id");
  const id = sent.rows[0].id;
  assert.equal((await db.query("select * from public.pgmq_metrics('synthetic')")).rows[0].queue_length, 1);
  assert.deepEqual((await db.query("select * from public.pgmq_read('synthetic',30,1)")).rows[0].message, { task_id: 'fixture' });
  assert.equal((await db.query("select public.pgmq_delete('synthetic',$1::bigint) as deleted", [id])).rows[0].deleted, true);
  assert.equal((await db.query("select * from public.pgmq_metrics('synthetic')")).rows[0].queue_length, 0);
  await db.exec('reset role');
}

for (const mode of ['fresh', 'legacy upgrade']) {
  test(`queue RPC ACL: ${mode}`, async () => {
    const db = new PGlite();
    try {
      await db.exec(fixture);
      await db.exec(creation);
      if (mode === 'legacy upgrade') {
        for (const signature of signatures) {
          await db.exec(`grant execute on function public.${signature} to public,anon,authenticated,unrelated_worker`);
        }
        await db.exec(repair);
        await db.exec(repair); // Idempotent; preserve separately granted custom roles.
        for (const signature of signatures) {
          const { rows } = await db.query("select has_function_privilege('unrelated_worker',$1,'EXECUTE') as allowed", [`public.${signature}`]);
          assert.equal(rows[0].allowed, true);
        }
      }
      await checkContract(db);
      await db.exec(creation); // Re-running CREATE OR REPLACE must not reopen access.
      await checkContract(db);
    } finally { await db.close(); }
  });
}
