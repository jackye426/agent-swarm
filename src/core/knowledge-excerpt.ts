import fs from "node:fs";
import path from "node:path";

const KNOWLEDGE_ROOT = path.resolve(process.cwd(), "system-knowledge");

/**
 * Read an excerpt from a system-knowledge markdown file.
 * Optionally extracts content under a ## heading (includes heading line).
 */
export function readKnowledgeExcerpt(
  relativePath: string,
  sectionHeading?: string,
  maxChars = 2_000,
): string {
  const filePath = path.join(KNOWLEDGE_ROOT, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Knowledge file not found: ${relativePath}`);
  }

  let content = fs.readFileSync(filePath, "utf8");

  // Strip YAML frontmatter
  if (content.startsWith("---")) {
    const end = content.indexOf("---", 3);
    if (end !== -1) {
      content = content.slice(end + 3).trimStart();
    }
  }

  if (sectionHeading) {
    const heading = sectionHeading.startsWith("#") ? sectionHeading : `## ${sectionHeading}`;
    const startIdx = content.indexOf(heading);
    if (startIdx === -1) {
      throw new Error(`Section "${sectionHeading}" not found in ${relativePath}`);
    }

    const afterHeading = content.slice(startIdx);
    const nextHeadingMatch = afterHeading.slice(heading.length).match(/\n## /);
    content =
      nextHeadingMatch && nextHeadingMatch.index !== undefined
        ? afterHeading.slice(0, heading.length + nextHeadingMatch.index)
        : afterHeading;
  }

  content = content.trim();
  if (content.length > maxChars) {
    return `${content.slice(0, maxChars)}\n[excerpt truncated]`;
  }
  return content;
}
