import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  command: string;
  cwd?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<CommandResult> {
  const rendered = [command, ...args].join(" ");
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 1024 * 1024 * 20,
      windowsHide: true,
    });
    return {
      command: rendered,
      cwd: options.cwd,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    const error = err as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      command: rendered,
      cwd: options.cwd,
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }
}

export async function runShellCommand(
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<CommandResult> {
  const shell = process.platform === "win32" ? "powershell.exe" : "sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-Command", command]
    : ["-lc", command];
  return runCommand(shell, args, options);
}
