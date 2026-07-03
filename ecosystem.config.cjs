/**
 * pm2 supervision config for 24/7 production.
 *
 *   pm2 start ecosystem.config.cjs        # start all three
 *   pm2 logs / pm2 monit                  # observe
 *   pm2 save && pm2-startup install       # persist across reboots (pm2-windows-startup)
 *
 * Scheduler and intake launch through scripts/start-gated.ts, which runs the
 * deep healthcheck first and exits 1 on failure — combined with
 * exp_backoff_restart_delay, a bad .env means "retry with backoff until fixed",
 * never "half-start unhealthy". tsx is invoked via its CLI entry with a node
 * interpreter because pm2 on Windows cannot spawn .cmd shims reliably.
 */

const tsx = "./node_modules/tsx/dist/cli.mjs";

const shared = {
  interpreter: "node",
  autorestart: true,
  exp_backoff_restart_delay: 5000, // ms; doubles up to 15 min between crash restarts
  max_memory_restart: "1G",
  time: true, // prefix pm2 logs with timestamps
};

module.exports = {
  apps: [
    {
      ...shared,
      name: "taskgraph-scheduler",
      script: tsx,
      args: "scripts/start-gated.ts scheduler",
      out_file: "./logs/scheduler.out.log",
      error_file: "./logs/scheduler.err.log",
      kill_timeout: 30_000, // grace for the in-flight job before SIGKILL
    },
    {
      ...shared,
      name: "taskgraph-intake",
      script: tsx,
      args: "scripts/start-gated.ts intake",
      out_file: "./logs/intake.out.log",
      error_file: "./logs/intake.err.log",
      kill_timeout: 10_000,
    },
    {
      ...shared,
      name: "taskgraph-watchdog",
      script: tsx,
      args: "scripts/watchdog.ts",
      out_file: "./logs/watchdog.out.log",
      error_file: "./logs/watchdog.err.log",
      kill_timeout: 5_000,
    },
  ],
};
