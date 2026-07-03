#!/usr/bin/env tsx

import "dotenv/config";
import {
  defaultHealthProbeDeps,
  formatProbeResults,
  runHealthProbes,
  type SupabaseProbeClient,
} from "./lib/health-probes.js";

function parseArgs(argv: string[]): { json: boolean; strict: boolean } {
  return {
    json: argv.includes("--json"),
    strict: argv.includes("--strict"),
  };
}

async function main(): Promise<void> {
  const { json, strict } = parseArgs(process.argv.slice(2));
  const deps = defaultHealthProbeDeps();

  let db: SupabaseProbeClient | undefined;
  if (deps.env.SUPABASE_URL?.trim() && deps.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    const client = await import("../src/db/client.js");
    db = client.db as unknown as SupabaseProbeClient;
  }

  const summary = await runHealthProbes(deps, { strict, db });

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatProbeResults(summary.results, strict));
    if (summary.ok) {
      console.log("\nTaskGraph OS healthcheck passed.");
    } else {
      console.error("\nTaskGraph OS healthcheck failed.");
    }
  }

  if (!summary.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
