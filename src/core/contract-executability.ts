import type { AcceptanceCriterion, TaskContract } from "./types.js";
import type { SeedRepoContext } from "../intake/repo-scanner.js";
import { formatSeedContextForPlanning } from "../intake/repo-scanner.js";

export type VerificationMethodKind = "command" | "diff_inspection" | "human" | "unknown";

export interface ExecutabilityContext {
  testCommands?: string[];
  requireCommandAc?: boolean;
}

export interface ExecutabilityResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  suggestedTestCommands: string[];
  contractTestCommands: string[];
  acClassifications: Record<string, VerificationMethodKind[]>;
}

type ContextPacketLike = Record<string, unknown>;

const HUMAN_PATTERNS = [
  /\bmanual review\b/i,
  /\bhuman approval\b/i,
  /\bhuman review\b/i,
  /\bengineering owner\b/i,
  /\bproduct owner\b/i,
  /\bpeer review\b/i,
  /\bcode review by\b/i,
];

const DIFF_INSPECTION_PATTERNS = [
  /\binspect\b.*\bdiff\b/i,
  /\bpr diff\b/i,
  /\bpull request diff\b/i,
  /\bfile presence\b/i,
  /\bin diff\b/i,
  /\bworkflow steps\b/i,
  /\bworkflow triggers\b/i,
  /\bfields in diff\b/i,
  /\bdiff shows\b/i,
  /\bpresence check\b/i,
  /\bcheck in diff\b/i,
  /\bverify in diff\b/i,
];

const VAGUE_PATTERNS = [
  /\bworks as expected\b/i,
  /\bas expected\b/i,
  /\bshould work\b/i,
  /\bverify functionality\b/i,
];

const COMMAND_PATTERNS = [
  /^npm test$/i,
  /^npm run \S+$/i,
  /^pnpm test$/i,
  /^pnpm run \S+$/i,
  /^yarn test$/i,
  /^yarn \S+$/i,
  /^npx \S+$/i,
  /^tsx .+$/i,
  /^node .+$/i,
  /\bintegration test\b/i,
  /\bunit test\b/i,
  /\btypecheck\b/i,
  /\bvalidate script\b/i,
  /\bvalidate scripts\b/i,
  /\bpasses validate\b/i,
  /\bschema enforcement\b/i,
  /\bstate machine unit test\b/i,
  /\bci run\b/i,
];

/** Extract a runnable command string from a verification method, if present. */
export function extractCommandFromVerification(method: string): string | null {
  const trimmed = method.trim();
  const npmRun = trimmed.match(/^(npm run \S+|npm test)$/i);
  if (npmRun) return npmRun[0]!.toLowerCase() === "npm test" ? "npm test" : npmRun[0]!;

  const pnpm = trimmed.match(/^(pnpm (?:run )?\S+|pnpm test)$/i);
  if (pnpm) return pnpm[0]!;

  if (/^npm run typecheck$/i.test(trimmed)) return "npm run typecheck";
  if (/^npm run validate/i.test(trimmed)) return "npm run validate";

  // "Contract validation script integration test" → suggest validate
  if (/\bcontract validation\b/i.test(trimmed)) return "npm run validate:contracts";
  if (/\bevidence validation\b/i.test(trimmed)) return "npm run validate:evidence";
  if (/\bvalidate scripts?\b/i.test(trimmed)) return "npm run validate";

  return null;
}

export function classifyVerificationMethod(method: string): VerificationMethodKind {
  const trimmed = method.trim();
  if (!trimmed) return "unknown";

  if (HUMAN_PATTERNS.some((p) => p.test(trimmed))) return "human";
  if (VAGUE_PATTERNS.some((p) => p.test(trimmed))) return "unknown";
  if (DIFF_INSPECTION_PATTERNS.some((p) => p.test(trimmed))) return "diff_inspection";
  if (COMMAND_PATTERNS.some((p) => p.test(trimmed))) return "command";
  if (extractCommandFromVerification(trimmed)) return "command";

  return "unknown";
}

export function classifyAcceptanceCriterion(ac: AcceptanceCriterion): VerificationMethodKind[] {
  return ac.verification.map(classifyVerificationMethod);
}

export function primaryAcKind(kinds: VerificationMethodKind[]): VerificationMethodKind {
  if (kinds.includes("command")) return "command";
  if (kinds.includes("diff_inspection")) return "diff_inspection";
  if (kinds.includes("human")) return "human";
  return "unknown";
}

function normalizeCommand(cmd: string): string {
  return cmd.trim().toLowerCase();
}

function commandsCompatible(requested: string, available: string): boolean {
  const r = normalizeCommand(requested);
  const a = normalizeCommand(available);
  if (r === a) return true;
  // npm run test vs npm test
  if (r === "npm test" && a === "npm run test") return true;
  if (r === "npm run test" && a === "npm test") return true;
  return false;
}

export function collectContractTestCommands(contract: TaskContract): string[] {
  const commands = new Set<string>();
  for (const ac of contract.acceptance_criteria) {
    for (const method of ac.verification) {
      const extracted = extractCommandFromVerification(method);
      if (extracted) commands.add(extracted);
      if (classifyVerificationMethod(method) === "command" && /^npm /i.test(method.trim())) {
        commands.add(method.trim());
      }
    }
  }
  return [...commands];
}

export function validateContractExecutability(
  contract: TaskContract,
  ctx: ExecutabilityContext = {},
): ExecutabilityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const acClassifications: Record<string, VerificationMethodKind[]> = {};
  const contractTestCommands = collectContractTestCommands(contract);
  const seedCommands = ctx.testCommands ?? [];
  const requireCommandAc = ctx.requireCommandAc ?? true;

  let hasCommandAc = false;
  let hasExecutableAc = false;

  for (const ac of contract.acceptance_criteria) {
    const kinds = classifyAcceptanceCriterion(ac);
    acClassifications[ac.id] = kinds;
    const primary = primaryAcKind(kinds);

    if (primary === "command") hasCommandAc = true;
    if (primary === "command" || primary === "diff_inspection") hasExecutableAc = true;

    if (primary === "unknown") {
      errors.push(
        `${ac.id}: verification methods are vague or unclassifiable (${ac.verification.join(", ")})`,
      );
    } else if (primary === "human") {
      errors.push(
        `${ac.id}: only human verification methods (${ac.verification.join(", ")}) — not pipeline-executable`,
      );
    }

    if (kinds.includes("command") && seedCommands.length > 0) {
      const acCommands = ac.verification
        .map(extractCommandFromVerification)
        .filter((c): c is string => c !== null);

      for (const cmd of acCommands) {
        const matched = seedCommands.some((available) => commandsCompatible(cmd, available));
        if (!matched) {
          warnings.push(
            `${ac.id}: verification requires "${cmd}" but seed detected commands are [${seedCommands.join(", ")}] — command may be added during implementation`,
          );
        }
      }
    }
  }

  if (!hasExecutableAc) {
    errors.push("Contract has no acceptance criteria with command or diff-inspection verification");
  }

  if (requireCommandAc && !hasCommandAc) {
    const allDiffInspection = contract.acceptance_criteria.every(
      (ac) => primaryAcKind(classifyAcceptanceCriterion(ac)) === "diff_inspection",
    );
    if (!allDiffInspection) {
      errors.push("Contract must include at least one acceptance criterion verifiable via test commands");
    }
  }

  const suggestedTestCommands =
    contractTestCommands.length > 0
      ? contractTestCommands
      : seedCommands.length > 0
        ? seedCommands
        : ["npm run typecheck", "npm test"];

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    suggestedTestCommands,
    contractTestCommands,
    acClassifications,
  };
}

/** Compact context for review/consensus prompts (structured, under budget). */
export function formatCompactContextForReview(
  planningContext: string,
  maxChars = 3_000,
): string {
  const seedMarker = "--- Seed repo context ---";
  const seedIdx = planningContext.indexOf(seedMarker);

  const userSection = (seedIdx >= 0 ? planningContext.slice(0, seedIdx) : planningContext).trim();

  const seedBody = seedIdx >= 0 ? planningContext.slice(seedIdx + seedMarker.length) : "";

  const sections: string[] = [];
  if (userSection) {
    sections.push(userSection);
  }

  const testCommands = extractSectionLines(seedBody, "Detected test commands:");
  if (testCommands.length > 0) {
    sections.push("", "Detected test commands:", ...testCommands);
  }

  const fileTreeLines = extractSectionLines(seedBody, "File tree (top levels):");
  if (fileTreeLines.length > 0) {
    const cappedTree = fileTreeLines.slice(0, 80);
    sections.push("", "File tree (top levels):", ...cappedTree);
    if (fileTreeLines.length > 80) {
      sections.push(`... (${fileTreeLines.length - 80} more lines omitted)`);
    }
  }

  const readmeExcerpt = extractReadmeExcerpt(seedBody, 1_500);
  if (readmeExcerpt) {
    sections.push("", "README excerpt:", readmeExcerpt);
  }

  let compact = sections.join("\n").trim();
  if (compact.length > maxChars) {
    compact = `${compact.slice(0, maxChars)}\n\n[context truncated for review prompt]`;
  }
  return compact;
}

function extractSectionLines(body: string, header: string): string[] {
  const headerIdx = body.indexOf(header);
  if (headerIdx < 0) return [];

  const afterHeader = body.slice(headerIdx + header.length);
  const lines = afterHeader.split("\n");
  const collected: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (
      trimmed.startsWith("README excerpt:") ||
      trimmed.startsWith("Package manifest (") ||
      trimmed.startsWith("Detected test commands:") ||
      trimmed.startsWith("Recent commits:") ||
      trimmed.startsWith("Repository:") ||
      trimmed.startsWith("Scanned at:")
    ) {
      break;
    }
    if (trimmed.length > 0) {
      collected.push(trimmed);
    }
  }

  return collected;
}

function extractReadmeExcerpt(body: string, maxChars: number): string {
  const header = "README excerpt:";
  const headerIdx = body.indexOf(header);
  if (headerIdx < 0) return "";

  const afterHeader = body.slice(headerIdx + header.length);
  const lines = afterHeader.split("\n");
  const collected: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (
      trimmed.startsWith("Package manifest (") ||
      trimmed.startsWith("Detected test commands:") ||
      trimmed.startsWith("Recent commits:")
    ) {
      break;
    }
    collected.push(trimmed);
  }

  const text = collected.join("\n").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[README excerpt truncated]`;
}

export function formatCompactContextFromSeed(
  seed: SeedRepoContext,
  userContext: string,
  maxChars = 3_000,
): string {
  return formatCompactContextForReview(formatSeedContextForPlanning(seed, userContext), maxChars);
}

function seedFromPacket(packet: ContextPacketLike): SeedRepoContext | null {
  const seed = packet.seed;
  if (!seed || typeof seed !== "object") return null;
  return seed as SeedRepoContext;
}

/** Human-readable context for engineering prompts from a stored context packet. */
export function formatContextForEngineering(packet: ContextPacketLike): string {
  const planningContext = packet.planning_context;
  if (typeof planningContext === "string" && planningContext.trim()) {
    return planningContext;
  }

  const userContext = typeof packet.user_context === "string" ? packet.user_context : "";
  const seed = seedFromPacket(packet);
  if (seed) {
    return formatSeedContextForPlanning(seed, userContext);
  }

  if (userContext.trim()) return userContext;
  return JSON.stringify(packet, null, 2);
}

export function resolveTestCommandsFromPacket(
  packet: ContextPacketLike,
  payloadCommands?: string[],
): string[] {
  if (payloadCommands && payloadCommands.length > 0) return payloadCommands;

  const packetCommands = packet.test_commands;
  if (Array.isArray(packetCommands) && packetCommands.every((c) => typeof c === "string")) {
    const cmds = packetCommands as string[];
    if (cmds.length > 0) return cmds;
  }

  const contractCommands = packet.contract_test_commands;
  if (Array.isArray(contractCommands) && contractCommands.every((c) => typeof c === "string")) {
    const cmds = contractCommands as string[];
    if (cmds.length > 0) return cmds;
  }

  const seed = seedFromPacket(packet);
  if (seed?.test_commands?.length) return seed.test_commands;

  return [];
}

export function executabilityContextFromPacket(packet: ContextPacketLike): ExecutabilityContext {
  const seed = seedFromPacket(packet);
  const testCommands = resolveTestCommandsFromPacket(packet);
  return {
    testCommands: testCommands.length > 0 ? testCommands : seed?.test_commands,
    requireCommandAc: true,
  };
}

export interface ExecutionContextPacketInput {
  repoFullName: string;
  userContext: string;
  planningContext: string;
  seed: SeedRepoContext | null;
  contract: TaskContract;
  executability: ExecutabilityResult;
}

export function buildExecutionReadyPacket(input: ExecutionContextPacketInput): Record<string, unknown> {
  return {
    kind: "execution_ready",
    repo_full_name: input.repoFullName,
    user_context: input.userContext,
    planning_context: input.planningContext,
    seed: input.seed,
    contract_summary: {
      title: input.contract.title,
      goal: input.contract.goal,
      scope_in: input.contract.scope.in,
      scope_out: input.contract.scope.out,
      constraints: input.contract.constraints,
    },
    test_commands: input.executability.suggestedTestCommands,
    contract_test_commands: input.executability.contractTestCommands,
    ac_classifications: input.executability.acClassifications,
  };
}
