# TaskGraph OS v1

**Status:** Draft
**Owner:** Product and Engineering
**Purpose:** Define the production architecture and operating model for a state-centric, evidence-gated agent swarm.

---

## 1. Product thesis

TaskGraph OS is a **state-centric control plane for agentic work**.

It coordinates durable work, rather than coordinating conversations between permanent agents.

The system manages:

* goals
* task contracts
* task dependencies
* approvals
* artifacts
* evidence
* verification
* decisions
* reusable lessons

AI workers are replaceable execution units. They may be Claude Code, Codex, ChatGPT, CI, a human reviewer, or a future specialist agent.

```text
Goal
  ↓
Task Contract
  ↓
Task Dependency Graph
  ↓
Scheduler
  ↓
Operational Cell Workflow
  ↓
Worker Execution
  ↓
Evidence and Verification
  ↓
Task State Update
  ↓
Downstream Work Becomes Ready
```

The system is not a generic multi-agent chatroom.

It is an operating system for accountable, inspectable work.

---

## 2. Architectural position

TaskGraph OS uses a hybrid architecture:

```text
TaskGraph OS
= company-level work control plane

LangGraph
= workflow runtime inside operational cells

Claude Code / Codex / CI / humans
= capability-based workers
```

LangGraph is not rejected. It is used where it is strongest: inside a planning, design, engineering, verification, or release workflow that may need branching, retries, subagents, human pauses, or resumable state.

Supabase Postgres remains the system of record for all durable company-level work state.

```text
Supabase Postgres
= ledger of work reality

Supabase Queues
= reliable dispatch mechanism

LangGraphJS
= internal workflow engine for a specific cell run

GitHub
= source of code truth and CI evidence

Workers
= temporary executors
```

---

## 3. Why this is not a generic role-based LangGraph swarm

A generic role-based architecture often looks like:

```text
Supervisor
  ↓
Planner Agent
  ↓
Backend Agent
  ↓
Frontend Agent
  ↓
QA Agent
  ↓
Done
```

That structure primarily coordinates agent handoffs.

TaskGraph OS instead coordinates work through durable state:

```text
Task contract approved
  ↓
Dependencies complete
  ↓
Task becomes READY
  ↓
Appropriate operational cell is invoked
  ↓
Worker produces artifacts and evidence
  ↓
Verification evaluates contract compliance
  ↓
Task becomes COMPLETE, REWORK_REQUIRED, or BLOCKED
```

The central question changes from:

> Which agent should speak or act next?

to:

> Which approved task is eligible to proceed, who can execute it, and what evidence is required before it can complete?

---

## 4. Organisational structure

TaskGraph OS has stable organisational cells.

Cells define accountability, mandate, inputs, outputs, authority, and verification requirements.

Workers are assigned to tasks within cells based on capability.

```text
Human Product and Governance
             │
             ▼
      Work Control Plane
             │
             ▼
  Scheduler and Policy Engine
             │
 ┌───────────┼────────────┬─────────────┬─────────────┐
 ▼           ▼            ▼             ▼             ▼
Planning    Design     Engineering   Verification   Release
Cell        Cell       Cell          Cell           Cell
```

### 4.1 Planning Cell

**Purpose:** Convert product goals into approved, executable task contracts.

**Inputs**

* Product goal
* Existing architecture
* User research
* Prior decisions
* Relevant repository context
* Risk and policy constraints

**Outputs**

* Independent implementation plans
* Risk analysis
* Proposed task contracts
* Dependency map
* Test and rollback plan

**Authority**

* May propose scope, architecture, sequencing, and risks
* Cannot approve privacy, product, or release trade-offs alone

**Typical workers**

* Claude planner
* ChatGPT or Codex independent planner
* Architecture reviewer
* Human product owner

---

### 4.2 Design Cell

**Purpose:** Convert approved product requirements into usable experience specifications.

**Inputs**

* Product goal
* Task contract
* User research
* Design system
* Existing product patterns
* Technical constraints

**Outputs**

* User flow
* Screen states
* Component requirements
* Empty and error states
* Accessibility requirements
* Design acceptance criteria
* Handoff artifacts for engineering

**Authority**

* Owns interaction and interface recommendations
* Cannot independently approve data retention, privacy policy, or release decisions

**Typical workers**

* Design reasoning agent
* Frontend design critic
* Accessibility reviewer
* Human product or design reviewer

---

### 4.3 Engineering Cell

**Purpose:** Convert approved task contracts into production-ready code, tests, migrations, and pull requests.

**Inputs**

* Approved task contract
* Approved design artifacts where relevant
* Minimal context packet
* Repository conventions
* Test commands
* Allowed file paths

**Outputs**

* Code diff
* Migration
* Tests
* Pull request
* Implementation report
* Initial evidence package

**Authority**

* May choose implementation details within contract constraints
* Must declare scope expansion
* Cannot self-certify completion
* Cannot merge to main or deploy to production independently

**Typical workers**

* Claude Code implementation worker
* Migration specialist
* Test repair worker
* Documentation worker

---

### 4.4 Verification Cell

**Purpose:** Determine whether an implementation actually satisfies the approved task contract.

**Inputs**

* Task contract
* Pull request diff
* Changed files
* CI output
* Evidence records
* Prior decisions
* Risk profile

**Outputs**

* Verification report
* Acceptance criterion verdicts
* Blocking defects
* Missing evidence
* Regression risks
* Rework task where necessary

**Authority**

* May block completion
* May require additional evidence or tests
* Must not silently modify implementation while acting as verifier
* Cannot approve product or privacy trade-offs outside the contract

**Typical workers**

* Codex reviewer
* Independent ChatGPT reviewer
* Security reviewer
* Contract verifier
* CI test runner
* Human reviewer for high-risk changes

---

### 4.5 Release Cell

**Purpose:** Validate that approved work is safe to release and operationally observable.

**Inputs**

* Approved pull request
* Verification report
* Deployment plan
* Rollback plan
* Environment configuration
* Required approvals

**Outputs**

* Staging validation report
* Production release decision
* Smoke test evidence
* Monitoring and alert configuration
* Rollback confirmation where relevant

**Authority**

* May block release
* Cannot override missing approvals
* Production release requires explicit human approval in v1

**Typical workers**

* Staging validation worker
* Deployment worker
* Observability checker
* Human release owner

---

## 5. Roles, capabilities, tasks, and agent runs

TaskGraph OS still has roles. The distinction is that roles are not fixed model identities.

```text
Cell
= stable organisational function

Capability
= reasoning skill or tool access needed

Task
= bounded unit of accountable work

Agent Run
= temporary worker execution
```

Example:

```text
Cell:
Design Cell

Task:
Create the empty-state workflow for clinic analytics.

Capabilities:
- UX design
- data visualisation
- accessibility review
- knowledge of the existing design system

Agent Run:
GPT design worker, run D-042

Output:
Design specification and testable design acceptance criteria.
```

The system does not say:

> GPT is permanently the Design Agent.

It says:

> This task requires design capabilities and is currently assigned to this worker under this contract.

---

## 6. Core objects

### Goal

A business or product outcome.

```text
Help clinics understand where prospective patients leave an enquiry journey.
```

### Task Contract

The binding definition of a bounded unit of work.

It defines:

* objective
* scope
* dependencies
* constraints
* acceptance criteria
* required evidence
* risks
* rollback
* approval requirements

### Context Packet

The minimum approved information a worker needs to perform its task.

It should contain only relevant contracts, artifacts, files, design specifications, policies, and prior decisions.

### Artifact

A concrete output of a task.

Examples:

* code diff
* schema migration
* API contract
* UI specification
* test report
* pull request
* architecture decision record

### Evidence

A verifiable artifact proving or disproving an acceptance criterion.

Examples:

* passing integration test
* migration dry run
* browser test
* security check
* Codex review finding
* human approval

### Agent Run

A temporary execution by a worker.

Examples:

* Claude Code implementation run
* Codex verification run
* GitHub Actions CI run
* human privacy review

---

## 7. Task contract

The task contract is the core object in the system.

It is not a ticket, prompt, or implementation plan.

```text
Ticket:
Add clinic analytics.

Plan:
Create event schema, API, aggregation, and dashboard endpoint.

Task Contract:
Implement approved behaviour under explicit constraints,
and prove each requirement with named evidence.
```

Each task contract is stored at:

```text
/tasks/T-###/contract.yaml
```

### Required structure

```yaml
id: T-001
title: Add clinic enquiry event tracking

goal: >
  Give clinics aggregate visibility into enquiry progression
  without exposing identifiable patient data across tenants.

status: draft

owner:
  product: Product owner
  engineering: Engineering owner

scope:
  in:
    - Event schema
    - Event ingestion endpoint
    - Tenant-safe aggregation endpoint
  out:
    - Dashboard UI
    - CRM integrations
    - Patient recommendations

dependencies:
  - Existing clinic tenant model
  - Consent policy decision

constraints:
  - No production patient data in agent environments
  - Tenant isolation enforced server-side
  - Additive migrations only
  - Consent required before contact details are persisted
  - Existing widget journey must remain unchanged

acceptance_criteria:
  - id: AC-1
    requirement: Event payloads are validated and unknown fields are rejected.
    verification:
      - API validation integration test

  - id: AC-2
    requirement: Clinic A cannot retrieve Clinic B analytics.
    verification:
      - Seeded multi-tenant integration test
      - Independent review of query scoping

  - id: AC-3
    requirement: Empty clinics receive valid zero-state metrics.
    verification:
      - API integration test

  - id: AC-4
    requirement: Consent events are audit logged.
    verification:
      - Database assertion
      - Audit-log integration test

risks:
  - risk: Analytics data could cross tenant boundaries.
    mitigation: Server-side tenant scoping and seeded cross-tenant tests.

rollback:
  - Feature flag disables event ingestion.
  - Migration is additive and reversible.

approvals_required:
  - Product
  - Engineering
  - Privacy review
```

---

## 8. Evidence loop

The evidence loop is how the system earns the right to call a task complete.

```text
Contract claim
  ↓
Implementation
  ↓
Evidence collection
  ↓
Independent verification
  ↓
Verdict
  ↓
Complete, rework, block, or cancel
```

### Evidence loop rules

1. Every acceptance criterion must have named verification before implementation begins.
2. Every required evidence item must be linked to a task and criterion.
3. Evidence must reference a specific commit, CI run, or artifact version.
4. An implementation worker cannot be the only authority that work is complete.
5. A model narrative is never sufficient evidence on its own.
6. Any relevant code change invalidates prior evidence and requires re-verification.
7. Missing required evidence blocks completion.

### Evidence record

```yaml
evidence_id: E-014
task_id: T-001
acceptance_criteria:
  - AC-2
type: integration_test
status: pass
commit_sha: abc123
source: github-actions-run-url
command: pnpm test tenant-isolation
timestamp: 2026-06-29T12:00:00Z
summary: >
  Clinic A request for Clinic B analytics was rejected.
```

### Task-level verdicts

```text
COMPLETE
REWORK_REQUIRED
BLOCKED
CANCELLED
```

### Criterion-level verdicts

```text
PASS
FAIL
INCONCLUSIVE
NOT_APPLICABLE
```

---

## 9. Task lifecycle

```text
DRAFT
  ↓
PLANNING
  ↓
AWAITING_APPROVAL
  ↓
READY
  ↓
IN_PROGRESS
  ↓
AWAITING_EVIDENCE
  ↓
VERIFYING
  ├── PASS → COMPLETE
  ├── FAIL → REWORK_REQUIRED
  ├── UNRESOLVED_RISK → BLOCKED
  └── NO_LONGER_NEEDED → CANCELLED
```

### State transition rules

A task may become `READY` only when:

* contract validation passes
* required dependencies are complete
* required approvals are recorded
* required context is available

A task may become `COMPLETE` only when:

* all acceptance criteria have verdicts
* all required evidence exists
* deterministic CI checks pass
* independent verification finds no blocker
* required human approvals are recorded

---

## 10. Technical architecture

### 10.1 Control plane

**Supabase Postgres** is the durable source of truth.

It stores:

```text
goals
tasks
task_dependencies
task_contract_versions
context_packets
artifacts
agent_runs
evidence_records
verification_records
decision_records
approval_records
task_events
```

The task dependency graph lives in Postgres.

It must be queryable by humans and systems.

Examples:

```text
Which tasks are blocked by an unapproved privacy decision?

Which analytics tasks repeatedly fail tenant-isolation verification?

Which worker types produce the most rework?

Which evidence requirements are most often missing?
```

### 10.2 Dispatch layer

**Supabase Queues** handles durable, asynchronous top-level job dispatch.

Examples:

```text
task.plan.requested
task.design.requested
task.execution.requested
task.verification.requested
task.release.requested
task.rework.requested
```

The queue wakes workers. It does not define work semantics.

### 10.3 Agent workflow runtime

**LangGraphJS** runs workflows inside operational cells.

Examples:

```text
Planning Cell workflow:
Inspect context
→ Claude Plan A
→ Independent Plan B
→ Cross-critique
→ Draft task contract
→ Human approval interrupt
→ Publish approved contract

Engineering Cell workflow:
Compile context packet
→ Create worktree
→ Invoke Claude Code
→ Run tests
→ Create PR
→ Publish implementation evidence

Verification Cell workflow:
Read contract
→ Read diff and CI evidence
→ Codex review
→ Map evidence to criteria
→ Return verdict
```

LangGraph does not own the cross-task dependency graph or final task state.

It may checkpoint internal worker progress, but final artifacts, decisions, evidence, and task transitions must be written back to Supabase.

### 10.4 Code and execution infrastructure

**GitHub** is the code system of record.

**GitHub Actions** provides isolated execution, deterministic CI, artifact retention, and PR automation.

**Claude Code** is the initial implementation worker.

**Codex** is the initial independent code review worker.

---

## 11. System boundaries

```text
Supabase Postgres:
What is true about work.

Supabase Queues:
What needs to happen next.

LangGraph:
How one cell run proceeds internally.

GitHub:
What code changed and what CI proved.

Claude, Codex, and other workers:
Who executed a temporary unit of work.
```

Do not use LangGraph as the sole source of truth for:

* task contracts
* approvals
* task dependencies
* evidence history
* decisions
* product requirements
* task state

Do not use Supabase Queues and LangGraph dispatch to control the same top-level job lifecycle.

Supabase Queue dispatches the cell run. LangGraph handles internal workflow steps within that cell run.

---

## 12. Context packet policy

Workers should not receive the entire repository by default.

Each context packet should include only:

```text
- task contract
- allowed file paths
- relevant architecture documents
- required APIs and schemas
- design specifications
- applicable policies
- prior decisions
- required tests
- known constraints
```

Every context packet should be versioned and linked to the relevant agent run.

This makes failures reproducible.

---

## 13. Guardrails

* No production secrets in agent environments.
* No production patient or clinic data in agent workspaces.
* No direct commits to `main`.
* No autonomous production deployment in v1.
* No task may bypass required human approvals.
* No worker may silently expand scope.
* No implementation worker may self-certify completion.
* No verification worker may silently modify code while verifying.
* Privacy, consent, authentication, tenant isolation, billing, migrations, and production release require human review.
* Every task must have a rollback plan where production behavior or state is affected.

---

## 14. V1 implementation scope

### Build now

1. Supabase schema for tasks, dependencies, contracts, evidence, runs, and approvals.
2. Contract and evidence validation schemas.
3. Repository folder structure for task artifacts.
4. GitHub Action for validation, CI, and evidence upload.
5. Basic scheduler service using Supabase Queues.
6. Planning Cell LangGraph workflow.
7. Engineering Cell LangGraph workflow invoking Claude Code.
8. Verification Cell LangGraph workflow invoking Codex and reading CI evidence.
9. Minimal internal task graph UI or SQL admin views.
10. Human approval gate before merge and release.

### Do not build yet

* Autonomous model routing
* Self-modifying policies
* General-purpose memory graph
* Agent marketplace
* Fully autonomous deployment
* Complex optimisation algorithms
* Multi-project scheduling
* Dynamic resource auctions between agents

---

## 15. Initial milestone

### T-001: Task contract and evidence system

**Goal:**
Prove that work can be governed by contracts and evidence before adding a broader swarm.

**Deliverables**

```text
- Task contract schema
- Evidence schema
- Contract validation script
- Evidence validation script
- Supabase tables
- Example task folder
- GitHub Action
- Pull request template
- Basic task state machine
```

**Acceptance criteria**

```text
- Invalid contracts fail CI.
- A contract without evidence mapping fails CI.
- Evidence cannot reference an unknown criterion.
- A task cannot become COMPLETE without all required evidence.
- Every evidence item is tied to a commit or CI run.
- Example task demonstrates the full lifecycle.
```

### T-002: Planning Cell

**Goal:**
Generate two independent plans and compile an approved task contract.

### T-003: Engineering Cell

**Goal:**
Run Claude Code in an isolated worktree and produce structured implementation evidence.

### T-004: Verification Cell

**Goal:**
Run CI and Codex review, then map results to contract criteria.

---

## 16. Success metrics

Track the quality of completed work, not the number of agent runs.

```text
- Percentage of tasks with approved contracts before implementation
- Percentage of acceptance criteria with evidence mapping
- Rework rate after verification
- Defects found by CI
- Defects found by independent model review
- Post-merge regression rate
- Scope-expansion rate
- Human intervention rate by risk category
- Average time from approved contract to merge
- Repeated lessons converted into templates or automated checks
```

The desired result is:

```text
More explicit requirements
Higher evidence coverage
Earlier defect detection
Less post-merge regression
Less unplanned work
Better model swapability
Clearer human accountability
```

---

## 17. Non-negotiable rule

A task is not complete because code was written.

A task is complete only when:

```text
The approved contract is satisfied,
the required evidence exists,
independent verification passes,
and required human approvals are recorded.
```
