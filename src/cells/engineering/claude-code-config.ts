/**
 * Claude Code CLI options for the engineering implementation step.
 * Env: CLAUDE_CODE_COMMAND, CLAUDE_CODE_MODEL, CLAUDE_CODE_ARGS.
 */

/** Model id passed to `claude --model` (e.g. claude-sonnet-4-20250514). Empty = CLI default. */
export function claudeCodeModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.CLAUDE_CODE_MODEL?.trim();
  return raw || undefined;
}

/** Default pipe-invocation flags (--print, permissions, optional --model). */
export function claudeCodeDefaultFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  const flags = ["--print", "--dangerously-skip-permissions"];
  const model = claudeCodeModel(env);
  if (model) flags.push("--model", model);
  return flags;
}

/** Shell-escape a single CLI argument for embedding in a pipe command. */
export function shellQuoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return `"${arg.replace(/"/g, '`"')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Build `cat plan | claude ...` (or PowerShell equivalent) for the default invocation path. */
export function buildClaudeCodePipeShellCommand(
  workerCommand: string,
  planFile: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const flagPart = claudeCodeDefaultFlags(env).map((f) => shellQuoteArg(f, platform)).join(" ");

  if (platform === "win32") {
    const escapedPlan = planFile.replace(/'/g, "''");
    return `Get-Content -LiteralPath '${escapedPlan}' -Raw | & ${workerCommand} ${flagPart}`;
  }

  const escapedPlan = planFile.replace(/'/g, "'\\''");
  return `cat '${escapedPlan}' | ${workerCommand} ${flagPart}`;
}
