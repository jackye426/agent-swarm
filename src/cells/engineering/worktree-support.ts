import path from "node:path";
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import yaml from "js-yaml";
import type { TaskContract } from "../../core/types.js";
import { runCommand } from "../../core/command.js";
import { worktreeLocalExcludeEntries } from "./commit-guard.js";

async function resolveGitExcludePath(worktreePath: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: worktreePath,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Cannot resolve git exclude path: ${result.stderr || result.stdout}`);
  }
  const gitPath = result.stdout.trim();
  return path.isAbsolute(gitPath) ? gitPath : path.join(worktreePath, gitPath);
}

/** Append TaskGraph-only ignore rules to .git/info/exclude (never touches .gitignore). */
export async function appendWorktreeLocalExcludes(
  worktreePath: string,
  taskId: string,
): Promise<void> {
  const excludePath = await resolveGitExcludePath(worktreePath);
  await mkdir(path.dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    /* no exclude file yet */
  }

  const entries = worktreeLocalExcludeEntries(taskId);
  const missing = entries.filter(
    (entry) => !existing.split("\n").some((line) => line.trim() === entry),
  );
  if (missing.length === 0) return;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const block = (needsLeadingNewline ? "\n" : "") + missing.join("\n") + "\n";
  await writeFile(excludePath, existing + block, "utf8");
}

/** Contract copy + local git excludes for validation; harness files must not be committed. */
export async function writeWorktreeSupportFiles(
  worktreePath: string,
  taskId: string,
  contract: TaskContract,
): Promise<void> {
  const contractDir = path.join(worktreePath, "tasks", taskId);
  await mkdir(contractDir, { recursive: true });
  await writeFile(
    path.join(contractDir, "contract.yaml"),
    yaml.dump(contract, { lineWidth: 120 }),
    "utf8",
  );

  await appendWorktreeLocalExcludes(worktreePath, taskId);
}

/** Remove harness-only lines that may have been written to .gitignore by older runs. */
export async function scrubHarnessLinesFromGitignore(
  worktreePath: string,
  taskId: string,
): Promise<void> {
  const gitignorePath = path.join(worktreePath, ".gitignore");
  let content: string;
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch {
    return;
  }

  const toRemove = new Set(worktreeLocalExcludeEntries(taskId).map((entry) => entry.trim()));
  const lines = content.split("\n");
  const filtered = lines.filter((line) => !toRemove.has(line.trim()));
  if (filtered.length === lines.length) return;

  const next = filtered.join("\n");
  if (next.trim() === "") {
    await rm(gitignorePath, { force: true });
    return;
  }

  await writeFile(gitignorePath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
}
