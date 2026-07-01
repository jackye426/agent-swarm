import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../src/core/command.js";
import {
  hasStagedChanges,
  removeExcludedFilesFromDisk,
  stageAllExceptExcluded,
} from "../src/cells/engineering/commit-staging.js";

test("stageAllExceptExcluded omits contract and .taskgraph files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tg-commit-"));
  await runCommand("git", ["init"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@test.local"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });

  await mkdir(path.join(dir, "tasks", "T-007"), { recursive: true });
  await writeFile(path.join(dir, "tasks", "T-007", "contract.yaml"), "id: T-007\n", "utf8");
  await writeFile(path.join(dir, ".taskgraph_impl_plan.txt"), "plan\n", "utf8");
  await writeFile(path.join(dir, "healthcheck.js"), "module.exports = {}\n", "utf8");

  await removeExcludedFilesFromDisk(dir, "T-007");
  await stageAllExceptExcluded(dir, "T-007");

  assert.equal(await hasStagedChanges(dir), true);
  const staged = await runCommand("git", ["diff", "--cached", "--name-only"], { cwd: dir });
  const files = staged.stdout.trim().split("\n").filter(Boolean);
  assert.ok(files.includes("healthcheck.js"));
  assert.ok(!files.some((file) => file.includes("contract.yaml")));
  assert.ok(!files.some((file) => file.includes(".taskgraph")));
});
