import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../core/command.js";
import { parseGitHubRemoteUrl } from "../core/repo.js";

export interface SeedRepoContext {
  repo_full_name: string;
  scanned_at: string;
  scan_root: string;
  file_tree: string;
  readme_excerpt: string | null;
  package_manifest: Record<string, unknown> | null;
  package_manifest_path: string | null;
  test_commands: string[];
  recent_commits: string[];
}

const CACHE_FILENAME = ".taskgraph-seed-scan.json";
const README_MAX_CHARS = 8_000;
const MANIFEST_FILES = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"];

const DEFAULT_IGNORED = new Set([
  ".git",
  "node_modules",
  ".taskgraph-seed-scan.json",
]);

/** Returns owner/name from the current workspace git remote, if GitHub. */
export async function getLocalRepoFullName(cwd = process.cwd()): Promise<string | null> {
  const result = await runCommand("git", ["remote", "get-url", "origin"], { cwd });
  if (result.exitCode !== 0) return null;
  return parseGitHubRemoteUrl(result.stdout.trim());
}

function repoCacheDir(repoFullName: string): string {
  const root = process.env.TASKGRAPH_WORKTREE_ROOT ?? path.join(process.cwd(), ".taskgraph-cache");
  const [owner, name] = repoFullName.split("/");
  return path.join(root, "repos", owner!, name!);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readCache(cachePath: string, maxAgeMs: number): Promise<SeedRepoContext | null> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const cached = JSON.parse(raw) as SeedRepoContext;
    const age = Date.now() - new Date(cached.scanned_at).getTime();
    if (age <= maxAgeMs) return cached;
  } catch {
    // miss
  }
  return null;
}

async function writeCache(cachePath: string, context: SeedRepoContext): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(context, null, 2), "utf8");
}

async function ensureRepoCheckout(repoFullName: string, localRoot: string | null): Promise<string> {
  if (localRoot) return localRoot;

  const checkoutDir = repoCacheDir(repoFullName);
  if (await pathExists(path.join(checkoutDir, ".git"))) {
    const fetch = await runCommand("git", ["fetch", "--depth", "10", "origin"], { cwd: checkoutDir, timeoutMs: 120_000 });
    if (fetch.exitCode !== 0) {
      const fetchMsg = fetch.stderr || fetch.stdout;
      const hasHead = await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: checkoutDir });
      if (hasHead.exitCode === 0 && fetchMsg.includes("couldn't find remote ref HEAD")) {
        // Remote still empty/unpushed; local clone from a prior engineering run is valid.
        return checkoutDir;
      }
      throw new Error(`Failed to fetch ${repoFullName}: ${fetchMsg}`);
    }

    await runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: checkoutDir, timeoutMs: 120_000 });
    const reset = await runCommand("git", ["reset", "--hard", "origin/HEAD"], { cwd: checkoutDir, timeoutMs: 120_000 });
    if (reset.exitCode !== 0) {
      const hasHead = await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: checkoutDir });
      if (hasHead.exitCode === 0) return checkoutDir;
      throw new Error(`Failed to refresh ${repoFullName} to origin/HEAD: ${reset.stderr || reset.stdout}`);
    }
    return checkoutDir;
  }

  await fs.mkdir(path.dirname(checkoutDir), { recursive: true });
  const repoUrl = buildCloneUrl(repoFullName);
  const clone = await runCommand(
    "git",
    ["clone", "--depth", "10", repoUrl, checkoutDir],
    { timeoutMs: 300_000 },
  );
  if (clone.exitCode !== 0) {
    throw new Error(`Failed to clone ${repoFullName}: ${clone.stderr || clone.stdout}`);
  }
  return checkoutDir;
}

function buildCloneUrl(repoFullName: string): string {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) {
    return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
  }
  return `https://github.com/${repoFullName}.git`;
}

async function buildFileTree(scanRoot: string, maxDepth = 2): Promise<string> {
  const lines: string[] = [];

  async function walk(dir: string, depth: number, prefix: string): Promise<void> {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    entries.sort();
    for (const entry of entries) {
      if (DEFAULT_IGNORED.has(entry)) continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }

      const rel = path.relative(scanRoot, full).replace(/\\/g, "/") || entry;
      lines.push(`${prefix}${rel}${stat.isDirectory() ? "/" : ""}`);
      if (stat.isDirectory() && depth < maxDepth) {
        await walk(full, depth + 1, prefix);
      }
    }
  }

  await walk(scanRoot, 0, "");
  return lines.slice(0, 200).join("\n");
}

async function readReadmeExcerpt(scanRoot: string): Promise<string | null> {
  for (const name of ["README.md", "README", "readme.md"]) {
    const filePath = path.join(scanRoot, name);
    if (!(await pathExists(filePath))) continue;
    const text = await fs.readFile(filePath, "utf8");
    return text.slice(0, README_MAX_CHARS);
  }
  return null;
}

async function readPackageManifest(scanRoot: string): Promise<{
  path: string | null;
  manifest: Record<string, unknown> | null;
  testCommands: string[];
}> {
  for (const name of MANIFEST_FILES) {
    const filePath = path.join(scanRoot, name);
    if (!(await pathExists(filePath))) continue;

    const raw = await fs.readFile(filePath, "utf8");
    if (name === "package.json") {
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      const scripts = (manifest.scripts ?? {}) as Record<string, string>;
      const testCommands: string[] = [];
      if (scripts.typecheck) testCommands.push("npm run typecheck");
      if (scripts.test) testCommands.push("npm test");
      return { path: name, manifest, testCommands };
    }

    return { path: name, manifest: { raw: raw.slice(0, 4_000) }, testCommands: [] };
  }

  return { path: null, manifest: null, testCommands: [] };
}

async function readRecentCommits(scanRoot: string): Promise<string[]> {
  const log = await runCommand(
    "git",
    ["log", "-10", "--oneline", "--no-decorate"],
    { cwd: scanRoot },
  );
  if (log.exitCode !== 0) return [];
  return log.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Fast seed scan used before planning starts. Cached per checkout directory. */
export async function scanRepoSeedContext(repoFullName: string): Promise<SeedRepoContext> {
  const maxAgeMs = Number(process.env.REPO_CACHE_MAX_AGE_MS ?? 600_000);
  const localFullName = await getLocalRepoFullName();
  const localRoot = localFullName === repoFullName ? process.cwd() : null;

  const checkoutDir = await ensureRepoCheckout(repoFullName, localRoot);
  const cachePath = path.join(checkoutDir, CACHE_FILENAME);

  const cached = await readCache(cachePath, maxAgeMs);
  if (cached && cached.repo_full_name === repoFullName) return cached;

  const [fileTree, readme, pkg, commits] = await Promise.all([
    buildFileTree(checkoutDir),
    readReadmeExcerpt(checkoutDir),
    readPackageManifest(checkoutDir),
    readRecentCommits(checkoutDir),
  ]);

  const context: SeedRepoContext = {
    repo_full_name: repoFullName,
    scanned_at: new Date().toISOString(),
    scan_root: checkoutDir,
    file_tree: fileTree,
    readme_excerpt: readme,
    package_manifest: pkg.manifest,
    package_manifest_path: pkg.path,
    test_commands: pkg.testCommands,
    recent_commits: commits,
  };

  await writeCache(cachePath, context);
  return context;
}

/** Human-readable block appended to planning job context. */
export function formatSeedContextForPlanning(seed: SeedRepoContext, userContext: string): string {
  const sections = [
    userContext.trim(),
    "",
    "--- Seed repo context ---",
    `Repository: ${seed.repo_full_name}`,
    `Scanned at: ${seed.scanned_at}`,
    "",
    "File tree (top levels):",
    seed.file_tree || "(empty)",
  ];

  if (seed.readme_excerpt) {
    sections.push("", "README excerpt:", seed.readme_excerpt);
  }

  if (seed.package_manifest_path) {
    sections.push(
      "",
      `Package manifest (${seed.package_manifest_path}):`,
      JSON.stringify(seed.package_manifest, null, 2),
    );
  }

  if (seed.test_commands.length > 0) {
    sections.push("", "Detected test commands:", ...seed.test_commands.map((c) => `- ${c}`));
  }

  if (seed.recent_commits.length > 0) {
    sections.push("", "Recent commits:", ...seed.recent_commits.map((c) => `- ${c}`));
  }

  return sections.join("\n");
}
