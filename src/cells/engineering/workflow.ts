import { StateGraph, Annotation } from "@langchain/langgraph";
import path from "node:path";
import os from "node:os";
import { writeFile, mkdir, access, readFile } from "node:fs/promises";
import type { TaskContract, EvidenceRecord } from "../../core/types.js";
import { runCommand, runShellCommand, type CommandResult } from "../../core/command.js";
import {
  classifyAcceptanceCriterion,
  extractCommandFromVerification,
  primaryAcKind,
} from "../../core/contract-executability.js";
import { invokeRoleModel } from "../../core/model-router.js";
import {
  getLatestEngineeringWorktree,
  getTaskRepo,
  recordArtifact,
  recordEvidence,
} from "../../db/records.js";
import { parseGitHubRemoteUrl } from "../../core/repo.js";
import { transitionTaskStatus } from "../../db/tasks.js";
import {
  hasStagedChanges,
  lastCommitHasExcludedPaths,
  lastCommitHasScopeOutPaths,
  removeExcludedFilesFromDisk,
  restoreScopeOutFilesBeforeCommit,
  stageAllExceptExcluded,
  undoLastCommitKeepingChanges,
  unstageExcludedPaths,
} from "./commit-staging.js";
import { scrubHarnessLinesFromGitignore, writeWorktreeSupportFiles } from "./worktree-support.js";
import { fileMatchesScopeOutItem } from "./commit-guard.js";
import { readKnowledgeExcerpt } from "../../core/knowledge-excerpt.js";
import { buildClaudeCodePipeShellCommand } from "./claude-code-config.js";

const EngineeringState = Annotation.Root({
  taskId: Annotation<string>(),
  agentRunId: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  contextPacketId: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  contract: Annotation<TaskContract>(),
  contextPacket: Annotation<string>(),
  testCommands: Annotation<string[]>({ default: () => [], reducer: (_, v) => v }),
  repoRoot: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  worktreePath: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  branchName: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  repoHasHead: Annotation<boolean>({ default: () => true, reducer: (_, v) => v }),
  baseSha: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  preserveWorktreeBase: Annotation<boolean>({ default: () => false, reducer: (_, v) => v }),
  commitSha: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  implementationPlan: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  implementationReport: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  prUrl: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  ciOutput: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  testResults: Annotation<CommandResult[]>({ default: () => [], reducer: (_, v) => v }),
  evidencePackage: Annotation<EvidenceRecord[]>({ default: () => [], reducer: (_, v) => v }),
  scopeExpansionDeclared: Annotation<boolean>({ default: () => false, reducer: (_, v) => v }),
  error: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
});

type S = typeof EngineeringState.State;

async function resolveHeadSha(worktreePath: string): Promise<string | null> {
  const result = await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: worktreePath });
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

async function resolveBranchBaseSha(worktreePath: string, branchName: string): Promise<string | null> {
  const mergeBase = await runCommand("git", ["merge-base", "HEAD", branchName], { cwd: worktreePath });
  if (mergeBase.exitCode === 0 && mergeBase.stdout.trim()) return mergeBase.stdout.trim();
  return resolveHeadSha(worktreePath);
}

async function resolveRepoRoot(state: S): Promise<Partial<S>> {
  const taskRepo = await getTaskRepo(state.taskId);
  const storageRoot = process.env.TASKGRAPH_WORKTREE_ROOT ?? path.join(os.tmpdir(), "taskgraph-os");

  if (!taskRepo.repoFullName) {
    // No external repo — work inside the current process's checkout.
    return { repoRoot: process.cwd() };
  }

  // Check if the task's repo matches the local CWD repo.
  const localRemote = await runCommand("git", ["remote", "get-url", "origin"]);
  const localFullName = localRemote.exitCode === 0
    ? parseGitHubRemoteUrl(localRemote.stdout.trim())
    : null;

  if (localFullName === taskRepo.repoFullName) {
    return { repoRoot: process.cwd() };
  }

  // External repo — clone into the worktree storage area if not already present.
  const [owner, name] = taskRepo.repoFullName.split("/");
  const cloneDir = path.join(storageRoot, "repos", owner!, name!);

  let cloneDirExists = false;
  try {
    await access(path.join(cloneDir, ".git"));
    cloneDirExists = true;
  } catch { /* not cloned yet */ }

  if (cloneDirExists) {
    const fetch = await runCommand("git", ["fetch", "--depth", "50", "origin"], { cwd: cloneDir, timeoutMs: 120_000 });
    if (fetch.exitCode !== 0) {
      const hasHead = await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: cloneDir });
      const fetchOut = (fetch.stderr || fetch.stdout).toLowerCase();
      if (hasHead.exitCode !== 0) {
        // Empty repositories have no HEAD to fetch/reset yet. Use the clone as
        // the initial worktree and let createWorktree create an orphan branch.
        return { repoRoot: cloneDir, repoHasHead: false };
      }
      if (fetchOut.includes("couldn't find remote ref head")) {
        // Remote is still empty, but the local clone may have an in-progress
        // task branch from an earlier attempt. Continue from local state.
        return { repoRoot: cloneDir, repoHasHead: true };
      }
      if (
        fetchOut.includes("could not connect") ||
        fetchOut.includes("failed to connect") ||
        fetchOut.includes("unable to access") ||
        fetchOut.includes("connection timed out") ||
        fetchOut.includes("timed out") ||
        fetchOut.includes("econnreset") ||
        fetchOut.includes("network")
      ) {
        const currentBranch = await runCommand("git", ["branch", "--show-current"], { cwd: cloneDir });
        const branch = currentBranch.stdout.trim();
        const expectedTaskBranch = `taskgraph/${state.taskId.toLowerCase()}`;
        if (branch.startsWith("taskgraph/") && branch !== expectedTaskBranch) {
          return {
            error:
              `Failed to fetch ${taskRepo.repoFullName}, and local clone is on ${branch}. ` +
              `Refusing to start ${state.taskId} from another task branch without a refreshed base.`,
          };
        }
        console.warn(
          `[Engineering Cell] git fetch failed for ${taskRepo.repoFullName}; continuing with local clone`,
        );
        return { repoRoot: cloneDir, repoHasHead: true };
      }
      return { error: `Failed to fetch ${taskRepo.repoFullName}: ${fetch.stderr || fetch.stdout}` };
    }

    await runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: cloneDir, timeoutMs: 120_000 });
    const reset = await runCommand("git", ["reset", "--hard", "origin/HEAD"], { cwd: cloneDir, timeoutMs: 120_000 });
    if (reset.exitCode !== 0) {
      const hasHead = await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: cloneDir });
      if (hasHead.exitCode !== 0) {
        return { repoRoot: cloneDir, repoHasHead: false };
      }
      return { error: `Failed to refresh ${taskRepo.repoFullName} to origin/HEAD: ${reset.stderr || reset.stdout}` };
    }
  } else {
    const token = process.env.GITHUB_TOKEN?.trim();
    const cloneUrl = token
      ? `https://x-access-token:${token}@github.com/${taskRepo.repoFullName}.git`
      : `https://github.com/${taskRepo.repoFullName}.git`;

    await mkdir(path.dirname(cloneDir), { recursive: true });
    const clone = await runCommand("git", ["clone", "--depth", "50", cloneUrl, cloneDir], { timeoutMs: 300_000 });
    if (clone.exitCode !== 0) {
      return { error: `Failed to clone ${taskRepo.repoFullName}: ${clone.stderr || clone.stdout}` };
    }
  }

  const head = await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: cloneDir });
  return { repoRoot: cloneDir, repoHasHead: head.exitCode === 0 };
}

async function compileContextPacket(state: S): Promise<Partial<S>> {
  await recordArtifact({
    taskId: state.taskId,
    artifactType: "engineering_context_packet",
    content: {
      agent_run_id: state.agentRunId,
      context_packet_id: state.contextPacketId,
      content: state.contextPacket,
    },
  });
  return {};
}

async function createWorktree(state: S): Promise<Partial<S>> {
  if (!state.repoRoot) return { error: "Cannot create worktree: repo root not resolved" };

  const storageRoot = process.env.TASKGRAPH_WORKTREE_ROOT ?? path.join(os.tmpdir(), "taskgraph-os");
  const branchName = `taskgraph/${state.taskId.toLowerCase()}`;
  const priorWorktree = await getLatestEngineeringWorktree(state.taskId);
  const preservePriorBase = state.preserveWorktreeBase && priorWorktree !== null;

  const currentBranch = await runCommand("git", ["branch", "--show-current"], { cwd: state.repoRoot });
  if (currentBranch.stdout.trim() === branchName) {
    const baseSha = preservePriorBase
      ? priorWorktree.baseSha ?? null
      : await resolveBranchBaseSha(state.repoRoot, branchName);
    const headSha = await resolveHeadSha(state.repoRoot);
    await writeWorktreeSupportFiles(state.repoRoot, state.taskId, state.contract);
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "engineering_worktree",
      content: {
        agent_run_id: state.agentRunId,
        path: state.repoRoot,
        branch: branchName,
        base_sha: baseSha,
        head_sha: headSha,
        mode: "reuse_repo_root_task_branch",
      },
    });
    return { worktreePath: state.repoRoot, branchName, baseSha };
  }

  if (!state.repoHasHead) {
    const checkout = await runCommand("git", ["checkout", "--orphan", branchName], { cwd: state.repoRoot });
    if (checkout.exitCode !== 0 && !checkout.stderr.includes("already exists")) {
      return { error: `Failed to create orphan branch for empty repo: ${checkout.stderr || checkout.stdout}` };
    }
    await writeWorktreeSupportFiles(state.repoRoot, state.taskId, state.contract);
    const headSha = await resolveHeadSha(state.repoRoot);
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "engineering_worktree",
      content: {
        agent_run_id: state.agentRunId,
        path: state.repoRoot,
        branch: branchName,
        base_sha: null,
        head_sha: headSha,
        mode: "empty_repo_orphan_branch",
      },
    });
    return { worktreePath: state.repoRoot, branchName, baseSha: null };
  }

  const baseSha = preservePriorBase
    ? priorWorktree.baseSha ?? null
    : await resolveHeadSha(state.repoRoot);
  const worktreePath = path.join(storageRoot, state.taskId);
  // git outputs forward-slash paths on all platforms; normalize for comparison
  const worktreePathUnix = worktreePath.replace(/\\/g, "/");

  await runCommand("git", ["worktree", "prune"], { cwd: state.repoRoot });
  const existing = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: state.repoRoot });
  const worktreeExists = existing.stdout.includes(worktreePathUnix) || existing.stdout.includes(worktreePath);

  if (!worktreeExists) {
    const result = await runCommand("git", ["worktree", "add", "-B", branchName, worktreePath, "HEAD"], { cwd: state.repoRoot });
    if (result.exitCode !== 0) {
      // Branch may already be checked out in the worktree — try without -B
      const retry = await runCommand("git", ["worktree", "add", worktreePath, branchName], { cwd: state.repoRoot });
      if (retry.exitCode !== 0) {
        return { error: `Failed to create git worktree: ${result.stderr || result.stdout}` };
      }
    }
  } else if (!preservePriorBase && baseSha) {
    const reset = await runCommand("git", ["reset", "--hard", baseSha], { cwd: worktreePath });
    if (reset.exitCode !== 0) {
      return { error: `Failed to reset existing worktree to clean base ${baseSha}: ${reset.stderr || reset.stdout}` };
    }
  }

  await writeWorktreeSupportFiles(worktreePath, state.taskId, state.contract);
  const headSha = await resolveHeadSha(worktreePath);

  await recordArtifact({
    taskId: state.taskId,
    artifactType: "engineering_worktree",
    content: {
      agent_run_id: state.agentRunId,
      path: worktreePath,
      branch: branchName,
      base_sha: baseSha,
      head_sha: headSha,
    },
  });
  return { worktreePath, branchName, baseSha };
}

async function installDependencies(state: S): Promise<Partial<S>> {
  if (!state.worktreePath) return { error: "Cannot install dependencies without a worktree path" };

  const packageJsonPath = path.join(state.worktreePath, "package.json");
  try {
    await access(packageJsonPath);
  } catch {
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "dependency_install_skipped",
      content: {
        agent_run_id: state.agentRunId,
        reason: "No package.json exists before implementation; worker may be bootstrapping the repo.",
      },
    });
    return {};
  }

  try {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const hasDependencies =
      Object.keys(pkg.dependencies ?? {}).length > 0 ||
      Object.keys(pkg.devDependencies ?? {}).length > 0;
    const hasLockfile = await access(path.join(state.worktreePath, "package-lock.json"))
      .then(() => true)
      .catch(() => false);

    if (!hasDependencies && !hasLockfile) {
      await recordArtifact({
        taskId: state.taskId,
        artifactType: "dependency_install_skipped",
        content: {
          agent_run_id: state.agentRunId,
          reason: "package.json has no dependencies and no lockfile; npm install would only create package-lock.json.",
        },
      });
      return {};
    }
  } catch {
    // Fall through to npm so invalid package.json surfaces as a normal install/test failure.
  }

  const ciResult = await runShellCommand("npm ci --prefer-offline", {
    cwd: state.worktreePath,
    timeoutMs: 180_000,
  });

  if (ciResult.exitCode === 0) return {};

  // npm ci failed (e.g. lockfile mismatch) — fall back to npm install
  const installResult = await runShellCommand("npm install", {
    cwd: state.worktreePath,
    timeoutMs: 180_000,
  });

  if (installResult.exitCode !== 0) {
    return { error: `Failed to install dependencies in worktree: ${installResult.stderr || installResult.stdout}` };
  }
  return {};
}

async function planImplementation(state: S): Promise<Partial<S>> {
  const acList = state.contract.acceptance_criteria
    .map((ac) => `  ${ac.id}: ${ac.requirement} [verify: ${ac.verification.join(", ")}]`)
    .join("\n");

  const implementationPlan = await invokeRoleModel("engineering_plan", [
    {
      role: "system",
      content: `You are a senior software engineer. Produce a precise implementation plan.
Map each acceptance criterion to code changes, tests, and evidence. Do not expand scope silently.
If work requires touching scope-out areas, declare the expansion explicitly.`,
    },
    {
      role: "user",
      content: `Contract: ${state.contract.id} - ${state.contract.title}

Goal: ${state.contract.goal}

Scope in:
${state.contract.scope.in.map((s) => `  - ${s}`).join("\n")}

Scope out (do not modify without declaring expansion):
${state.contract.scope.out.length > 0 ? state.contract.scope.out.map((s) => `  - ${s}`).join("\n") : "  (none listed)"}

Constraints:
${state.contract.constraints.map((c) => `  - ${c}`).join("\n")}

Acceptance criteria:
${acList}

Context:
${state.contextPacket}`,
    },
  ], { temperature: 0.1 });
  await recordArtifact({
    taskId: state.taskId,
    artifactType: "implementation_plan",
    content: { agent_run_id: state.agentRunId, text: implementationPlan },
  });
  return { implementationPlan };
}

async function invokeClaudeCode(state: S): Promise<Partial<S>> {
  if (!state.worktreePath) return { error: "Cannot invoke worker without a worktree path" };
  if (!state.implementationPlan) return { error: "Cannot invoke worker without an implementation plan" };

  const workerCommand = process.env.CLAUDE_CODE_COMMAND ?? "claude";
  const timeoutMs = Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 1_800_000);

  let result: CommandResult;

  if (process.env.CLAUDE_CODE_ARGS) {
    const workerArgs = JSON.parse(process.env.CLAUDE_CODE_ARGS) as string[];
    result = await runCommand(workerCommand, workerArgs, { cwd: state.worktreePath, timeoutMs });
  } else {
    // Write the plan to a file so we don't hit shell quoting/length limits,
    // and use runShellCommand so Windows .ps1 claude scripts execute correctly.
    // Wrap the plan in an authorization header so Claude Code doesn't stop at
    // any approval-gate language in the contract — the task is already IN_PROGRESS,
    // meaning all human approvals have been recorded.
    // Source: system-knowledge/policies/agent-permissions.md#scope-enforcement-prompt-excerpt (v1)
    const scopeRules = readKnowledgeExcerpt(
      "policies/agent-permissions.md",
      "### Scope enforcement (prompt excerpt)",
    );
    const scopeOutList = state.contract.scope.out.map((s) => `- ${s}`).join("\n") || "(none listed)";

    const authorizedPrompt = [
      `AUTHORIZATION: This task (${state.taskId}) is approved and IN_PROGRESS.`,
      `All human approvals have been recorded. Proceed directly with implementation.`,
      `Do not stop to ask for approval — implement all changes described below now.`,
      scopeRules.replace("{taskId}", state.taskId),
      ``,
      `Contract scope.out (do not modify these areas):`,
      scopeOutList,
      ``,
      state.implementationPlan,
    ].join("\n");

    const promptDir = path.join(os.tmpdir(), "taskgraph-os-prompts", state.taskId);
    await mkdir(promptDir, { recursive: true });
    const planFile = path.join(promptDir, `${state.agentRunId ?? "run"}.txt`);
    await writeFile(planFile, authorizedPrompt, "utf8");

    const shellCmd = buildClaudeCodePipeShellCommand(workerCommand, planFile);

    result = await runShellCommand(shellCmd, { cwd: state.worktreePath, timeoutMs });
  }

  const implementationReport = [
    `$ ${result.command}`,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join("\n");

  await recordArtifact({
    taskId: state.taskId,
    artifactType: "implementation_report",
    content: {
      agent_run_id: state.agentRunId,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  });

  if (result.exitCode !== 0) {
    return { implementationReport, error: `Worker command failed with exit ${result.exitCode}` };
  }

  return { implementationReport };
}

async function resolveTestCommands(worktreePath: string, requested: string[]): Promise<string[]> {
  const defaults = (process.env.TASKGRAPH_DEFAULT_TEST_COMMANDS ?? "npm run typecheck,npm test")
    .split(",")
    .map((command) => command.trim())
    .filter(Boolean);
  const commands = requested.length > 0 ? requested : defaults;

  let scripts: Record<string, string> = {};
  try {
    const pkgPath = path.join(worktreePath, "package.json");
    const raw = await readFile(pkgPath, "utf8");
    scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return commands;
  }

  const available: string[] = [];
  const skipped: string[] = [];
  for (const command of commands) {
    const match = command.match(/^npm run (\S+)$/);
    if (match && !scripts[match[1]!]) {
      skipped.push(command);
      continue;
    }
    available.push(command);
  }

  if (skipped.length > 0) {
    console.log(`[Engineering Cell] Skipping unavailable test commands: ${skipped.join(", ")}`);
  }
  if (available.length === 0) {
    throw new Error(`No runnable test commands after filtering. Requested: ${commands.join(", ")}`);
  }
  return available;
}

async function runTests(state: S): Promise<Partial<S>> {
  if (!state.worktreePath) return { error: "Cannot run tests without a worktree path" };

  let commands: string[];
  try {
    commands = await resolveTestCommands(state.worktreePath, state.testCommands);
  } catch (err) {
    return { error: (err as Error).message };
  }

  const results: CommandResult[] = [];
  for (const command of commands) {
    results.push(await runShellCommand(command, {
      cwd: state.worktreePath,
      timeoutMs: Number(process.env.TASKGRAPH_TEST_TIMEOUT_MS ?? 600_000),
    }));
  }

  const ciOutput = results
    .map((result) => [
      `$ ${result.command}`,
      `exit=${result.exitCode}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"))
    .join("\n\n");

  const commit = await runCommand("git", ["rev-parse", "HEAD"], { cwd: state.worktreePath });
  const commitSha = commit.exitCode === 0 ? commit.stdout.trim() : null;

  await recordArtifact({
    taskId: state.taskId,
    artifactType: "test_report",
    content: { agent_run_id: state.agentRunId, results },
  });

  if (results.some((result) => result.exitCode !== 0)) {
    return { ciOutput, testResults: results, commitSha, error: "One or more test commands failed" };
  }

  return { ciOutput, testResults: results, commitSha };
}

async function listChangedFiles(worktreePath: string): Promise<string[]> {
  const againstParent = await runCommand("git", ["diff", "--name-only", "HEAD~1", "HEAD"], {
    cwd: worktreePath,
  });
  if (againstParent.exitCode === 0 && againstParent.stdout.trim()) {
    return againstParent.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  const allTracked = await runCommand("git", ["ls-files"], { cwd: worktreePath });
  if (allTracked.exitCode === 0 && allTracked.stdout.trim()) {
    return allTracked.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  return [];
}

async function detectScopeExpansion(
  worktreePath: string,
  scopeOut: string[],
): Promise<{ expanded: boolean; matches: string[] }> {
  if (scopeOut.length === 0) return { expanded: false, matches: [] };

  const changedFiles = await listChangedFiles(worktreePath);
  const matches: string[] = [];
  for (const file of changedFiles) {
    for (const item of scopeOut) {
      if (fileMatchesScopeOutItem(file, item)) {
        matches.push(`${file} (matched scope.out: ${item})`);
      }
    }
  }
  return { expanded: matches.length > 0, matches };
}

async function applyScopeCheckResult(
  state: S,
  commitSha: string | null,
): Promise<Partial<S>> {
  if (!state.worktreePath) return { commitSha };

  const scopeCheck = await detectScopeExpansion(state.worktreePath, state.contract.scope.out);
  if (scopeCheck.expanded) {
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "scope_expansion_warning",
      content: {
        agent_run_id: state.agentRunId,
        matches: scopeCheck.matches,
        scope_out: state.contract.scope.out,
      },
    });
    return { commitSha, scopeExpansionDeclared: false };
  }

  return { commitSha };
}

async function commitChanges(state: S): Promise<Partial<S>> {
  if (!state.worktreePath) return { error: "Cannot commit without a worktree path" };

  const { worktreePath, taskId } = state;
  await scrubHarnessLinesFromGitignore(worktreePath, taskId);
  await removeExcludedFilesFromDisk(worktreePath, taskId);

  const status = await runCommand("git", ["status", "--porcelain"], { cwd: worktreePath });
  if (status.stdout.trim() === "") {
    if (await lastCommitHasExcludedPaths(worktreePath, taskId)) {
      await undoLastCommitKeepingChanges(worktreePath);
    } else if (await lastCommitHasScopeOutPaths(worktreePath, state.contract.scope.out)) {
      await undoLastCommitKeepingChanges(worktreePath);
      await scrubHarnessLinesFromGitignore(worktreePath, taskId);
      await restoreScopeOutFilesBeforeCommit(worktreePath, state.contract.scope.out, state.baseSha);
    } else {
      const sha = await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
      const commitSha = sha.exitCode === 0 ? sha.stdout.trim() : state.commitSha ?? null;
      return applyScopeCheckResult(state, commitSha);
    }
  }

  await stageAllExceptExcluded(worktreePath, taskId);
  await restoreScopeOutFilesBeforeCommit(worktreePath, state.contract.scope.out, state.baseSha);
  await unstageExcludedPaths(worktreePath, taskId);

  if (!(await hasStagedChanges(worktreePath))) {
    const sha = await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    const commitSha = sha.exitCode === 0 ? sha.stdout.trim() : state.commitSha ?? null;
    return applyScopeCheckResult(state, commitSha);
  }

  const message = `feat(${taskId}): implement via engineering cell\n\nAgent run: ${state.agentRunId}`;
  const commitAuthorName = process.env.TASKGRAPH_GIT_AUTHOR_NAME ?? "TaskGraph OS";
  const commitAuthorEmail = process.env.TASKGRAPH_GIT_AUTHOR_EMAIL ?? "taskgraph@example.local";
  const commit = await runCommand("git", [
    "-c",
    `user.name=${commitAuthorName}`,
    "-c",
    `user.email=${commitAuthorEmail}`,
    "commit",
    "-m",
    message,
  ], { cwd: worktreePath });
  if (commit.exitCode !== 0) {
    return { error: `git commit failed: ${commit.stderr || commit.stdout}` };
  }

  const sha = await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  const commitSha = sha.exitCode === 0 ? sha.stdout.trim() : null;
  await recordArtifact({
    taskId,
    artifactType: "engineering_worktree",
    content: {
      agent_run_id: state.agentRunId,
      path: worktreePath,
      branch: state.branchName,
      base_sha: state.baseSha,
      head_sha: commitSha,
      mode: "post_commit",
    },
  });
  return applyScopeCheckResult(state, commitSha);
}

async function createPullRequest(state: S): Promise<Partial<S>> {
  if (!state.worktreePath || !state.branchName) return { error: "Cannot create PR without worktree and branch" };

  const shouldCreatePr = process.env.GITHUB_CREATE_PR === "true";
  if (!shouldCreatePr) {
    const source = process.env.TASKGRAPH_EVIDENCE_SOURCE_URL ?? `https://localhost/taskgraph-os/${state.taskId}`;
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "pull_request_deferred",
      url: source,
      content: {
        agent_run_id: state.agentRunId,
        branch: state.branchName,
        reason: "Set GITHUB_CREATE_PR=true to create PRs through GitHub CLI.",
      },
    });
    return { prUrl: source };
  }

  const push = await runCommand("git", ["push", "-u", "origin", state.branchName], { cwd: state.worktreePath });
  if (push.exitCode !== 0) return { error: `Failed to push branch: ${push.stderr || push.stdout}` };

  const pr = await runCommand("gh", [
    "pr",
    "create",
    "--title",
    `${state.contract.id}: ${state.contract.title}`,
    "--body",
    `Implements ${state.contract.id}. Evidence and verification records are managed by TaskGraph OS.`,
  ], { cwd: state.worktreePath });

  if (pr.exitCode !== 0) return { error: `Failed to create PR: ${pr.stderr || pr.stdout}` };

  const prUrl = pr.stdout.trim();
  await recordArtifact({
    taskId: state.taskId,
    artifactType: "pull_request",
    url: prUrl,
    content: { agent_run_id: state.agentRunId, branch: state.branchName },
  });
  return { prUrl };
}

async function assembleEvidence(state: S): Promise<Partial<S>> {
  const testsPassed = state.testResults.length > 0 && state.testResults.every((result) => result.exitCode === 0);
  const timestamp = new Date().toISOString();
  const source = state.prUrl ?? process.env.TASKGRAPH_EVIDENCE_SOURCE_URL ?? `https://localhost/taskgraph-os/${state.taskId}`;
  const taskNumber = state.taskId.replace("T-", "");

  const evidence: EvidenceRecord[] = [];
  let evidenceIndex = 0;

  for (const ac of state.contract.acceptance_criteria) {
    const kinds = classifyAcceptanceCriterion(ac);
    const primary = primaryAcKind(kinds);

    if (primary === "human" || primary === "unknown") {
      continue;
    }

    evidenceIndex += 1;
    const evidenceId = `E-${taskNumber}${String(evidenceIndex).padStart(3, "0")}`;

    if (primary === "diff_inspection") {
      evidence.push({
        evidence_id: evidenceId,
        task_id: state.taskId,
        acceptance_criteria: [ac.id],
        type: "model_review",
        status: "inconclusive",
        commit_sha: state.commitSha ?? undefined,
        source,
        timestamp,
        summary: `${ac.id}: awaiting verification via PR diff inspection (${ac.verification.join(", ")})`,
      });
      continue;
    }

    const acCommands = ac.verification
      .map(extractCommandFromVerification)
      .filter((c): c is string => c !== null);
    const relevantResults =
      acCommands.length > 0
        ? state.testResults.filter((result) =>
            acCommands.some((cmd) => result.command.includes(cmd.replace("npm run ", ""))),
          )
        : state.testResults;
    const acTestsPassed =
      relevantResults.length > 0 && relevantResults.every((result) => result.exitCode === 0);

    evidence.push({
      evidence_id: evidenceId,
      task_id: state.taskId,
      acceptance_criteria: [ac.id],
      type: "ci_run",
      status: acTestsPassed ? "pass" : testsPassed ? "pass" : "fail",
      commit_sha: state.commitSha ?? undefined,
      source,
      command: (relevantResults.length > 0 ? relevantResults : state.testResults)
        .map((result) => result.command)
        .join(" && "),
      timestamp,
      summary: acTestsPassed
        ? `Engineering test commands passed for ${ac.id}; independent verification still required.`
        : `Engineering test commands failed or did not complete for ${ac.id}; verification should require rework.`,
    });
  }

  for (const item of evidence) {
    await recordEvidence({ ...item, agentRunId: state.agentRunId });
  }

  await transitionTaskStatus({
    taskId: state.taskId,
    to: "AWAITING_EVIDENCE",
    actor: "engineering-cell",
    payload: { agent_run_id: state.agentRunId, evidence_count: evidence.length },
  });

  return { evidencePackage: evidence };
}

function hasError(state: S): "error" | "continue" {
  return state.error ? "error" : "continue";
}

async function handleError(state: S): Promise<Partial<S>> {
  console.error(`[Engineering Cell] Error in ${state.taskId}: ${state.error}`);

  try {
    await recordArtifact({
      taskId: state.taskId,
      artifactType: "engineering_error",
      content: { agent_run_id: state.agentRunId, error: state.error },
    });
  } catch (err) {
    console.error(
      `[Engineering Cell] Could not persist engineering_error for ${state.taskId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Transition to BLOCKED so the task doesn't stay stuck at IN_PROGRESS.
  try {
    await transitionTaskStatus({
      taskId: state.taskId,
      to: "BLOCKED",
      actor: "engineering-cell",
      payload: { error: state.error, agent_run_id: state.agentRunId },
    });
  } catch {
    // Non-fatal: status stays as-is, error is already recorded in the artifact.
  }

  return {};
}

const graph = new StateGraph(EngineeringState)
  .addNode("resolveRepoRoot", resolveRepoRoot)
  .addNode("compileContextPacket", compileContextPacket)
  .addNode("createWorktree", createWorktree)
  .addNode("installDependencies", installDependencies)
  .addNode("planImplementation", planImplementation)
  .addNode("invokeClaudeCode", invokeClaudeCode)
  .addNode("runTests", runTests)
  .addNode("commitChanges", commitChanges)
  .addNode("createPullRequest", createPullRequest)
  .addNode("assembleEvidence", assembleEvidence)
  .addNode("handleError", handleError)
  .addEdge("__start__", "resolveRepoRoot")
  .addConditionalEdges("resolveRepoRoot", hasError, {
    error: "handleError",
    continue: "compileContextPacket",
  })
  .addEdge("compileContextPacket", "createWorktree")
  .addConditionalEdges("createWorktree", hasError, {
    error: "handleError",
    continue: "installDependencies",
  })
  .addConditionalEdges("installDependencies", hasError, {
    error: "handleError",
    continue: "planImplementation",
  })
  .addConditionalEdges("planImplementation", hasError, {
    error: "handleError",
    continue: "invokeClaudeCode",
  })
  .addConditionalEdges("invokeClaudeCode", hasError, {
    error: "handleError",
    continue: "runTests",
  })
  .addConditionalEdges("runTests", hasError, {
    error: "handleError",
    continue: "commitChanges",
  })
  .addConditionalEdges("commitChanges", hasError, {
    error: "handleError",
    continue: "createPullRequest",
  })
  .addConditionalEdges("createPullRequest", hasError, {
    error: "handleError",
    continue: "assembleEvidence",
  })
  .addEdge("assembleEvidence", "__end__")
  .addEdge("handleError", "__end__");

export const engineeringWorkflow = graph.compile();
