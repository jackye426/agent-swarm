import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { integrateCompletedTaskBranch, integrateTaskBranchInRepo } from "../src/core/branch-integration.js";
import { runCommand } from "../src/core/command.js";

async function mustGit(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixtureRepo(): Promise<{ root: string; origin: string; clone: string; storage: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-branch-integration-"));
  const origin = path.join(root, "origin.git");
  const clone = path.join(root, "clone");
  const storage = path.join(root, "storage");

  await mustGit(root, ["init", "--bare", "--initial-branch=main", origin]);
  await mustGit(root, ["clone", origin, clone]);
  await mustGit(clone, ["config", "user.email", "test@test.local"]);
  await mustGit(clone, ["config", "user.name", "Test"]);
  await writeFile(path.join(clone, "app.txt"), "base\n", "utf8");
  await mustGit(clone, ["add", "app.txt"]);
  await mustGit(clone, ["commit", "-m", "base"]);
  await mustGit(clone, ["push", "origin", "main"]);
  await mustGit(clone, ["remote", "set-head", "origin", "-a"]);

  return { root, origin, clone, storage };
}

test("integrateTaskBranchInRepo merges a completed task branch into the default branch", async () => {
  const { origin, clone, storage } = await fixtureRepo();
  await mustGit(clone, ["checkout", "-b", "taskgraph/t-123"]);
  await writeFile(path.join(clone, "feature.txt"), "feature\n", "utf8");
  await mustGit(clone, ["add", "feature.txt"]);
  await mustGit(clone, ["commit", "-m", "feat: add feature"]);

  const result = await integrateTaskBranchInRepo(clone, "T-123", { storageRoot: storage });

  assert.deepEqual({ ok: result.ok, merged: result.merged }, { ok: true, merged: true });
  const originFile = await mustGit(origin, ["show", "main:feature.txt"]);
  assert.equal(originFile, "feature");
});

test("integrateTaskBranchInRepo reports merge conflicts without changing origin", async () => {
  const { origin, clone, storage } = await fixtureRepo();
  await mustGit(clone, ["checkout", "-b", "taskgraph/t-124"]);
  await writeFile(path.join(clone, "app.txt"), "task\n", "utf8");
  await mustGit(clone, ["add", "app.txt"]);
  await mustGit(clone, ["commit", "-m", "feat: task edit"]);

  await mustGit(clone, ["checkout", "main"]);
  await writeFile(path.join(clone, "app.txt"), "main\n", "utf8");
  await mustGit(clone, ["add", "app.txt"]);
  await mustGit(clone, ["commit", "-m", "feat: main edit"]);
  await mustGit(clone, ["push", "origin", "main"]);
  await mustGit(clone, ["fetch", "origin", "main"]);

  const result = await integrateTaskBranchInRepo(clone, "T-124", { storageRoot: storage });

  assert.equal(result.ok, false);
  assert.equal(result.merged, false);
  assert.match(result.detail, /merge conflict/i);
  const originFile = await mustGit(origin, ["show", "main:app.txt"]);
  assert.equal(originFile, "main");
});

test("integrateCompletedTaskBranch respects the env gate before loading task repo data", async () => {
  const prior = process.env.TASKGRAPH_AUTO_INTEGRATE;
  process.env.TASKGRAPH_AUTO_INTEGRATE = "false";
  try {
    const result = await integrateCompletedTaskBranch("T-999");
    assert.deepEqual(result, {
      ok: true,
      merged: false,
      detail: "auto-integrate disabled",
    });
  } finally {
    if (prior === undefined) {
      delete process.env.TASKGRAPH_AUTO_INTEGRATE;
    } else {
      process.env.TASKGRAPH_AUTO_INTEGRATE = prior;
    }
  }
});
