import test from "node:test";
import assert from "node:assert/strict";
import {
  filterExcludedCommitPaths,
  isExcludedCommitPath,
  worktreeLocalExcludeEntries,
} from "../src/cells/engineering/commit-guard.js";

test("TaskGraph harness files are excluded from product commits", () => {
  assert.equal(isExcludedCommitPath("T-012", ".taskgraph_impl_plan.txt"), true);
  assert.equal(isExcludedCommitPath("T-012", ".taskgraph-seed-scan.json"), true);
  assert.equal(isExcludedCommitPath("T-012", "nested/.taskgraph-debug.txt"), true);
  assert.equal(isExcludedCommitPath("T-012", "tasks/T-012/contract.yaml"), true);
  assert.equal(isExcludedCommitPath("T-012", "tasks/T-012/evidence/result.yaml"), true);
  assert.equal(isExcludedCommitPath("T-012", "server.js"), false);
});

test("filterExcludedCommitPaths returns only harness files to unstage", () => {
  assert.deepEqual(
    filterExcludedCommitPaths("T-012", [
      "server.js",
      ".taskgraph_impl_plan.txt",
      "public/index.html",
      "tasks/T-012/contract.yaml",
    ]),
    [".taskgraph_impl_plan.txt", "tasks/T-012/contract.yaml"],
  );
});

test("worktree local excludes cover all TaskGraph harness paths", () => {
  assert.deepEqual(
    worktreeLocalExcludeEntries("T-012"),
    [".taskgraph*", "tasks/T-012/contract.yaml", "tasks/T-012/evidence/"],
  );
});
