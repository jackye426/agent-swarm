/** Paths TaskGraph must never include in product-repo commits. */

export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function commitExcludedPaths(taskId: string): string[] {
  return [
    ".taskgraph_impl_plan.txt",
    ".taskgraph-seed-scan.json",
    `tasks/${taskId}/contract.yaml`,
  ];
}

export function worktreeGitignoreEntries(taskId: string): string[] {
  return [".taskgraph*", `tasks/${taskId}/contract.yaml`];
}

export function isExcludedCommitPath(taskId: string, filePath: string): boolean {
  const norm = normalizeRepoPath(filePath);
  if (norm.includes(".taskgraph")) return true;
  return commitExcludedPaths(taskId).includes(norm);
}

export function filterExcludedCommitPaths(taskId: string, filePaths: string[]): string[] {
  return filePaths.filter((filePath) => isExcludedCommitPath(taskId, filePath));
}
