import path from "node:path";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import yaml from "js-yaml";
import type { TaskContract } from "../../core/types.js";
import { worktreeGitignoreEntries } from "./commit-guard.js";

/** Contract copy + gitignore entries for local validation; must not be committed. */
export async function writeWorktreeSupportFiles(
  worktreePath: string,
  taskId: string,
  contract: TaskContract,
): Promise<void> {
  const contractDir = path.join(worktreePath, "tasks", taskId);
  await mkdir(contractDir, { recursive: true });
  await writeFile(
    path.join(contractDir, "contract.yaml"),
    yaml.dump(contract, { lineWidth: 120 }),
    "utf8",
  );

  const gitignorePath = path.join(worktreePath, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    /* no .gitignore yet */
  }

  const entries = worktreeGitignoreEntries(taskId);
  const missing = entries.filter((entry) => !existing.split("\n").some((line) => line.trim() === entry));
  if (missing.length === 0) return;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const block = (needsLeadingNewline ? "\n" : "") + missing.join("\n") + "\n";
  await writeFile(gitignorePath, existing + block, "utf8");
}
