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

/** Local-only git exclude patterns (written to .git/info/exclude, never committed). */
export function worktreeLocalExcludeEntries(taskId: string): string[] {
  return [".taskgraph*", `tasks/${taskId}/contract.yaml`, `tasks/${taskId}/evidence/`];
}

export function fileMatchesScopeOutItem(filePath: string, scopeOutItem: string): boolean {
  const file = filePath.toLowerCase().replace(/\\/g, "/");
  const item = scopeOutItem.toLowerCase();
  if (!item.includes("/") && !item.includes("*") && !item.includes(".")) {
    return false;
  }
  const prefix = item.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\/$/, "").trim();
  if (!prefix) return false;
  return file.startsWith(prefix) || file.includes(`/${prefix}`) || file.includes(prefix);
}

export function isExcludedCommitPath(taskId: string, filePath: string): boolean {
  const norm = normalizeRepoPath(filePath);
  if (norm.includes(".taskgraph")) return true;
  if (norm.startsWith(`tasks/${taskId}/evidence/`)) return true;
  return commitExcludedPaths(taskId).includes(norm);
}

export function filterExcludedCommitPaths(taskId: string, filePaths: string[]): string[] {
  return filePaths.filter((filePath) => isExcludedCommitPath(taskId, filePath));
}
