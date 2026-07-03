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
 * The healthcheck retries in-process (STARTGATE_HEALTHCHECK_ATTEMPTS every
 * STARTGATE_RETRY_DELAY_MS) before exiting. At cold boot the network is often
 * not up when pm2 resurrects; without the retry loop each instant failure
 * inflates pm2's exponential backoff and the stack takes 5+ minutes to come
 * online. A steady in-process cadence rides out warmup in seconds, while
 * genuinely bad credentials still exhaust the attempts and land in pm2 backoff.
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

const HEALTHCHECK_ATTEMPTS = Number(process.env.STARTGATE_HEALTHCHECK_ATTEMPTS ?? 10);
const RETRY_DELAY_MS = Number(process.env.STARTGATE_RETRY_DELAY_MS ?? 15_000);

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

  for (let attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt += 1) {
    console.log(
      `[StartGated] Deep healthcheck for ${name} (attempt ${attempt}/${HEALTHCHECK_ATTEMPTS})...`,
    );
    const summary = await runHealthProbes(deps, { strict: service.strict, db });
    console.log(formatProbeResults(summary.results, service.strict));

    if (summary.ok) {
      console.log(`[StartGated] Healthcheck passed — starting ${name}`);
      // Service entry modules run their own main() at import time.
      await import(service.entry);
      return;
    }

    if (attempt < HEALTHCHECK_ATTEMPTS) {
      console.warn(
        `[StartGated] Healthcheck failed — retrying in ${Math.round(RETRY_DELAY_MS / 1000)}s ` +
          `(cold-boot network warmup tolerance)`,
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  console.error(
    `[StartGated] Healthcheck failed after ${HEALTHCHECK_ATTEMPTS} attempts — refusing to start ${name}`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[StartGated] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
