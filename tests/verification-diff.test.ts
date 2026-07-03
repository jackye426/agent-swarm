import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../src/core/command.js";
import { assembleVerificationDiff } from "../src/core/verification-diff.js";

async function initRepo(dir: string): Promise<void> {
  await runCommand("git", ["init"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "test@test.local"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: dir });
}

test("orphan first commit produces non-empty patch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tg-vdiff-"));
  await initRepo(dir);
  await writeFile(path.join(dir, "hello.txt"), "hello\n", "utf8");
  await runCommand("git", ["add", "hello.txt"], { cwd: dir });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: dir });

  const { diff } = await assembleVerificationDiff(dir);
  assert.ok(diff.includes("hello.txt"));
  assert.ok(diff.includes("hello"));
});

test("multi-commit branch includes cumulative changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tg-vdiff-"));
  await initRepo(dir);
  await writeFile(path.join(dir, "a.txt"), "a\n", "utf8");
  await runCommand("git", ["add", "a.txt"], { cwd: dir });
  await runCommand("git", ["commit", "-m", "first"], { cwd: dir });
  const base = await runCommand("git", ["rev-parse", "HEAD"], { cwd: dir });

  await writeFile(path.join(dir, "b.txt"), "b\n", "utf8");
  await runCommand("git", ["add", "b.txt"], { cwd: dir });
  await runCommand("git", ["commit", "-m", "second"], { cwd: dir });

  await writeFile(path.join(dir, "c.txt"), "c\n", "utf8");
  await runCommand("git", ["add", "c.txt"], { cwd: dir });
  await runCommand("git", ["commit", "-m", "third"], { cwd: dir });

  const { diff } = await assembleVerificationDiff(dir, { baseSha: base.stdout.trim() });
  assert.ok(!diff.includes("a.txt"));
  assert.ok(diff.includes("b.txt"));
  assert.ok(diff.includes("c.txt"));
});

test("rework branch diff includes implementation and later docs commits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tg-vdiff-"));
  await initRepo(dir);
  await writeFile(path.join(dir, "package.json"), "{\"scripts\":{\"test\":\"node scripts/healthcheck.js\"}}\n", "utf8");
  await runCommand("git", ["add", "package.json"], { cwd: dir });
  await runCommand("git", ["commit", "-m", "base"], { cwd: dir });
  const base = await runCommand("git", ["rev-parse", "HEAD"], { cwd: dir });

  await mkdir(path.join(dir, "scripts"));
  await writeFile(path.join(dir, "scripts", "healthcheck.js"), "console.log('ok')\n", "utf8");
  await runCommand("git", ["add", "scripts/healthcheck.js"], { cwd: dir });
  await runCommand("git", ["commit", "-m", "implementation"], { cwd: dir });

  await writeFile(path.join(dir, "README.md"), "# Usage\n\nRun npm test.\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: dir });
  await runCommand("git", ["commit", "-m", "docs rework"], { cwd: dir });

  const { diff } = await assembleVerificationDiff(dir, { baseSha: base.stdout.trim() });
  assert.ok(diff.includes("scripts/healthcheck.js"));
  assert.ok(diff.includes("README.md"));
});

test("empty worktree after commit still returns git show content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tg-vdiff-"));
  await initRepo(dir);
  await writeFile(path.join(dir, "only.txt"), "only\n", "utf8");
  await runCommand("git", ["add", "only.txt"], { cwd: dir });
  await runCommand("git", ["commit", "-m", "only commit"], { cwd: dir });

  const { diff } = await assembleVerificationDiff(dir);
  assert.ok(diff.length > 20);
  assert.ok(diff.includes("only.txt"));
});
