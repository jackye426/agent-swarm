import test from "node:test";
import assert from "node:assert/strict";
import { parseGitHubRemoteUrl, parseRepoFullName, repoUrlFromFullName } from "../src/core/repo.js";
import { ResearchBriefV0Schema, MemoryCandidateBatchSchema } from "../src/core/planning-artifacts.js";
import { parseTaskCommand } from "../src/intake/repo-resolver.js";
import { formatSeedContextForPlanning, type SeedRepoContext } from "../src/intake/repo-scanner.js";

test("parseRepoFullName accepts slug and GitHub URLs", () => {
  assert.equal(parseRepoFullName("jackye426/agent-swarm"), "jackye426/agent-swarm");
  assert.equal(
    parseRepoFullName("https://github.com/jackye426/agent-swarm.git"),
    "jackye426/agent-swarm",
  );
  assert.equal(parseRepoFullName("not-a-repo"), null);
});

test("parseGitHubRemoteUrl handles HTTPS and SSH remotes", () => {
  assert.equal(
    parseGitHubRemoteUrl("https://github.com/jackye426/agent-swarm.git"),
    "jackye426/agent-swarm",
  );
  assert.equal(
    parseGitHubRemoteUrl("git@github.com:jackye426/agent-swarm.git"),
    "jackye426/agent-swarm",
  );
});

test("repoUrlFromFullName builds GitHub URL", () => {
  assert.equal(
    repoUrlFromFullName("jackye426/agent-swarm"),
    "https://github.com/jackye426/agent-swarm",
  );
});

test("parseTaskCommand extracts --repo flag from Telegram task text", () => {
  assert.deepEqual(parseTaskCommand("Add CI workflow"), {
    goal: "Add CI workflow",
    repoFlag: null,
  });
  assert.deepEqual(parseTaskCommand("Add CI --repo jackye426/agent-swarm"), {
    goal: "Add CI",
    repoFlag: "jackye426/agent-swarm",
  });
});

test("research_brief_v0 schema requires source_mode model_knowledge", () => {
  const parsed = ResearchBriefV0Schema.parse({
    artifact_type: "research_brief_v0",
    source_mode: "model_knowledge",
    domain: "social APIs",
    summary: "High-level model knowledge only.",
    key_findings: ["OAuth is required for posting"],
    unresolved_unknowns: ["Current rate limits"],
    citation_status: "none",
  });
  assert.equal(parsed.source_mode, "model_knowledge");
  assert.equal(parsed.citation_status, "none");
});

test("memory candidate batch caps volume for conservative writeback", () => {
  const result = MemoryCandidateBatchSchema.safeParse({
    artifact_type: "memory_candidates",
    candidates: Array.from({ length: 11 }, (_, i) => ({
      memory_type: "decision",
      scope: "global",
      subject: `subject-${i}`,
      content: "lesson",
      rationale: "because",
    })),
  });
  assert.equal(result.success, false);
});

test("formatSeedContextForPlanning includes repo scan sections", () => {
  const seed: SeedRepoContext = {
    repo_full_name: "org/app",
    scanned_at: "2026-06-30T00:00:00.000Z",
    scan_root: "/tmp/app",
    file_tree: "src/\nREADME.md",
    readme_excerpt: "# App",
    package_manifest: { name: "app" },
    package_manifest_path: "package.json",
    test_commands: ["npm test"],
    recent_commits: ["abc123 init"],
  };

  const formatted = formatSeedContextForPlanning(seed, "User context line.");
  assert.match(formatted, /User context line/);
  assert.match(formatted, /Repository: org\/app/);
  assert.match(formatted, /README excerpt/);
  assert.match(formatted, /npm test/);
});
