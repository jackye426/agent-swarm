---
version: 1
affects: [src/core/verification.ts, src/core/contract-executability.ts, evidence_records]
---

# Evidence and Verification

## Acceptance criterion kinds

Each AC's `verification` methods are classified in `src/core/contract-executability.ts`:

| Kind | Examples | Primary use |
|------|----------|-------------|
| **command** | `npm test`, `npm run typecheck` | Runnable test/CI commands |
| **diff_inspection** | "Inspect workflow steps in diff", "File presence check in PR diff" | Judge from PR diff, not CI alone |
| **human** | "Manual review by Engineering Owner" | Requires explicit human evidence |
| **unknown** | "Works as expected" | Unclassifiable — blocks executability |

Primary kind for an AC: `command` > `diff_inspection` > `human` > `unknown`.

## What satisfies each kind

### command

Requires **both**:

1. Model verdict PASS (or NOT_APPLICABLE)
2. A passing `ci_run` evidence record linked to that AC id

Engineering cell produces `ci_run` evidence when test commands exit 0.

### diff_inspection

Requires **only**:

1. Model verdict PASS (or NOT_APPLICABLE)

A model PASS on a diff_inspection AC is sufficient **without** a passing CI evidence record. This is enforced in `computeEffectiveMissingEvidence()` — diff_inspection ACs with PASS are removed from the missing-evidence list even when no `ci_run` exists for that AC.

### human

Requires explicit human evidence (approval artifact, human_review record). Without it, verdict should be INCONCLUSIVE or NOT_APPLICABLE.

## Verifier judging rules

Used by the verification cell model prompt (source: this section):

- **command verification**: use CI output and ci_run evidence
- **diff_inspection verification**: judge primarily from the PR diff; do not require CI alone
- **human verification**: PASS only if explicit human evidence exists; otherwise INCONCLUSIVE or NOT_APPLICABLE
- **Scope violations**: flag if changed files appear to touch scope.out areas
- **Product-owner requirements**: if an acceptance criterion conflicts with binding product-owner requirements from intake, classify the failure owner as `contract`, not `implementation`

## deriveTaskVerdict priority chain

Evaluated in order (`src/core/verification.ts`):

1. Any **blocking defects** → REWORK_REQUIRED
2. Any criterion verdict **FAIL** → REWORK_REQUIRED
3. No verdicts or any **INCONCLUSIVE** → BLOCKED
4. Any **missing evidence** (after reconciliation) → REWORK_REQUIRED
5. All PASS or NOT_APPLICABLE → COMPLETE
6. Otherwise → BLOCKED

## Executability vs runtime verification

**Known constraint:** executability validation at planning time checks **current** seed-detected commands, not commands the task will add during implementation.

Example: a task to add `npm run healthcheck` will have that command in the contract before the script exists in the repo. Seed scan only finds `[npm test]`. This mismatch produces a **warning** (not an error) so auto-approval can proceed; engineering adds the script and verification confirms.

Unclassifiable (`unknown`) or human-only ACs still **fail** executability validation.
