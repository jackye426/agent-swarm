import path from "node:path";
import { runCommand } from "./command.js";

export interface AssembleVerificationDiffOptions {
  baseSha?: string;
  commitSha?: string;
  prUrl?: string;
  preferGhPrDiff?: boolean;
}

export interface AssembleVerificationDiffResult {
  diff: string;
  commitSha?: string;
}

async function tryGhPrDiff(prUrl: string): Promise<string | null> {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) return null;

  const result = await runCommand("gh", ["pr", "diff", match[1]!, "--patch"], {
    timeoutMs: 120_000,
  });
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout;
  }
  return null;
}

async function resolveCommitSha(worktreePath: string, commitSha?: string): Promise<string | undefined> {
  if (commitSha?.trim()) return commitSha.trim();
  const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return undefined;
}

async function gitShowPatch(worktreePath: string, ref: string): Promise<string> {
  const result = await runCommand(
    "git",
    ["show", ref, "--stat", "--patch"],
    { cwd: worktreePath },
  );
  return result.stdout.trim();
}

async function gitRangeDiff(worktreePath: string, baseRef: string): Promise<string | null> {
  const result = await runCommand(
    "git",
    ["diff", `${baseRef}..HEAD`, "--stat", "--patch"],
    { cwd: worktreePath },
  );
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout;
  }
  return null;
}

async function findMergeBase(worktreePath: string): Promise<string | null> {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const baseResult = await runCommand("git", ["merge-base", "HEAD", ref], { cwd: worktreePath });
    if (baseResult.exitCode === 0 && baseResult.stdout.trim()) {
      return baseResult.stdout.trim();
    }
  }
  return null;
}

/**
 * Assemble a PR-style diff from an engineering worktree using a robust fallback chain.
 */
export async function assembleVerificationDiff(
  worktreePath: string,
  options: AssembleVerificationDiffOptions = {},
): Promise<AssembleVerificationDiffResult> {
  const preferGh = options.preferGhPrDiff ?? process.env.GITHUB_CREATE_PR === "true";

  if (preferGh && options.prUrl) {
    const ghDiff = await tryGhPrDiff(options.prUrl);
    if (ghDiff) {
      return {
        diff: ghDiff,
        commitSha: await resolveCommitSha(worktreePath, options.commitSha),
      };
    }
  }

  const commitSha = await resolveCommitSha(worktreePath, options.commitSha);

  if (options.baseSha?.trim()) {
    const baseDiff = await gitRangeDiff(worktreePath, options.baseSha.trim());
    if (baseDiff) {
      return { diff: baseDiff, commitSha };
    }
  }

  const mergeBase = await findMergeBase(worktreePath);
  if (mergeBase) {
    const mergeBaseDiff = await gitRangeDiff(worktreePath, mergeBase);
    if (mergeBaseDiff) {
      return { diff: mergeBaseDiff, commitSha };
    }
  }

  const countResult = await runCommand("git", ["rev-list", "--count", "HEAD"], { cwd: worktreePath });
  const commitCount = countResult.exitCode === 0 ? Number.parseInt(countResult.stdout.trim(), 10) : NaN;

  if (commitCount === 1) {
    const rootDiff = await runCommand(
      "git",
      ["diff", "--root", "HEAD", "--stat", "--patch"],
      { cwd: worktreePath },
    );
    if (rootDiff.exitCode === 0 && rootDiff.stdout.trim()) {
      return { diff: rootDiff.stdout, commitSha };
    }

    const headShow = await gitShowPatch(worktreePath, "HEAD");
    if (headShow) {
      return { diff: headShow, commitSha };
    }
  }

  const lastCommitDiff = await runCommand(
    "git",
    ["diff", "HEAD~1", "HEAD", "--stat", "--patch"],
    { cwd: worktreePath },
  );
  if (lastCommitDiff.exitCode === 0 && lastCommitDiff.stdout.trim()) {
    return { diff: lastCommitDiff.stdout, commitSha };
  }

  const fallbackShow = await gitShowPatch(worktreePath, commitSha ?? "HEAD");
  return {
    diff: fallbackShow || "(no diff — worktree may not have changes yet)",
    commitSha,
  };
}

/** Resolve worktree path from artifact content or default layout. */
export function resolveWorktreePath(
  taskId: string,
  artifactPath?: string,
  worktreeRoot?: string,
): string {
  if (artifactPath?.trim()) return artifactPath.trim();
  const root = worktreeRoot ?? process.env.TASKGRAPH_WORKTREE_ROOT ?? path.join(process.cwd(), ".worktrees");
  return path.join(root, taskId);
}
