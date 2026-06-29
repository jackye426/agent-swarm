import { StateGraph, Annotation } from "@langchain/langgraph";
import path from "node:path";
import os from "node:os";
import type { TaskContract, EvidenceRecord } from "../../core/types.js";
import { runCommand, runShellCommand, type CommandResult } from "../../core/command.js";
import { invokeRoleModel } from "../../core/model-router.js";
import { recordArtifact, recordEvidence } from "../../db/records.js";
import { transitionTaskStatus } from "../../db/tasks.js";

const EngineeringState = Annotation.Root({
  taskId: Annotation<string>(),
  agentRunId: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  contextPacketId: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  contract: Annotation<TaskContract>(),
  contextPacket: Annotation<string>(),
  testCommands: Annotation<string[]>({ default: () => [], reducer: (_, v) => v }),
  worktreePath: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  branchName: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
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
  const root = process.env.TASKGRAPH_WORKTREE_ROOT ?? path.join(os.tmpdir(), "taskgraph-os");
  const branchName = `taskgraph/${state.taskId.toLowerCase()}`;
  const worktreePath = path.join(root, state.taskId);

  await runCommand("git", ["worktree", "prune"]);
  const existing = await runCommand("git", ["worktree", "list", "--porcelain"]);
  if (!existing.stdout.includes(worktreePath)) {
    const result = await runCommand("git", ["worktree", "add", "-B", branchName, worktreePath, "HEAD"]);
    if (result.exitCode !== 0) {
      return { error: `Failed to create git worktree: ${result.stderr || result.stdout}` };
    }
  }

  await recordArtifact({
    taskId: state.taskId,
    artifactType: "engineering_worktree",
    content: { agent_run_id: state.agentRunId, path: worktreePath, branch: branchName },
  });
  return { worktreePath, branchName };
}

async function planImplementation(state: S): Promise<Partial<S>> {
  const acList = state.contract.acceptance_criteria
    .map((ac) => `  ${ac.id}: ${ac.requirement} [verify: ${ac.verification.join(", ")}]`)
    .join("\n");

  const implementationPlan = await invokeRoleModel("engineering_plan", [
    {
      role: "system",
      content: `You are a senior software engineer. Produce a precise implementation plan.
Map each acceptance criterion to code changes, tests, and evidence. Do not expand scope silently.`,
    },
    {
      role: "user",
      content: `Contract: ${state.contract.id} - ${state.contract.title}

Goal: ${state.contract.goal}

Scope in:
${state.contract.scope.in.map((s) => `  - ${s}`).join("\n")}

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
  const workerArgs = process.env.CLAUDE_CODE_ARGS
    ? JSON.parse(process.env.CLAUDE_CODE_ARGS) as string[]
    : ["--print", state.implementationPlan];

  const result = await runCommand(workerCommand, workerArgs, {
    cwd: state.worktreePath,
    timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 1_800_000),
  });

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

async function runTests(state: S): Promise<Partial<S>> {
  if (!state.worktreePath) return { error: "Cannot run tests without a worktree path" };

  const commands = state.testCommands.length > 0
    ? state.testCommands
    : (process.env.TASKGRAPH_DEFAULT_TEST_COMMANDS ?? "npm run typecheck,npm test,npm run validate")
      .split(",")
      .map((command) => command.trim())
      .filter(Boolean);

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

  const evidence: EvidenceRecord[] = state.contract.acceptance_criteria.map((ac, i) => ({
    evidence_id: `E-${taskNumber}${String(i + 1).padStart(3, "0")}`,
    task_id: state.taskId,
    acceptance_criteria: [ac.id],
    type: "ci_run",
    status: testsPassed ? "pass" : "fail",
    commit_sha: state.commitSha ?? undefined,
    source,
    command: state.testResults.map((result) => result.command).join(" && "),
    timestamp,
    summary: testsPassed
      ? `Engineering test commands passed for ${ac.id}; independent verification still required.`
      : `Engineering test commands failed or did not complete for ${ac.id}; verification should require rework.`,
  }));

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
  await recordArtifact({
    taskId: state.taskId,
    artifactType: "engineering_error",
    content: { agent_run_id: state.agentRunId, error: state.error },
  });
  console.error(`[Engineering Cell] Error in ${state.taskId}: ${state.error}`);
  return {};
}

const graph = new StateGraph(EngineeringState)
  .addNode("compileContextPacket", compileContextPacket)
  .addNode("createWorktree", createWorktree)
  .addNode("planImplementation", planImplementation)
  .addNode("invokeClaudeCode", invokeClaudeCode)
  .addNode("runTests", runTests)
  .addNode("createPullRequest", createPullRequest)
  .addNode("assembleEvidence", assembleEvidence)
  .addNode("handleError", handleError)
  .addEdge("__start__", "compileContextPacket")
  .addEdge("compileContextPacket", "createWorktree")
  .addConditionalEdges("createWorktree", hasError, {
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
    continue: "createPullRequest",
  })
  .addConditionalEdges("createPullRequest", hasError, {
    error: "handleError",
    continue: "assembleEvidence",
  })
  .addEdge("assembleEvidence", "__end__")
  .addEdge("handleError", "__end__");

export const engineeringWorkflow = graph.compile();
