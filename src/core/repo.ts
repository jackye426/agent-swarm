/** Parse and validate a GitHub repo slug (owner/name). */
export function parseRepoFullName(input: string): string | null {
  let trimmed = input.trim();
  trimmed = trimmed.replace(/^https?:\/\/github\.com\//i, "");
  trimmed = trimmed.replace(/\.git$/i, "").replace(/\/$/, "");

  if (!/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function repoUrlFromFullName(repoFullName: string): string {
  return `https://github.com/${repoFullName}`;
}

/** Extract owner/name from a git remote URL, or null if not GitHub. */
export function parseGitHubRemoteUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const ssh = trimmed.match(/^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
  if (ssh) return ssh[1]!;

  const https = trimmed.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
  if (https) return https[1]!;

  return null;
}
