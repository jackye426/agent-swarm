import test from "node:test";
import assert from "node:assert/strict";
import {
  commitExcludedPaths,
  filterExcludedCommitPaths,
  isExcludedCommitPath,
  normalizeRepoPath,
} from "../src/cells/engineering/commit-guard.js";

test("normalizeRepoPath converts backslashes and strips ./ prefix", () => {
  assert.equal(normalizeRepoPath(".\\tasks\\T-007\\contract.yaml"), "tasks/T-007/contract.yaml");
  assert.equal(normalizeRepoPath("./src/foo.js"), "src/foo.js");
});

test("commitExcludedPaths includes task contract path", () => {
  const paths = commitExcludedPaths("T-007");
  assert.ok(paths.includes("tasks/T-007/contract.yaml"));
  assert.ok(paths.includes(".taskgraph_impl_plan.txt"));
});

test("isExcludedCommitPath excludes .taskgraph* and own contract", () => {
  assert.equal(isExcludedCommitPath("T-007", "tasks/T-007/contract.yaml"), true);
  assert.equal(isExcludedCommitPath("T-007", ".taskgraph_impl_plan.txt"), true);
  assert.equal(isExcludedCommitPath("T-007", ".taskgraph-seed-scan.json"), true);
  assert.equal(isExcludedCommitPath("T-007", ".taskgraph-custom.json"), true);
  assert.equal(isExcludedCommitPath("T-007", "src/healthcheck.js"), false);
});

test("isExcludedCommitPath does not exclude another task contract", () => {
  assert.equal(isExcludedCommitPath("T-007", "tasks/T-006/contract.yaml"), false);
});

test("filterExcludedCommitPaths returns only excluded paths", () => {
  const filtered = filterExcludedCommitPaths("T-007", [
    "src/index.js",
    "tasks/T-007/contract.yaml",
    ".taskgraph_impl_plan.txt",
  ]);
  assert.deepEqual(filtered, ["tasks/T-007/contract.yaml", ".taskgraph_impl_plan.txt"]);
});
