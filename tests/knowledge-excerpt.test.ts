import assert from "node:assert/strict";
import { test } from "node:test";
import { readKnowledgeExcerpt } from "../src/core/knowledge-excerpt.js";

test("readKnowledgeExcerpt loads verifier judging rules section", () => {
  const excerpt = readKnowledgeExcerpt(
    "concepts/evidence-and-verification.md",
    "Verifier judging rules",
  );
  assert.match(excerpt, /diff_inspection verification/);
  assert.match(excerpt, /command verification/);
});

test("readKnowledgeExcerpt loads scope enforcement prompt section", () => {
  const excerpt = readKnowledgeExcerpt(
    "policies/agent-permissions.md",
    "### Scope enforcement (prompt excerpt)",
  );
  assert.match(excerpt, /SCOPE RULES/);
  assert.match(excerpt, /scope\.out/);
});

test("readKnowledgeExcerpt throws for missing section", () => {
  assert.throws(
    () => readKnowledgeExcerpt("concepts/task-lifecycle.md", "Nonexistent Section"),
    /not found/,
  );
});
