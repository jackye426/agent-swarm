import path from "node:path";
import { rm } from "node:fs/promises";
import { runCommand } from "../../core/command.js";
import {
  commitExcludedPaths,
  fileMatchesScopeOutItem,
  filterExcludedCommitPaths,
  isExcludedCommitPath,
} from "./commit-guard.js";

export async function removeExcludedFilesFromDisk(worktreePath: string, taskId: string): Promise<void> {
  for (const rel of commitExcludedPaths(taskId)) {
    await rm(path.join(worktreePath, rel), { force: true });
  }
}

async function listCachedPaths(worktreePath: string): Promise<string[]> {
  const result = await runCommand("git", ["diff", "--cached", "--name-only"], { cwd: worktreePath });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function unstageExcludedPaths(worktreePath: string, taskId: string): Promise<void> {
  const excluded = filterExcludedCommitPaths(taskId, await listCachedPaths(worktreePath));
  if (excluded.length === 0) return;
  await runCommand("git", ["reset", "HEAD", "--", ...excluded], { cwd: worktreePath });
}

export async function lastCommitFilePaths(worktreePath: string): Promise<string[]> {
  const show = await runCommand("git", ["show", "--name-only", "--pretty=format:", "HEAD"], {
    cwd: worktreePath,
  });
  if (show.exitCode !== 0 || !show.stdout.trim()) return [];
  return show.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function lastCommitHasExcludedPaths(worktreePath: string, taskId: string): Promise<boolean> {
  const files = await lastCommitFilePaths(worktreePath);
  return files.some((file) => isExcludedCommitPath(taskId, file));
}

export async function lastCommitHasScopeOutPaths(
  worktreePath: string,
  scopeOut: string[],
): Promise<boolean> {
  if (scopeOut.length === 0) return false;
  const files = await lastCommitFilePaths(worktreePath);
  return files.some((file) => scopeOut.some((item) => fileMatchesScopeOutItem(file, item)));
}

/** Restore scope-out paths to their pre-branch state (delete if the branch introduced them). */
export async function restoreScopeOutFilesBeforeCommit(
  worktreePath: string,
  scopeOut: string[],
  baseSha?: string | null,
): Promise<void> {
  for (const item of scopeOut) {
    if (item.includes("*")) continue;
    const relPath = item.replace(/^\.\//, "");

    if (baseSha) {
      const baseHas = await runCommand("git", ["cat-file", "-e", `${baseSha}:${relPath}`], {
        cwd: worktreePath,
      });
      if (baseHas.exitCode === 0) {
        await runCommand("git", ["checkout", baseSha, "--", relPath], { cwd: worktreePath });
      } else {
        await runCommand("git", ["rm", "-f", "--ignore-unmatch", "--", relPath], { cwd: worktreePath });
      }
      continue;
    }

    const intro = await runCommand(
      "git",
      ["log", "--diff-filter=A", "--format=%H", "-1", "--", relPath],
      { cwd: worktreePath },
    );
    if (intro.exitCode !== 0 || !intro.stdout.trim()) {
      await runCommand("git", ["rm", "-f", "--ignore-unmatch", "--", relPath], { cwd: worktreePath });
      continue;
    }

    const parentRef = `${intro.stdout.trim()}~1`;
    const parentHas = await runCommand("git", ["cat-file", "-e", `${parentRef}:${relPath}`], {
      cwd: worktreePath,
    });
    if (parentHas.exitCode !== 0) {
      await runCommand("git", ["rm", "-f", "--ignore-unmatch", "--", relPath], { cwd: worktreePath });
      continue;
    }

    await runCommand("git", ["checkout", parentRef, "--", relPath], { cwd: worktreePath });
  }
}

/** @deprecated Prefer restoreScopeOutFilesBeforeCommit — HEAD may already include harness leaks. */
export async function revertStagedScopeOutFiles(
  worktreePath: string,
  scopeOut: string[],
): Promise<void> {
  await restoreScopeOutFilesBeforeCommit(worktreePath, scopeOut);
}

export async function undoLastCommitKeepingChanges(worktreePath: string): Promise<void> {
  const parent = await runCommand("git", ["rev-parse", "--verify", "HEAD~1"], { cwd: worktreePath });
  if (parent.exitCode === 0) {
    await runCommand("git", ["reset", "--soft", "HEAD~1"], { cwd: worktreePath });
  } else {
    await runCommand("git", ["reset", "--mixed", "HEAD"], { cwd: worktreePath });
  }
}

export async function stageAllExceptExcluded(worktreePath: string, taskId: string): Promise<void> {
  await runCommand("git", ["add", "-A"], { cwd: worktreePath });
  await unstageExcludedPaths(worktreePath, taskId);
}

export async function hasStagedChanges(worktreePath: string): Promise<boolean> {
  const staged = await listCachedPaths(worktreePath);
  return staged.length > 0;
}
