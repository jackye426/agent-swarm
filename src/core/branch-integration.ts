import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandResult } from "./command.js";
import { parseGitHubRemoteUrl } from "./repo.js";
import { getTaskRepo } from "../db/records.js";

export interface BranchIntegrationResult {
  ok: boolean;
  detail: string;
  merged?: boolean;
}

function commandOutput(result: CommandResult): string {
  return (result.stderr || result.stdout).trim();
}

function outputHead(result: CommandResult, max = 500): string {
  const text = commandOutput(result);
  return text.length <= max ? text : text.slice(0, max);
}

async function hasGitDir(repoRoot: string): Promise<boolean> {
  try {
    await access(path.join(repoRoot, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function cleanupIntegrationWorktree(repoRoot: string, integrationPath: string): Promise<void> {
  await runCommand("git", ["worktree", "remove", "--force", integrationPath], { cwd: repoRoot });
  await runCommand("git", ["worktree", "prune"], { cwd: repoRoot });
}

async function defaultBranch(repoRoot: string): Promise<string | null> {
  await runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: repoRoot, timeoutMs: 120_000 });
  const symbolic = await runCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: repoRoot });
  if (symbolic.exitCode !== 0) return null;
  const ref = symbolic.stdout.trim();
  return ref.startsWith("refs/remotes/origin/")
    ? ref.slice("refs/remotes/origin/".length)
    : null;
}

export async function integrateTaskBranchInRepo(
  repoRoot: string,
  taskId: string,
  options: { storageRoot?: string; defaultBranchFallback?: string } = {},
): Promise<BranchIntegrationResult> {
  const branchName = `taskgraph/${taskId.toLowerCase()}`;
  const exists = await runCommand("git", ["rev-parse", "--verify", branchName], { cwd: repoRoot });
  if (exists.exitCode !== 0) {
    return { ok: false, merged: false, detail: `task branch not found: ${branchName}` };
  }

  const fallback = options.defaultBranchFallback ?? "main";
  const resolvedDefault = await defaultBranch(repoRoot);
  if (!resolvedDefault) {
    const pushInitial = await runCommand("git", ["push", "origin", `${branchName}:${fallback}`], {
      cwd: repoRoot,
      timeoutMs: 120_000,
    });
    if (pushInitial.exitCode !== 0) {
      return { ok: false, merged: false, detail: `initial default push failed: ${outputHead(pushInitial)}` };
    }
    return { ok: true, merged: true, detail: `pushed ${branchName} as ${fallback}` };
  }

  const storageRoot = options.storageRoot ?? process.env.TASKGRAPH_WORKTREE_ROOT ?? path.join(os.tmpdir(), "taskgraph-os");
  const integrationPath = path.join(storageRoot, "integration", taskId);
  await mkdir(path.dirname(integrationPath), { recursive: true });
  await cleanupIntegrationWorktree(repoRoot, integrationPath);

  const add = await runCommand("git", ["worktree", "add", integrationPath, `origin/${resolvedDefault}`], {
    cwd: repoRoot,
    timeoutMs: 120_000,
  });
  if (add.exitCode !== 0) {
    await cleanupIntegrationWorktree(repoRoot, integrationPath);
    return { ok: false, merged: false, detail: `integration worktree failed: ${outputHead(add)}` };
  }

  try {
    const merge = await runCommand(
      "git",
      ["merge", "--no-ff", branchName, "-m", `integrate(${taskId}): merge completed task branch`],
      { cwd: integrationPath, timeoutMs: 120_000 },
    );
    if (merge.exitCode !== 0) {
      await runCommand("git", ["merge", "--abort"], { cwd: integrationPath });
      return { ok: false, merged: false, detail: `merge conflict: ${outputHead(merge)}` };
    }

    const push = await runCommand("git", ["push", "origin", `HEAD:${resolvedDefault}`], {
      cwd: integrationPath,
      timeoutMs: 120_000,
    });
    if (push.exitCode !== 0) {
      return { ok: false, merged: false, detail: `push failed: ${outputHead(push)}` };
    }

    return { ok: true, merged: true, detail: `merged ${branchName} into ${resolvedDefault}` };
  } finally {
    await cleanupIntegrationWorktree(repoRoot, integrationPath);
  }
}

export async function integrateCompletedTaskBranch(taskId: string): Promise<BranchIntegrationResult> {
  if (process.env.TASKGRAPH_AUTO_INTEGRATE !== "true") {
    return { ok: true, merged: false, detail: "auto-integrate disabled" };
  }

  const taskRepo = await getTaskRepo(taskId);
  if (!taskRepo.repoFullName) {
    return { ok: true, merged: false, detail: "no external repo" };
  }

  const localRemote = await runCommand("git", ["remote", "get-url", "origin"]);
  const localFullName = localRemote.exitCode === 0
    ? parseGitHubRemoteUrl(localRemote.stdout.trim())
    : null;

  const storageRoot = process.env.TASKGRAPH_WORKTREE_ROOT ?? path.join(os.tmpdir(), "taskgraph-os");
  let repoRoot = process.cwd();
  if (localFullName !== taskRepo.repoFullName) {
    const [owner, name] = taskRepo.repoFullName.split("/");
    repoRoot = path.join(storageRoot, "repos", owner!, name!);
  }

  if (!(await hasGitDir(repoRoot))) {
    return { ok: false, merged: false, detail: `repo clone not found for ${taskRepo.repoFullName}: ${repoRoot}` };
  }

  return integrateTaskBranchInRepo(repoRoot, taskId, { storageRoot });
}
