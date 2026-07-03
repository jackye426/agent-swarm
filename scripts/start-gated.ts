#!/usr/bin/env tsx
/**
 * Healthcheck-gated service launcher — what pm2 runs instead of the raw services.
 *
 * Runs the deep healthcheck first (strict mode for intake, which needs
 * TELEGRAM_CHAT_ID / GITHUB_WEBHOOK_SECRET); exits 1 on failure so pm2's
 * exponential backoff keeps retrying until credentials are fixed, and nothing
 * ever half-starts unhealthy. On success, imports the service entry module,
 * which starts it.
 *
 * Usage: tsx scripts/start-gated.ts <scheduler|intake>
 */

import "dotenv/config";
import {
  defaultHealthProbeDeps,
  formatProbeResults,
  runHealthProbes,
  type SupabaseProbeClient,
} from "./lib/health-probes.js";

const SERVICES = {
  scheduler: { entry: "../src/scheduler/index.js", strict: false },
  intake: { entry: "../src/intake/index.js", strict: true },
} as const;

async function main(): Promise<void> {
  const name = process.argv[2] as keyof typeof SERVICES | undefined;
  if (!name || !(name in SERVICES)) {
    console.error("Usage: tsx scripts/start-gated.ts <scheduler|intake>");
    process.exit(1);
  }
  const service = SERVICES[name];

  const deps = defaultHealthProbeDeps();
  let db: SupabaseProbeClient | undefined;
  if (deps.env.SUPABASE_URL?.trim() && deps.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    const client = await import("../src/db/client.js");
    db = client.db as unknown as SupabaseProbeClient;
  }

  console.log(`[StartGated] Running deep healthcheck before starting ${name}...`);
  const summary = await runHealthProbes(deps, { strict: service.strict, db });
  console.log(formatProbeResults(summary.results, service.strict));

  if (!summary.ok) {
    console.error(`[StartGated] Healthcheck failed — refusing to start ${name}`);
    process.exit(1);
  }

  console.log(`[StartGated] Healthcheck passed — starting ${name}`);
  // Service entry modules run their own main() at import time.
  await import(service.entry);
}

main().catch((err) => {
  console.error("[StartGated] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
