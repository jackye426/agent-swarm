// Throwaway: apply migrations 008 + 009 via direct Postgres connection.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";

const raw = process.env.DATABASE_URL ?? "";
// .env has the password wrapped in [] (Supabase placeholder style) — try both.
const candidates = [raw, raw.replace(/:\[([^\]]+)\]@/, ":$1@")];

let client: pg.Client | null = null;
for (const conn of candidates) {
  const attempt = new pg.Client({ connectionString: conn, connectionTimeoutMillis: 15_000 });
  try {
    await attempt.connect();
    client = attempt;
    break;
  } catch (err) {
    console.log(`Connect failed (${conn === raw ? "as-is" : "brackets stripped"}): ${(err as Error).message}`);
  }
}

if (!client) {
  console.error("RESULT: cannot connect — migrations must be run in the SQL editor");
  process.exit(1);
}

for (const file of ["008_contract_revision_queue.sql", "009_verification_routing_metadata.sql"]) {
  const sql = await readFile(`supabase/migrations/${file}`, "utf8");
  try {
    await client.query(sql);
    console.log(`APPLIED: ${file}`);
  } catch (err) {
    console.error(`FAILED ${file}: ${(err as Error).message}`);
  }
}
await client.end();
