---
version: 1
affects: [approval_records, src/cells/planning/workflow.ts]
---

# Approval Policy

## Two approval sources

| Source | Approver identity | When used |
|--------|-------------------|-----------|
| **Human approval** | Real person (name in approval record) | Production, privacy/security, release |
| **Auto-approval** | `planning-cell-auto-approver` | v1 dogfood pipeline after multi-agent review |

## Auto-approval conditions

The planning cell auto-approves when **all** of the following hold:

1. Draft contract generated through multi-agent review (Plan A, Plan B, cross-critique, consensus)
2. Executability validation passes (`validateContractExecutability` — errors empty; warnings allowed)
3. Contract revision loop exhausted or revision succeeded
4. No unclassifiable or human-only-only acceptance criteria blocking the pipeline

On auto-approval the cell:

- Publishes contract version
- Records `approval_records` for **every** role in `approvals_required`
- Transitions task to READY
- Writes `contract_auto_approved` human_notification artifact

## When human approval is required (production)

These must never rely on auto-approval alone:

- **Privacy** — data retention, consent, patient/clinic data handling
- **Security** — authentication, tenant isolation, secrets management
- **Production release** — deployment to production environments
- **Scope expansion** — changes beyond approved contract scope

For production, use explicit approval JSON with attributable approver:

```json
{
  "decision": "approved",
  "approver": "Jane Owner",
  "roles": ["Product", "Engineering"]
}
```

## Known v1 limitation

`requiredApprovalsRecorded()` checks only that a role name exists in `approval_records`, not that a human signed off.

Auto-approval records **all** roles from `approvals_required` — including "Privacy review" if listed in the contract — under approver `planning-cell-auto-approver`. This satisfies COMPLETE guard checks in dogfood but must not be used for production privacy/security gates without a real human approver.

## AWAITING_APPROVAL vs auto-approve

If executability validation **fails** after contract revision, the task stays at AWAITING_APPROVAL. A `contract_validation_failed` artifact and human_notification are written. Human must fix the contract or seed context before retry.

See [001-auto-approval.md](../decisions/001-auto-approval.md).
