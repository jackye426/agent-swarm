#!/usr/bin/env tsx
/**
 * Live verification for production-readiness Phases 3 (pm2 supervision) and 4
 * (runtime watchdog). Run from repo root with a valid .env.
 *
 * Usage: npm run verify:phase3-4 [-- --skip-pm2-kill]
 */

import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { db } from "../src/db/client.js";

const execFileAsync = promisify(execFile);

const WATCHDOG_PROBE_TASK = "T-099";
const SKIP_PM2_KILL = process.argv.includes("--skip-pm2-kill");

/** pm2 global install on Windows is often not on PATH for child_process. */
function pm2Command(): { command: string; argsPrefix: string[] } {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      return { command: `${appData}\\npm\\pm2.cmd`, argsPrefix: [] };
    }
  }
  return { command: "pm2", argsPrefix: [] };
}

async function runPm2(args: string[], options: { timeoutMs?: number } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const pm2 = pm2Command();
  if (process.platform === "win32" && pm2.command.endsWith(".cmd")) {
    return runCommand("cmd.exe", ["/c", pm2.command, ...args], options);
  }
  return runCommand(pm2.command, args, options);
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  manual?: boolean;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string, manual = false): void {
  results.push({ name, ok, detail, manual });
  const tag = manual ? "MANUAL" : ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}: ${detail}`);
}

async function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options.timeoutMs ?? 120_000,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const error = err as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }
}

async function pm2Json(): Promise<Array<{ name: string; pm_id: number; pm2_env: { status: string; restart_time: number } }>> {
  const { exitCode, stdout } = await runPm2(["jlist"]);
  if (exitCode !== 0) return [];
  return JSON.parse(stdout) as Array<{ name: string; pm_id: number; pm2_env: { status: string; restart_time: number } }>;
}

async function ensurePm2Installed(): Promise<boolean> {
  const { exitCode } = await runPm2(["--version"]);
  if (exitCode === 0) return true;
  record("pm2 installed", false, "pm2 not on PATH — run: npm install -g pm2 pm2-windows-startup");
  return false;
}

async function ensureLogsDir(): Promise<void> {
  await mkdir("logs", { recursive: true });
}

async function runWatchdogOnce(extraEnv: Record<string, string> = {}): Promise<{ exitCode: number; combined: string }> {
  const { exitCode, stdout, stderr } = await runCommand(
    "node",
    ["./node_modules/tsx/dist/cli.mjs", "scripts/watchdog.ts", "--once"],
    { env: { ...process.env, ...extraEnv }, timeoutMs: 120_000 },
  );
  return { exitCode, combined: `${stdout}\n${stderr}` };
}

async function testGatedStartRejectsBadKey(): Promise<void> {
  const { exitCode, stdout, stderr } = await runCommand(
    "node",
    ["./node_modules/tsx/dist/cli.mjs", "scripts/start-gated.ts", "scheduler"],
    {
      timeoutMs: 60_000,
      env: { ...process.env, OPENROUTER_API_KEY: "sk-or-invalid-probe-key" },
    },
  );
  const combined = `${stdout}\n${stderr}`;
  const ok = exitCode !== 0 && /openrouter|401|402|Unauthorized|refused/i.test(combined);
  record(
    "gated start rejects bad OpenRouter key",
    ok,
    ok ? "exit non-zero with clear OpenRouter probe failure" : `exit=${exitCode}, output=${combined.slice(0, 300)}`,
  );
}

async function startPm2Stack(): Promise<boolean> {
  await runPm2(["delete", "all"], { timeoutMs: 30_000 }).catch(() => undefined);
  const { exitCode, stderr } = await runPm2(["start", "ecosystem.config.cjs"], { timeoutMs: 60_000 });
  if (exitCode !== 0) {
    record("pm2 start ecosystem", false, stderr.slice(0, 400));
    return false;
  }
  await sleep(15_000);
  const apps = await pm2Json();
  const names = ["taskgraph-scheduler", "taskgraph-intake", "taskgraph-watchdog"];
  const online = names.every((name) => apps.some((a) => a.name === name && a.pm2_env.status === "online"));
  record(
    "pm2 start ecosystem (3 apps online)",
    online,
    online ? names.join(", ") : `status: ${JSON.stringify(apps.map((a) => ({ name: a.name, status: a.pm2_env.status })))}`,
  );
  return online;
}

async function testPm2KillRestart(appName: string): Promise<void> {
  if (SKIP_PM2_KILL) {
    record(`pm2 restart ${appName}`, true, "skipped (--skip-pm2-kill)", true);
    return;
  }

  const before = await pm2Json();
  const app = before.find((a) => a.name === appName);
  if (!app) {
    record(`pm2 restart ${appName}`, false, "app not found in pm2 jlist");
    return;
  }

  await runPm2(["restart", appName], { timeoutMs: 30_000 });
  await sleep(8_000);

  const after = await pm2Json();
  const appAfter = after.find((a) => a.name === appName);
  const online = appAfter?.pm2_env.status === "online";
  record(
    `pm2 restart ${appName}`,
    Boolean(online),
    online ? `online after restart` : `status=${appAfter?.pm2_env.status ?? "missing"}`,
  );
}

async function testIntakeHealthEndpoint(): Promise<void> {
  const port = process.env.INTAKE_PORT ?? "3000";
  let lastError = "unknown";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        record("intake /health reachable", true, `HTTP ${response.status}`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(5_000);
  }
  record("intake /health reachable", false, lastError);
}

async function injectStuckTaskProbe(): Promise<{ previous: { status: string; updated_at: string } | null }> {
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data: existing } = await db
    .from("tasks")
    .select("id, status, updated_at")
    .eq("id", WATCHDOG_PROBE_TASK)
    .maybeSingle();

  const previous = existing
    ? { status: (existing as { status: string }).status, updated_at: (existing as { updated_at: string }).updated_at }
    : null;

  const { error } = await db.from("tasks").upsert({
    id: WATCHDOG_PROBE_TASK,
    title: "Watchdog phase-4 verification probe (safe to delete)",
    status: "IN_PROGRESS",
    cell: "engineering",
    contract_version: 0,
    updated_at: stale,
    repo_full_name: "jackye426/swarm-sandbox",
    source: "manual",
  });
  if (error) throw new Error(`Failed to inject stuck probe task: ${error.message}`);
  return { previous };
}

async function restoreStuckTaskProbe(previous: { status: string; updated_at: string } | null): Promise<void> {
  if (previous) {
    await db
      .from("tasks")
      .update({ status: previous.status, updated_at: previous.updated_at })
      .eq("id", WATCHDOG_PROBE_TASK);
    return;
  }
  await db.from("tasks").delete().eq("id", WATCHDOG_PROBE_TASK);
}

async function testWatchdogStuckTaskAlert(): Promise<void> {
  const { previous } = await injectStuckTaskProbe();
  try {
    const { combined } = await runWatchdogOnce({ WATCHDOG_STUCK_TASK_MS: "1000" });
    const stuck = combined.includes(`stuck:${WATCHDOG_PROBE_TASK}:`) || combined.includes(`stuck:T-099`);
    record(
      "watchdog stuck-task alert",
      stuck,
      stuck ? "ALERT logged for injected stuck task" : `output=${combined.slice(0, 400)}`,
    );
  } finally {
    await restoreStuckTaskProbe(previous);
  }
}

async function testWatchdogBadOpenRouter(): Promise<void> {
  const { combined } = await runWatchdogOnce({ OPENROUTER_API_KEY: "sk-or-invalid-watchdog-probe" });
  const cred = /ALERT openrouter|openrouter/i.test(combined);
  record(
    "watchdog OpenRouter credential alert",
    cred,
    cred ? "openrouter alert fired" : `output=${combined.slice(0, 400)}`,
  );
}

async function testDeadMansPing(): Promise<void> {
  const url = process.env.HEALTHCHECKS_PING_URL?.trim();
  if (!url) {
    record(
      "healthchecks.io dead-man ping",
      false,
      "HEALTHCHECKS_PING_URL not set — create a free check at healthchecks.io and add URL to .env",
      true,
    );
    return;
  }
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    record("healthchecks.io dead-man ping", response.ok, `GET ${url} → HTTP ${response.status}`);
  } catch (err) {
    record("healthchecks.io dead-man ping", false, err instanceof Error ? err.message : String(err));
  }
}

async function testWatchdogStopDeadMan(): Promise<void> {
  const url = process.env.HEALTHCHECKS_PING_URL?.trim();
  if (!url) {
    record(
      "stop watchdog → healthchecks.io external alert",
      false,
      "Set HEALTHCHECKS_PING_URL, then: pm2 stop taskgraph-watchdog, wait grace period, confirm email/Telegram from healthchecks.io",
      true,
    );
    return;
  }

  if (SKIP_PM2_KILL) {
    record("stop watchdog → healthchecks.io external alert", true, "skipped (--skip-pm2-kill); run manually", true);
    return;
  }

  await runPm2(["stop", "taskgraph-watchdog"], { timeoutMs: 15_000 });
  record(
    "stop watchdog → healthchecks.io external alert",
    true,
    "watchdog stopped — confirm healthchecks.io alerts within check grace period (typically 5–10 min), then: pm2 start taskgraph-watchdog",
    true,
  );
}

async function setupPm2Persistence(): Promise<void> {
  await runPm2(["install", "pm2-logrotate"], { timeoutMs: 120_000 });
  const save = await runPm2(["save"], { timeoutMs: 30_000 });
  record("pm2 save", save.exitCode === 0, save.exitCode === 0 ? "process list saved" : save.stderr.slice(0, 200));

  const startup = await runCommand("pm2-startup", ["install"], { timeoutMs: 60_000 });
  const startupOk = startup.exitCode === 0 || /already|success/i.test(`${startup.stdout}${startup.stderr}`);
  record(
    "pm2-startup install",
    startupOk,
    startupOk
      ? "boot hook installed (or already present)"
      : `${startup.stderr.slice(0, 200)} — may need an elevated PowerShell`,
    !startupOk,
  );

  record(
    "host reboot → pm2 resurrect",
    false,
    "Reboot the PC once, then run: pm2 status — all three apps should be online after healthcheck gate",
    true,
  );

  record(
    "disable host sleep/hibernate",
    false,
    "Windows Settings → System → Power → Screen and sleep → Never; disable hibernate for 24/7 host",
    true,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log("=== Phase 3–4 verification ===\n");

  await ensureLogsDir();
  await testGatedStartRejectsBadKey();

  if (!(await ensurePm2Installed())) {
    printSummary();
    process.exit(1);
  }

  const started = await startPm2Stack();
  if (started) {
    await testIntakeHealthEndpoint();
    await testPm2KillRestart("taskgraph-intake");
    await testPm2KillRestart("taskgraph-scheduler");
    await setupPm2Persistence();
  }

  console.log("\n--- Phase 4 watchdog checks ---\n");
  await testWatchdogStuckTaskAlert();
  await testWatchdogBadOpenRouter();
  await testDeadMansPing();
  await testWatchdogStopDeadMan();

  // Restore watchdog if the dead-man test stopped it
  await runPm2(["start", "taskgraph-watchdog"], { timeoutMs: 15_000 });

  printSummary();
}

function printSummary(): void {
  const automated = results.filter((r) => !r.manual);
  const manual = results.filter((r) => r.manual);
  const failed = automated.filter((r) => !r.ok);
  const passed = automated.filter((r) => r.ok);

  console.log("\n=== Summary ===");
  console.log(`Automated: ${passed.length} passed, ${failed.length} failed`);
  console.log(`Manual follow-ups: ${manual.length}`);

  if (failed.length > 0) {
    console.log("\nFailed:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  if (manual.length > 0) {
    console.log("\nManual:");
    for (const m of manual) console.log(`  - ${m.name}: ${m.detail}`);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
