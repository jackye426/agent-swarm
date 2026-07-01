import { getChatRepoBinding } from "../db/records.js";
import { parseRepoFullName, repoUrlFromFullName } from "../core/repo.js";
import { getLocalRepoFullName } from "./repo-scanner.js";

export type RepoResolutionSource =
  | "flag"
  | "github"
  | "chat_binding"
  | "env"
  | "local_git";

export interface ResolvedRepo {
  repoFullName: string;
  repoUrl: string;
  resolutionSource: RepoResolutionSource;
}

export class RepoResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoResolutionError";
  }
}

export interface ResolveRepoInput {
  /** Explicit `--repo owner/name` from Telegram or CLI. */
  repoFlag?: string | null;
  /** Repo from a GitHub webhook payload. */
  githubRepoFullName?: string | null;
  /** Telegram chat id for per-chat default binding. */
  chatId?: string | null;
  /** When true, fall back to local git remote (smoke scripts / dev only). */
  allowLocalGitFallback?: boolean;
}

export async function resolveRepo(input: ResolveRepoInput): Promise<ResolvedRepo | null> {
  if (input.repoFlag) {
    const parsed = parseRepoFullName(input.repoFlag);
    if (!parsed) return null;
    return {
      repoFullName: parsed,
      repoUrl: repoUrlFromFullName(parsed),
      resolutionSource: "flag",
    };
  }

  if (input.githubRepoFullName) {
    const parsed = parseRepoFullName(input.githubRepoFullName);
    if (!parsed) return null;
    return {
      repoFullName: parsed,
      repoUrl: repoUrlFromFullName(parsed),
      resolutionSource: "github",
    };
  }

  if (input.chatId) {
    const binding = await getChatRepoBinding(input.chatId);
    if (binding) {
      return {
        repoFullName: binding,
        repoUrl: repoUrlFromFullName(binding),
        resolutionSource: "chat_binding",
      };
    }
  }

  const envDefault = process.env.TASKGRAPH_DEFAULT_REPO?.trim();
  if (envDefault) {
    const parsed = parseRepoFullName(envDefault);
    if (parsed) {
      return {
        repoFullName: parsed,
        repoUrl: repoUrlFromFullName(parsed),
        resolutionSource: "env",
      };
    }
  }

  if (input.allowLocalGitFallback) {
    const local = await getLocalRepoFullName();
    if (local) {
      return {
        repoFullName: local,
        repoUrl: repoUrlFromFullName(local),
        resolutionSource: "local_git",
      };
    }
  }

  return null;
}

/** Intake paths (Telegram/GitHub) require an explicit resolution — no silent local fallback. */
export async function resolveRepoForIntake(input: ResolveRepoInput): Promise<ResolvedRepo> {
  const resolved = await resolveRepo(input);
  if (resolved) return resolved;

  throw new RepoResolutionError(
    "Could not resolve target repo. Use --repo owner/name, /repo set owner/name, " +
      "or set TASKGRAPH_DEFAULT_REPO for this chat.",
  );
}

/** CLI / smoke scripts may fall back to the local git remote. */
export async function resolveRepoForManual(input: ResolveRepoInput): Promise<ResolvedRepo> {
  const resolved = await resolveRepo({ ...input, allowLocalGitFallback: true });
  if (resolved) return resolved;

  throw new RepoResolutionError(
    "Could not resolve target repo. Pass --repo owner/name or set TASKGRAPH_DEFAULT_REPO.",
  );
}

/** Parse `/task <goal> [--repo owner/name]` from Telegram command text. */
export function parseTaskCommand(raw: string): { goal: string; repoFlag: string | null } {
  const repoMatch = raw.match(/\s--repo\s+(\S+)\s*$/i);
  if (!repoMatch) {
    return { goal: raw.trim(), repoFlag: null };
  }

  const repoFlag = repoMatch[1]!;
  const goal = raw.slice(0, repoMatch.index).trim();
  return { goal, repoFlag };
}
