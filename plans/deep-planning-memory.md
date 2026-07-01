# Feature Implementation Plan: Simple Deep Planning + Memory

**Overall Progress:** `0%`

## TLDR
Keep the product idea simple: use deeper planning only when it directly improves the next task contract. Do not build a large planning operating system up front.

The first useful version should:
- keep the current fast planning path for narrow tasks;
- add a compact deep planning path for vague/product-level requests;
- use resolved repo context from `production-hardening.md`;
- ask a few clarifying questions only when they materially change the plan;
- store a small number of durable lessons, not a giant memory graph.

The goal is still:

```text
vague intent -> repo-grounded thinking -> good small contract -> execute -> verify -> learn
```

## What We Are Avoiding For V1

Do not start with:
- 10+ planning nodes;
- embedding search;
- web research;
- auto-spawned roadmap task trees;
- separate planning artifact tables;
- complex memory expiry/supersede flows;
- many new model-role environment variables;
- automatic clarification timeout logic.

These can be added later only if the simple version proves it needs them.

## Dependency On Slice 0

Deep planning starts after Slice 0 from `plans/production-hardening.md`:

```text
repo resolution
  -> task has repo/source context
  -> seed repo scan exists
  -> current planning flow receives repo context
```

Without this, deep planning is too likely to invent architecture that does not match the repo.

## Planning Modes

### Fast Plan
Use the existing planning graph for clear, narrow work.

Examples:
- Add a CI workflow.
- Fix a failing test.
- Add a missing env var.
- Change a specific file or script.

Behavior:
- current planA/planB/review/consensus/contract path;
- no extra memory/research machinery;
- keep cheap and fast.

### Deep Plan
Use only for vague, product-level, integration-heavy, or multi-step asks.

Examples:
- Build a social media agent.
- Make this product production-ready.
- Add an MCP tool for my business workflow.
- Build a dashboard for operations.

Behavior:
- spend more model time;
- use seed repo context;
- optionally ask 1 to 3 high-leverage questions;
- produce a product direction, architecture approach, roadmap artifact, and first narrow contract.

## Simple V1 Deep Planning Path

Deep planning should start with three model passes, not eleven.

### 1. Product / Intent Expansion
Expand the vague request into a useful product interpretation.

Output artifact: `deep_intent_brief`

Include:
- likely user intent;
- assumed target user;
- possible workflows/features;
- important unknowns;
- explicit assumptions;
- whether clarification is needed.

### 2. Architecture + Task Breakdown
Map the product idea onto the resolved repo and seed codebase context.

Output artifact: `deep_architecture_plan`

Include:
- where this fits in the repo;
- likely files/modules/DB/API/UI areas;
- test strategy;
- risks;
- MVP vs later work;
- proposed first task;
- lightweight roadmap.

### 3. Critic + First Contract
Critique the plan, cut scope, and draft the first executable contract.

Output artifacts:
- `deep_plan_review`
- `draft_contract`

Include:
- what is too broad;
- hidden risks;
- what is deliberately out of scope;
- first contract small enough for one engineering run;
- concrete acceptance criteria and evidence.

## Clarifying Questions

Clarifying questions are allowed, but keep them rare and high leverage.

Ask only when the answer changes:
- product direction;
- repo/architecture choice;
- data model;
- auth/security posture;
- task boundaries.

Good:
- "Is this for your own accounts, client accounts, or a SaaS product for many users?"

Bad:
- "What features do you want?"

V1 behavior:
- Planning may ask 1 to 3 questions.
- Resume requires explicit user response.
- No automatic timeout/default scheduler yet.

Repo-selection questions are not planning questions. They happen before task creation in Slice 0.

## Simple Memory V1

Use one table later, but keep the mental model small.

Memory types:
- `user`: stable user/product preferences;
- `repo`: repo conventions, commands, architecture notes;
- `decision`: important choices and why;
- `lesson`: verification failures, rework causes, useful successes.

Scopes:
- `global`;
- `repo:owner/name`;
- `task:T-NNN`.

Rules:
- Store short durable lessons only.
- Prefer fewer, better memories.
- Do not write every thought.
- No embeddings in v1.
- No expiry/supersede in v1.
- Bad memory is worse than no memory.

## Minimal Data Model Later

Not part of Slice 0. Add only when ready for the memory slice.

```sql
create type memory_type as enum ('user', 'repo', 'decision', 'lesson');

create table memory_items (
  id           uuid primary key default gen_random_uuid(),
  memory_type  memory_type not null,
  scope        text not null default 'global',
  subject      text not null,
  content      text not null,
  source       text not null,
  created_at   timestamptz not null default now()
);
```

Retrieval v1:
- fetch repo-scoped memories for the task repo;
- fetch recent global decisions/lessons;
- optionally keyword-match subject;
- keep the packet small.

## Research V1

Do not add web research yet.

For the first deep-planning version:
- use model knowledge;
- label it as uncited inference;
- put unknowns into the plan instead of pretending certainty.

Later, add tool-backed research with citations for API/platform/legal/high-risk domains.

## Revised Implementation Phases

- [ ] **Phase 0: Slice 0 substrate**
  - [x] Resolve repo before planning.
  - [x] Persist repo/source context.
  - [x] Build seed repo context.
  - [x] Pass seed context into current planning.
  - [ ] Run `004_multi_repo.sql` in Supabase.
  - [ ] Smoke test `/task --repo owner/repo ...` and GitHub issue intake.

- [ ] **Phase 1: Mode router**
  - [ ] Add `planning_mode: auto | fast | deep`.
  - [ ] Default clear tasks to `fast`.
  - [ ] Route vague/product-level tasks to `deep`.
  - [ ] Allow manual override in payload.

- [ ] **Phase 2: Compact deep path**
  - [ ] Add `deep_intent_brief`.
  - [ ] Add `deep_architecture_plan`.
  - [ ] Add `deep_plan_review`.
  - [ ] Feed reviewed first-task scope into existing contract drafter.
  - [ ] Keep fast path unchanged.

- [ ] **Phase 3: Simple clarification**
  - [ ] Planning can emit a `human_notification` asking 1 to 3 questions.
  - [ ] Resume only by explicit user response.
  - [ ] No timeout logic yet.

- [ ] **Phase 4: Simple memory**
  - [ ] Add minimal `memory_items` table.
  - [ ] Retrieve small memory packet before deep planning.
  - [ ] Write only short durable lessons after planning/verification.

- [ ] **Phase 5: Rework cap and lesson writeback**
  - [ ] Automatic rework stops after configured cap.
  - [ ] Rework failures produce short `lesson` memories.

## Deferred

- Web/docs research with citations.
- Embedding-based memory search.
- Auto-created roadmap task rows.
- Complex memory confidence/expiry/supersede.
- Parallel workers.
- Dedicated planning artifact table.
- Large model-role matrix.

## Success Criteria

- Fast tasks remain fast.
- Vague tasks produce better first contracts.
- Repo context is present before deep planning.
- The planner asks fewer, better questions.
- Memory stays short and useful.
- Each added layer directly improves contract quality.
