import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../src/core/command.js";
import { writeWorktreeSupportFiles, scrubHarnessLinesFromGitignore } from "../src/cells/engineering/worktree-support.js";
import { restoreScopeOutFilesBeforeCommit } from "../src/cells/engineering/commit-staging.js";
import type { TaskContract } from "../src/core/types.js";

const contract: TaskContract = {
  id: "T-007",
  title: "Test task",
  goal: "Test",
  scope: { in: ["src/"], out: [".gitignore"] },
  acceptance_criteria: [],
  approvals_required: [],
  dependencies: [],
  version: 1,
};

test("writeWorktreeSupportFiles uses info/exclude and does not modify .gitignore", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tg-worktree-"));
  await runCommand("git", ["init"], { cwd: dir });
  await writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");

  await writeWorktreeSupportFiles(dir, "T-007", contract);

  const gitignore = await readFile(path.join(dir, ".gitignore"), "utf8");
  assert.equal(gitignore, "node_modules/\n");

  const excludePath = path.join(dir, ".git", "info", "exclude");
  const exclude = await readFile(excludePath, "utf8");
  assert.ok(exclude.includes(".taskgraph*"));
  assert.ok(exclude.includes("tasks/T-007/contract.yaml"));
  assert.ok(exclude.includes("tasks/T-007/evidence/"));
});

test("scrubHarnessLinesFromGitignore removes harness entries without touching product lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tg-scrub-"));
  await writeFile(
    path.join(dir, ".gitignore"),
    "node_modules/\n.taskgraph*\ntasks/T-007/contract.yaml\n",
    "utf8",
  );

  await scrubHarnessLinesFromGitignore(dir, "T-007");

  const gitignore = await readFile(path.join(dir, ".gitignore"), "utf8");
  assert.equal(gitignore, "node_modules/\n");
});

test("info/exclude prevents staging harness files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tg-worktree-"));
  await runCommand("git", ["init"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@test.local"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });

  await writeWorktreeSupportFiles(dir, "T-007", contract);
  await mkdir(path.join(dir, "tasks", "T-007", "evidence"), { recursive: true });
  await writeFile(path.join(dir, "tasks", "T-007", "evidence", "E-001.yaml"), "id: E-001\n", "utf8");
  await writeFile(path.join(dir, ".taskgraph_impl_plan.txt"), "plan\n", "utf8");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "app.js"), "export {}\n", "utf8");

  await runCommand("git", ["add", "-A"], { cwd: dir });
  const staged = await runCommand("git", ["diff", "--cached", "--name-only"], { cwd: dir });
  const files = staged.stdout.trim().split("\n").filter(Boolean);

  assert.ok(files.includes("src/app.js"));
  assert.ok(!files.some((file) => file.includes(".taskgraph")));
  assert.ok(!files.some((file) => file.includes("contract.yaml")));
  assert.ok(!files.some((file) => file.includes("evidence/")));
});

test("scope-out restore uses task base, not original file introduction", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tg-scope-base-"));
  await runCommand("git", ["init"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@test.local"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });

  await writeFile(path.join(dir, "app.js"), "console.log('base')\n", "utf8");
  await runCommand("git", ["add", "app.js"], { cwd: dir });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: dir });

  await writeFile(path.join(dir, "package-lock.json"), "{\"lockfileVersion\":3}\n", "utf8");
  await runCommand("git", ["add", "package-lock.json"], { cwd: dir });
  await runCommand("git", ["commit", "-m", "add lockfile before task"], { cwd: dir });
  const base = await runCommand("git", ["rev-parse", "HEAD"], { cwd: dir });

  await writeFile(path.join(dir, "package-lock.json"), "{\"lockfileVersion\":999}\n", "utf8");
  await runCommand("git", ["add", "package-lock.json"], { cwd: dir });

  await restoreScopeOutFilesBeforeCommit(dir, ["package-lock.json"], base.stdout.trim());

  const restored = await readFile(path.join(dir, "package-lock.json"), "utf8");
  assert.equal(restored.replace(/\r\n/g, "\n"), "{\"lockfileVersion\":3}\n");
});
