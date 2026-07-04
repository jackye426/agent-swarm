export function normalizeRequirementsSummary(summary: string | null | undefined): string | null {
  const trimmed = summary?.trim();
  return trimmed ? trimmed : null;
}

export function formatBindingProductDecisions(summary: string | null | undefined): string {
  const normalized = normalizeRequirementsSummary(summary);
  if (!normalized) return "";
  return `

BINDING PRODUCT DECISIONS (from the product owner's intake conversation):
${normalized}
The contract MUST NOT contradict these decisions. If they allow a dependency,
the contract must not forbid it. If they prescribe an approach, acceptance
criteria must be compatible with it. A contradiction is a contract defect.`;
}

export function formatVerificationRequirementsSection(summary: string | null | undefined): string {
  const normalized = normalizeRequirementsSummary(summary);
  if (!normalized) return "";
  return `

Product owner requirements (binding):
${normalized}`;
}
