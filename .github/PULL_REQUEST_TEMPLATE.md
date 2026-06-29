## Task contract

<!-- Link the task contract this PR implements -->
- Task: `T-XXX`
- Contract: [tasks/T-XXX/contract.yaml](../tasks/T-XXX/contract.yaml)

## Acceptance criteria coverage

<!-- For every AC in the contract, state what evidence satisfies it. -->
<!-- A PR that cannot name evidence for every criterion is not ready for review. -->

| Criterion | Evidence | Status |
|-----------|----------|--------|
| AC-1      |          |        |
| AC-2      |          |        |

## Evidence records

<!-- List each evidence file added or updated by this PR. -->
- [ ] `tasks/T-XXX/evidence/E-XXX.yaml`

## Scope declaration

<!-- Did this implementation stay within the contract scope? -->
- [ ] Yes — no scope expansion
- [ ] No — scope expanded (describe below)

<!-- If scope expanded, describe what changed and why. -->

## Guardrails checklist

- [ ] No production secrets added to the repository
- [ ] No direct commits to `main` (this is a branch PR)
- [ ] Migration is additive only (if applicable)
- [ ] Rollback plan confirmed in contract
- [ ] CI passes (`npm run validate` and test suite)

## Required approvals

<!-- List the roles that must approve per the contract's `approvals_required` field. -->
- [ ] Product
- [ ] Engineering

<!-- For high-risk changes add: -->
<!-- - [ ] Privacy review -->
<!-- - [ ] Security review -->
