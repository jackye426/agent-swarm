# Capability Upgrade v3 — Frontier: Verification-Gated Autonomy That Compounds Knowledge

**Overall Progress:** `10%`

> **Executor notes (read first):**
> - Prerequisite: [`capability-upgrade-v2.md`](capability-upgrade-v2.md) Steps 0–3 must be DONE (merge-on-COMPLETE especially — Steps 2 and 7 here depend on integration existing).
> - Run `npm run typecheck && npm test` after every step; keep the suite green.
> - Deploy after code steps: `pm2 restart taskgraph-scheduler taskgraph-intake --update-env; pm2 save`.
> - `src/cells/planning/workflow.ts` is blank-line-heavy — copy Edit anchors from a fresh Read.
> - **Critical path:** `3 (evals) → 3.5e/f/a/g/b → 5a (candidate verification) → 6 → 6.5 → workers=2`. Step 2 runs lightweight alongside; Steps 4/4.5 and the 3.5c shadow ensemble are eval-gated — implement only when baseline data justifies them. Do not reorder 3 later.
> - Step 6 is gated: do not start it until the human confirms the Phase 5 soak has formally passed.

## TLDR

Strategy: ride the model curve for generation (swappable, commodity), **own the two layers that appreciate as models improve — the verification gate and per-repo compounding knowledge.** This plan: (1) puts the strongest models on the judgment seats, (2) builds repo knowledge cards + scope-targeted retrieval, (3) builds an eval harness so all later changes are measured, (3.5) **rearchitects verification itself — independent re-execution, agentic audit with tools, ensemble adjudication, measured calibration** (this is the beyond-SOTA step; the rest is parity), (4) adds a bounded inner fix loop inside engineering, (5) enables 2-worker parallelism with a safe merge queue — gated on verifier recall ≥ 7/8 from 3.5d, (6) adds runtime verification (run the app, assert behavior), (7) makes failures write lessons back into the knowledge layer.

## Critical Decisions

- **Generator stays cheap-ish, judges get strong.** Claude Code remains the implementation worker. `MODEL_VERIFICATION`, `MODEL_CONTRACT_DRAFT`, and `MODEL_PLANNING_CONSENSUS` move to a frontier-class model. Verification runs 1–4×/task with an 8k output cap — this is dollars per task, not tens.
- **Knowledge lives in the TaskGraph repo** (`system-knowledge/repos/`), not in target repos — it must cover cross-task history and decisions that are not in any target repo's code.
- **Evals run against local git fixtures** (bare repo + clone, same pattern as `tests/verification-diff.test.ts`), not GitHub — deterministic, free, CI-able.
- **Parallelism = independent tasks only, integration serialized by push-retry.** Best-of-n implementation sampling is explicitly OUT of this plan (design sketch only, Step 5c) — it needs eval data to justify its cost.
- **Runtime verification v1 is process + HTTP assertions, no browser.** Playwright is a stub interface to fill later.
- **High-risk sectors get stricter defaults.** Healthcare, finance, legal, security-sensitive, safety-critical, public-sector/compliance, child-facing, employment/housing/credit, and regulated-data workflows are not ordinary CRUD tasks. The planner must label them, require stronger evidence, avoid unverifiable claims, and route ambiguity to a human rather than letting autonomy silently proceed.

## Tasks:

- [x] ✅ **Step 1: Model reallocation — strongest models on the judgment seats**
  - [x] ✅ In `.env` (append/replace lines; file may have a BOM until v2 Step 0 runs — edit carefully, never rewrite wholesale):
    - `MODEL_VERIFICATION=anthropic/claude-sonnet-5` (or the strongest the human approves)
    - `MODEL_CONTRACT_DRAFT=anthropic/claude-sonnet-5`
    - `MODEL_PLANNING_CONSENSUS=anthropic/claude-sonnet-5`
    - Leave planning_a/b, reviews, engineering_plan, contract_revision, intake_conversation on the cheap stack for now (Step 3's evals will tell us if they matter).
  - [x] ✅ Update `.env.example` comment block: explain the generator-verifier principle in two lines ("verification is the system's trust ceiling; fund the gate, keep generation cheap").
  - [x] ✅ `pm2 restart taskgraph-scheduler --update-env`. Verify with one `npm run watchdog:once` (clean) and by checking the next verification's `agent_runs`/OpenRouter usage shows the new model.
  - [x] ✅ Record the change + date in `system-knowledge/operations/soak-2026-07.md` (model changes mid-soak must be logged).

- [ ] 🟥 **Step 2: Repo knowledge cards + scope-targeted retrieval**
  - [ ] 🟥 New module `src/core/repo-card.ts`:
    - `repoCardPath(repoFullName)` → `system-knowledge/repos/${owner}__${name}.md` (double underscore separator; create dir).
    - `readRepoCard(repoFullName): Promise<string | null>` — null when absent.
    - `updateRepoCard(repoFullName, mergedDiff: string, taskId: string): Promise<void>` — invoke a NEW model role `repo_card` (add to `src/core/model-router.ts`: env `MODEL_REPO_CARD`, default same as cheap stack) with: current card (or a template for first run) + the merged diff + task title, system prompt:
      ```
      You maintain a compact knowledge card for a code repository. Update it to reflect
      the merged change. Keep under 3000 chars. Sections (keep these exact headings):
      ## Purpose  ## Module map  ## Conventions  ## Key commands  ## Recent changes (last 5, newest first)
      Never remove information still true; compress rather than delete.
      ```
      Write the result to the card path. Failures log a warning and never throw (card is best-effort).
  - [ ] 🟥 **Bootstrap the first card deterministically, not from a diff.** A merged diff cannot infer Purpose/Module map/Key commands. `updateRepoCard` on a missing card first calls a `bootstrapRepoCard(repoFullName)` that builds the initial card from the seed scanner's deterministic output (`scanRepoSeedContext`: README excerpt, package manifest + scripts, root file tree, recent commits) via one model call with the card template — THEN applies the diff update. Subsequent updates are diff-driven only.
  - [ ] 🟥 Call `updateRepoCard` from the merge-success path of `integrateCompletedTaskBranch` (v2 Step 1) — the merged diff is obtainable there via `git diff <default>@{1}..<default>` or by capturing the merge diff before push; simplest: `git show --stat -p HEAD` in the integration worktree before cleanup, capped at 30k chars.
  - [ ] 🟥 Inject the card where judgment happens:
    - `src/intake/conversation.ts` — add to `PromptContext` + `buildSystemPrompt` (section `REPO KNOWLEDGE CARD:`), loaded in `handleConversationMessage` next to the snapshot.
    - `src/cells/planning/workflow.ts` — prepend to the contract-draft user message when present.
    - `src/cells/verification/workflow.ts` — insert into `runModelReview` user message (after requirements section from v2 Step 2).
  - [ ] 🟥 Scope-targeted retrieval — new helper in `src/core/contract-executability.ts` or new `src/core/scope-retrieval.ts`: `readScopedFiles(repoRoot: string, scopeIn: string[], maxTotalChars = 20000): Promise<string>` — for each scope entry that looks like a concrete path (contains `/` or `.`), read the file if it exists under repoRoot, concatenate with `=== path ===` headers, head-truncate to budget. Wire into the engineering context packet (where `enrichExecutionContextPacket` builds `execution_ready`) so Claude Code starts with the full text of in-scope files, and into verification's user message (replacing nothing — additive section `Current content of in-scope files:`).
  - [ ] 🟥 High-risk-sector detection — new helper `classifyRiskDomain({ goal, context, repoCard, scopedFiles }): "standard" | "high_risk"` plus reason tags (`healthcare`, `finance`, `legal`, `security`, `safety_critical`, `children`, `employment_housing_credit`, `public_sector`, `regulated_data`). Inject the classification into intake, planning, engineering, and verification prompts. False positives are acceptable; false negatives are not. **The LLM classifier is escalate-only: the per-repo verification policy (3.5f) carries a static `risk_tier` in its frontmatter as the floor, and the effective tier is `max(policy floor, classifier)` — a model may raise risk, never lower it below the humans' standing judgment.**
  - [ ] 🟥 Tests: `tests/repo-card.test.ts` — path derivation, read-missing→null, section-preserving update can be tested by mocking `invokeRoleModel`? The repo has no mocking convention for it — instead export the prompt-builder pure function and test that; test `readScopedFiles` against fixture dirs (budget cap, missing files skipped, non-path scope entries ignored).

- [ ] 🟥 **Step 3: Eval harness (before any loop changes — this is the measuring stick)**
  - [ ] 🟥 `evals/cards/*.json` — task cards, schema: `{ id, title, goal, context, fixture: { files: Record<path, content> }, expect: { status: "COMPLETE" | "BLOCKED", max_rework: number, files_exist?: string[], forbidden_paths?: string[] } }`. Seed battery of 10:
    - 3 happy-path (README edit; add util + test; add npm script + doc) — distilled from T-005/T-009/T-010 history.
    - 2 regression cards for solved failure classes: contradictory AC (T-011's committed+gitignored), requirements-conflict (T-012's express) — these assert the pipeline reaches COMPLETE within `max_rework: 1` via the revision loop, not the rework loop.
    - 2 scope-discipline cards (`forbidden_paths` asserting no harness files / no out-of-scope edits in the final tree).
    - 2 chain cards (two tasks with a dependency; assert both COMPLETE and integration happened in order).
    - 1 deliberately-impossible card (`expect.status: "BLOCKED"` — asserts the system escalates instead of hallucinating success).
    - Add at least 3 high-risk-domain cards before Step 3.5: one healthcare/PII workflow, one finance/payment workflow, and one security-sensitive auth/secret workflow. Expected behavior may be `BLOCKED` when the task lacks explicit safety/privacy/compliance requirements; success requires stronger evidence and no expansion beyond approved behavior.
  - [ ] 🟥 `scripts/run-evals.ts` (`npm run evals`): for each card — create a local bare repo + working clone from `fixture.files` under a temp root, point `TASKGRAPH_WORKTREE_ROOT` at an isolated temp dir, seed a task via the existing seed path (reuse `scripts/smoke-seed-planning.ts` logic as a library or duplicate minimally), drive it with the `pipeline:run` loop logic, then evaluate `expect`. Collect per-card: outcome, first-attempt success, rework count, wall-clock, and (from `agent_runs`) run counts. **Eval tasks use ids `T-9xx` and are cleaned up after each run (`reseed:hygiene` equivalent + task row delete) — they must never pollute real task history.**
  - [ ] 🟥 Output: `evals/results/<ISO-date>.json` + a one-screen markdown summary (pass/fail table + aggregate first-attempt rate). Append a summary line to `evals/HISTORY.md` (date, git sha, pass rate, notes column for what changed) — this file is the capability trend.
  - [ ] 🟥 Split the battery into three pools and enforce the split in the runner (`pool` field on each card): **dev** (used freely for prompt/policy tuning), **holdout** (SEALED — never referenced while tuning; run only at step boundaries; if a holdout card's content ever informs a prompt change, move it to dev and write a replacement), and **full-cycle** (broken setup, missing commands, dependency install failures, integration conflicts — the lifecycle failures that killed early dogfoods, not just isolated diffs). Initial sizes: 6 dev / 4 holdout / 4 full-cycle, growing over time.
  - [ ] 🟥 Baseline run: execute the battery TWICE (variance check) before any Step 4+ change lands; commit results. Every subsequent step in this plan re-runs the battery and records the delta in HISTORY.md — dev and holdout reported as SEPARATE columns.
  - [ ] 🟥 Guardrail: evals hit real model APIs — document approximate cost per battery run in `evals/README.md`; add `--cards <id,id>` filter flag for cheap targeted runs.

- [ ] 🟥 **Step 3.5: Verification 2.0 — the gate itself becomes the differentiator**
  > Rationale: everything in this system terminates in the verifier; its false-PASS rate ships defects, its false-FAIL rate burns rework cycles, and its routing decides every loop. Today it is one cheap-model, one-shot, non-agentic read of a diff, judging evidence the generator produced about itself. This step makes it independent, agentic, ensemble-checked, and measured.

  - [ ] 🟥 **3.5a Independent re-execution (trust but verify).** New node in `src/cells/verification/workflow.ts` BEFORE `runModelReview`: `reexecuteEvidence` — create a disposable checkout of the task branch (`git worktree add <TASKGRAPH_WORKTREE_ROOT>/verify/<taskId> taskgraph/<taskid>` from the shared clone; reuse the repo-lock from Step 5b), `npm ci --prefer-offline || npm install` (mirror `installDependencies` logic), re-run the resolved test commands (`resolveTestCommandsFromPacket` on the latest packet), and compare pass/fail per command with the engineering-reported `ciOutput`. Results land in a new state channel `reexecution: { ran: boolean; passed: boolean; mismatch: boolean; report: string }`.
    - Mismatch (engineering said pass, re-run fails) → add blocking defect `"Evidence mismatch: engineering-reported test results could not be reproduced"` and force `failure_owner: "implementation"`. This closes the fabricated/stale-evidence hole — currently the verifier trusts the generator's own transcript.
    - Always remove the worktree in a `finally`. Gate with `TASKGRAPH_VERIFY_REEXECUTE=true` (default true in `.env`; document cost: one dependency install + test run per verification).
    - The re-execution report is appended to the verifier prompt AND stored as an evidence record (`type: "ci_run"`, source `verification-reexecution`) so `computeEffectiveMissingEvidence` counts independent evidence, not just generator evidence.
  - [ ] 🟥 **3.5b Agentic audit (the verifier gets tools).** Today generation is agentic (Claude Code explores, runs, iterates) while verification is a static read — backwards. New module `src/cells/verification/agentic-audit.ts`: `runAgenticAudit(worktreePath, contract, requirements, card): Promise<{ verdictJson: string } | { error: string }>` — invoke the SAME Claude Code CLI (`CLAUDE_CODE_COMMAND`, reuse the pipe-via-file pattern from `invokeClaudeCode`) inside the 3.5a disposable worktree with an auditor prompt:
    ```
    You are an independent code auditor. You did NOT write this code. Inspect the
    repository, read any file, run read-only commands (tests, greps, node scripts)
    to check each acceptance criterion empirically. Do not modify files; any
    modification invalidates the audit. Output ONLY the JSON verdict object:
    {"criterion_verdicts":{...},"blocking_defects":[],"regression_risks":[],"failure_owner":...,"failed_ac_ids":[...],"failure_summary":"...","recommended_next_step":"...","question_for_user":"..."}
    ```
    plus the contract, binding requirements, repo card, verification policy (3.5f), and judging rules (same blocks as `runModelReview`). Parse with the existing `parseReviewJson`. Gate: `TASKGRAPH_AGENTIC_VERIFIER=true`; timeout `TASKGRAPH_AUDIT_TIMEOUT_MS` default 600000.
    - **FAIL CLOSED — no anomaly may drift toward COMPLETE.** Auditor timeout, dirty worktree (`git status --porcelain` non-empty), malformed/unparseable verdict, or a 3.5a re-execution that could not run → the audit result is `INCONCLUSIVE for all criteria, failure_owner "unknown"`, which routes to BLOCKED + human escalation via the existing paths. Never fall back to the one-shot review as the verdict of record when the audit was attempted and invalidated — a compromised audit run is evidence of a problem, not an excuse to use a weaker judge.
    - **Enforce read-only with harness permissions, not prompts:** invoke the auditor with Claude Code's tool permissioning so edit tools are structurally unavailable — e.g. `--disallowedTools "Write,Edit,NotebookEdit"` (verify the exact flag against the installed CLI version's `--help`; a `.claude/settings.json` written into the audit worktree with a deny-list works too). The dirty-check stays as defense-in-depth, but "read-only" must be a configuration property, not a request.
    - **Deliver knowledge via a managed `CLAUDE.md` block — never overwrite the repo's own.** Before invoking the auditor (and the engineering worker — same change in `writeWorktreeSupportFiles`), write the repo card + verification policy + binding requirements into the worktree's `CLAUDE.md` inside idempotent markers (`<!-- taskgraph:begin -->` … `<!-- taskgraph:end -->`): replace the block if present, append after existing content otherwise. The repository's own instructions remain authoritative — the block's first line states "where these conflict with the repository's own instructions above, the repository's instructions win." If the repo tracks `CLAUDE.md` in git, do NOT add it to exclusions; instead ensure the commit guard strips the managed block before staging (extend `scrubHarnessLinesFromGitignore`-style handling). If untracked, add to `.git/info/exclude` as usual.
    - **Isolation (staged honestly):** v3 interim = disposable worktree, no `.env` in the tree, permission-enforced read-only tools (above), hard timeout, process-tree kill, dirty-check invalidation. This is NOT a sandbox — the auditor process still has network and user-level access. Record this as an accepted risk in `system-knowledge/decisions/` (one paragraph, numbered decision doc). Full containment (read-only mount, deny-by-default network, CPU/mem limits, ephemeral services) is REQUIRED work in the cloud-worker milestone — the same containerization serves both; do not build a Windows-host-only sandbox twice.
  - [ ] 🟥 **3.5c Shadow ensemble (disagreement logger, NOT a gating layer).** When the agentic audit (3.5b) runs and is valid, it IS the verdict of record — it saw strictly more evidence. The one-shot review runs in shadow mode (cheap, capped) purely to log per-criterion disagreement into the `model_review` artifact (`{ audit, oneshot_shadow, disagreements }`) as calibration telemetry. Rationale: same-family model verdicts are correlated, so a mandatory conservative merge adds false blocks without independent signal — fresh evidence (3.5a) and separate execution are the real independence. Promote the ensemble to a gating layer ONLY if 3.5d/7b data shows shadow disagreements catching real missed defects. (Fail-closed rules from 3.5b are unaffected: an invalid audit is INCONCLUSIVE, never replaced by the shadow verdict.)
  - [ ] 🟥 **3.5d Verifier calibration cards (measure the gate, not just the pipeline).** Extend the Step 3 eval schema with `seeded: { defect_description } | { known_good: true }` cards that bypass engineering: the fixture contains a PRE-BUILT branch diff (fixture files for base + task branch), and the eval runs ONLY verification against it. Initial battery of 8 in the DEV pool: seeded off-by-one with green-looking tests; unimplemented AC with plausible diff; scope violation (out-of-scope file modified); tampered evidence (ciOutput claims pass, tests actually fail — validates 3.5a); committed secret; harness-file pollution; and 2 known-good diffs. Plus 4 more in the SEALED HOLDOUT pool (same classes, different content, authored once and never inspected during tuning). Report **verifier recall** and **precision** for dev and holdout separately in `evals/HISTORY.md`.
    - **Gate semantics:** 8/8-class coverage passing on dev is a SMOKE TEST — it proves the machinery works, not that the gate is reliable. The `SCHEDULER_WORKERS=2` gate (Step 5) is: holdout recall with zero holdout leakage into tuning, plus zero fail-open incidents in the log. Small-n means the number is a floor indicator, not a false-pass rate estimate — treat it accordingly and grow the holdout pool over time.
  - [ ] 🟥 **3.5f Versioned verification policy per repo (normative, separate from the card).** The repo card is descriptive history; blocking criteria must come from a versioned, explicit policy. New file per repo: `system-knowledge/repos/${owner}__${name}-policy.md` with YAML frontmatter `policy_version: N`, sections: **Blockers** (what always blocks: failing required commands, out-of-scope writes, new deps unless requirements allow, secrets), **Mandatory checks by path/risk class** (e.g. `server.*` → runtime probe required), **Excluded from review** (lockfiles, generated files), **Evidence requirements** (what a finding must cite), **Pre-existing vs introduced** (only defects introduced by this task's diff may block; pre-existing issues are recorded as `regression_risks`, never blockers). Loader `readVerificationPolicy(repoFullName)` in `src/core/repo-card.ts` (shared path helper); injected into one-shot + agentic verifier prompts and used to configure the 3.5e mechanical rungs. Seed a default template applied when no per-repo policy exists. `policy_version` participates in evidence invalidation (Step 5a).
    - High-risk policy overlay: when `classifyRiskDomain` returns `high_risk`, require explicit product-owner decisions for data handling, audit/logging, permissions, rollback, and prohibited behavior. Missing decisions route to `human_decision`/`BLOCKED`; do not let the planner invent compliance posture. Verification must treat uncited safety, privacy, auth, payment, medical/legal/financial advice, or eligibility/decisioning changes as blockers until supported by evidence and explicit requirements.
  - [ ] 🟥 **3.5g Evidence-cited blocking findings (no vague blocks).** Extend the verifier JSON contract: `blocking_defects` becomes an array of `{ ac_id, location, evidence, introduced_by_task: boolean, confidence: "high"|"medium"|"low", summary }` where `location` is file:line or diff-hunk reference and `evidence` names the command/test/runtime output or diff content supporting the claim. Update `parseReviewJson` + normalizers (accept legacy string[] during transition, mapping to `{ summary }`-only entries flagged `uncited: true`); update both verifier prompts: `A blocking defect without a location and evidence citation will be treated as a regression_risk, not a blocker.` Enforce exactly that in `deriveTaskVerdict` input assembly: uncited defects demote to regression_risks. Store the structured findings in `verification_records` (new jsonb column — migration 010, `blocking_findings jsonb not null default '[]'`). This makes false positives auditable and feeds Step 7's labeling.
  - [ ] 🟥 **3.5e Mechanical ladder ordering (fail fast, cheap first).** Make the verification order explicit and documented in `system-knowledge/concepts/evidence-and-verification.md`: (1) mechanical checks — scope-diff partition, harness-file pollution scan (`.taskgraph*`, `tasks/*/evidence/` in diff → instant defect, no LLM needed; add this as a pure function + node before `runModelReview`), (2) independent re-execution (3.5a), (3) LLM/agentic judgment (3.5b/c), (4) runtime checks (Step 6). Each rung that fails skips the more expensive rungs above it and routes immediately.

- [ ] 🟥 **Step 4: Inner iteration loop in engineering — EVAL-GATED, default off**
  > Gate: Claude Code already runs a native test-and-fix loop inside its session when told the test commands. Build this outer re-invocation loop ONLY if baseline evals (Step 3) show a material share of rework cycles caused by post-exit test failures (i.e. the worker exits green-believing but `runTests` fails). Our live history so far (T-011/T-012) shows rework driven by verifier findings, not test failures — so measure first. Ship with `TASKGRAPH_INNER_LOOP_ATTEMPTS=0` regardless; enable per eval evidence.
  - [ ] 🟥 `src/cells/engineering/workflow.ts`: add state channels `innerAttempts: number` (default 0) and keep `testResults`. After `runTests` fails, instead of routing straight to `handleError`, route to a NEW node `fixFromTestFailures` when `innerAttempts < TASKGRAPH_INNER_LOOP_ATTEMPTS` (env, default 2):
    - Node builds a focused prompt: the same authorization header + `The previous implementation attempt has failing tests. Fix ONLY what the failures indicate; do not expand scope.` + last `ciOutput` (tail-truncated 8k) + the implementation plan, writes it to the plan file, re-invokes Claude Code in the SAME worktree (reuse `invokeClaudeCode`'s shell path — extract its core into a helper both nodes call), increments `innerAttempts`, then edges back to `runTests`.
    - Graph edges: `runTests` conditional → `fixFromTestFailures` (on test-failure error + attempts remaining) | `handleError` (attempts exhausted or non-test error) | `commitChanges` (success). Preserve existing behavior when the loop is disabled (`TASKGRAPH_INNER_LOOP_ATTEMPTS=0`).
  - [ ] 🟥 Record an artifact per inner attempt (`inner_fix_attempt`, with attempt number + failure tail) so eval metrics can count them.
  - [ ] 🟥 `.env.example`: document `TASKGRAPH_INNER_LOOP_ATTEMPTS` and the tradeoff (each attempt costs a Claude Code invocation but is ~10× cheaper than a full rework cycle with re-verification).
  - [ ] 🟥 Re-run evals; expect rework counts to drop on the happy-path + scope cards. Record delta.

- [ ] 🟥 **Step 4.5: Risk-routed planning and adversarial contract formation — EVAL-GATED**
  > Principle: model collaboration is valuable when roles are asymmetric. Typical product work should receive an independent challenge before implementation. Only genuinely mechanical work bypasses that challenge.

  ### Planning lanes

  - [ ] 🟥 **Fast lane, exception only:** documentation, copy, isolated test changes, or explicitly located low-risk fixes.
    - Flow: one contract draft → deterministic executability validation → execution.
    - Fast lane is permitted only when repo policy allows it.
    - A model may escalate out of fast lane, never downgrade into it.

  - [ ] 🟥 **Standard lane, default for normal product and engineering work:**
    - Flow: **Proposer → adversarial critic → adjudicator → final contract**.
    - This replaces generic Plan A / Plan B / cross-review for ordinary work.

  - [ ] 🟥 **Deliberative lane:** high-risk policy tier, multiple viable architecture options, cross-service changes, migrations, concurrency, security, or unresolved product decisions.
    - Flow: two independent proposals → adversarial review of each proposal and their assumptions → adjudicator → human approval where decisions remain unresolved.

  ### Role definitions

  - [ ] 🟥 **Contract proposer**
    - Produces a draft contract: goal, scope in/out, acceptance criteria, required evidence, verification commands, rollback requirements, assumptions, and open decisions.
    - Does not decide unresolved product or compliance posture.

  - [ ] 🟥 **Adversarial critic**
    - Does not write an alternative implementation plan.
    - Attacks the draft for missing acceptance criteria, scope leaks, contradictory requirements, policy conflicts, unsafe assumptions, migration/deployment hazards, missing rollback, and simpler safer alternatives.
    - Returns structured findings: `{ concern_id, severity, evidence, required_change, requires_human_decision }`.

  - [ ] 🟥 **Contract adjudicator**
    - Produces the only contract engineering may execute.
    - Resolves every critic finding with `{ accepted | rejected | unresolved, rationale, contract_change }`.
    - Any unresolved high-risk or product decision routes to `HUMAN_DECISION_REQUIRED`, never to implementation.

  ### Artifacts and inputs

  - [ ] 🟥 Persist:
    - `contract_draft`
    - `adversarial_review`
    - `contract_adjudication`
    - `adjudicated_contract`
  - [ ] 🟥 Engineering receives only `adjudicated_contract`.
  - [ ] 🟥 Verification receives the final contract plus the adjudication log, so it can test the risks that were explicitly raised and accepted.

  ### Model routing

  - [ ] 🟥 Add roles:
    - `MODEL_CONTRACT_PROPOSER`
    - `MODEL_CONTRACT_CRITIC`
    - `MODEL_CONTRACT_ADJUDICATOR`
  - [ ] 🟥 Keep current environment variables as backwards-compatible aliases during migration.
  - [ ] 🟥 The critic should use a different model family from the proposer where practical, because diversity of failure modes matters more than three identical calls.

  ### Routing rule

  - [ ] 🟥 Determine effective planning mode as:

    ```text
    max(repo policy minimum mode, deterministic change triggers, model escalation)
    ```

  - [ ] 🟥 The model may escalate from fast → standard → deliberative. It may never reduce the policy-required mode.

  ### Eval additions

  - [ ] 🟥 Add `expect.planning_mode` and `expect.human_decision_required` to evaluation cards.
  - [ ] 🟥 Seed planning-specific cards:
    - a normal feature where the critic must catch omitted scope or verification criteria
    - conflicting requirements that must be resolved in adjudication rather than engineering rework
    - a high-risk task missing an explicit privacy, permissions, or rollback decision that must block for human input
  - [ ] 🟥 Measure downstream completion rate, rework rate, false blocks, wall-clock cost, and cost per successful task separately for fast, standard, and deliberative lanes.

  ### Cross-references

  - Step 2 risk tier and policy floor determine the minimum planning lane.
  - Step 3 measures whether each lane earns its cost.
  - Step 3.5 verifier consumes the adjudication log.
  - Step 7 injects promoted lessons into the critic and adjudicator, not only the contract draft.

- [ ] 🟥 **Step 5: Two workers + safe merge queue**
  - [ ] 🟥 5a — Integration push-retry + **candidate verification** (the merge queue): in `integrateCompletedTaskBranch`, wrap the final `git push` in a retry loop (×3): on non-fast-forward rejection, `git fetch`, re-create the integration worktree from the NEW `origin/<default>`, re-merge. **What gets verified is the candidate merge commit, not the task branch head** — the thing that lands must be the thing that was checked:
    - Record `base_sha` (origin/<default> at merge time) and `candidate_sha` (the merge commit) in the integration artifact.
    - Before EVERY push (first attempt and retries): run the cheap verification rungs against the candidate in the integration worktree — 3.5e mechanical checks + 3.5a re-execution (test commands). Green → push.
    - If the re-merge required conflict resolution, or `git diff <task-branch> <candidate> -- .` shows the candidate differs from the verified branch content beyond the merge commit itself → escalate to a full re-verification of the candidate (enqueue verification with the candidate diff) instead of pushing; the task already being COMPLETE is fine — integration simply waits for the candidate verdict.
    - **Evidence invalidation rule** (document in `system-knowledge/concepts/evidence-and-verification.md`): a verification verdict is valid only for the tuple `(base_sha, candidate_sha, contract_version, policy_version)`. Any element changes → prior evidence does not authorize integration.
  - [ ] 🟥 5b — Shared-clone race: `resolveRepoRoot` (engineering) and `ensureRepoCheckout` (scanner) both fetch/reset the same clone. Add a simple mutex: `src/core/repo-lock.ts` with an in-process `Map<repoFullName, Promise>` chain — sufficient because both workers live in ONE scheduler process (workers are concurrent promises, not processes). Wrap the fetch/reset sections of both call sites.
  - [ ] 🟥 5b-bis — **Minimal dynamic check before scaling** (pulled forward from Step 6): implement the core of `runRuntimeChecks` early in minimal form — when a task's diff touches a service entrypoint (heuristic: `package.json` has a `start` script AND the diff modifies the file it points at or `server.*`/`app.*`), the verification ladder runs a default "starts and responds" probe (spawn `npm start`, wait, GET `/` expecting any non-5xx, kill tree) even without contract `runtime_checks`. Static review alone misses functional breakage, and parallel throughput multiplies whatever the gate misses — this rung is a Step-5 prerequisite, not a Step-6 luxury.
  - [ ] 🟥 Set `SCHEDULER_WORKERS=2` in `.env` ONLY after: holdout calibration gate (3.5d) passed + 5a candidate verification landed + 5b-bis running. Update the v1-constraint note in `OPERATIONS.md` and `plans/production-readiness.md` (workers=2 is now sanctioned; >2 still out of scope).
  - [ ] 🟥 Eval: add 1 card with two INDEPENDENT tasks (no dependency) and assert both COMPLETE and both integrated; run the battery, watch specifically for integration races and worktree collisions.
  - [ ] 🟥 5c — Best-of-2 design sketch ONLY (no implementation): write `plans/best-of-n-design.md` (≤1 page): candidate branches `taskgraph/t-nnn-a/-b`, parallel engineering runs, verification scores both, higher score integrates, loser branch deleted; open questions: scoring function, cost gate (only for tasks that failed once?), evidence semantics. Mark as "pending eval data from Steps 3–5".

- [ ] 🟥 **Step 6: Runtime verification v1 (GATED: soak must have formally passed)**
  - [ ] 🟥 Extend the contract schema (`src/core/schemas.ts`) with optional `runtime_checks?: Array<{ start: string; wait_ms?: number; probes: Array<{ method: "GET"|"POST"; path: string; body?: string; expect_status: number; expect_body_contains?: string }> }>` — optional, so existing contracts are unaffected. Teach the contract-draft prompt: `When the deliverable is a service or app, include runtime_checks that start it and probe real behavior.`
  - [ ] 🟥 New module `src/core/runtime-check.ts`: `runRuntimeChecks(worktreePath, checks): Promise<{ ok: boolean; report: string }>` — spawn `start` command in the worktree (detached, captured output), wait `wait_ms` (default 3000), execute probes against `http://localhost:<PORT from env or 3000+offset>`, ALWAYS kill the process tree afterward (`taskkill /pid /T /F` on win32; guard cross-platform), return a per-probe report.
  - [ ] 🟥 Engineering: after `runTests` succeeds and contract has `runtime_checks`, run them; failures feed the Step 4 inner loop exactly like test failures. Attach the report to the evidence package (new evidence type `runtime_check`, status pass/fail).
  - [ ] 🟥 Verification: when `runtime_checks` exist, the verifier's user message includes the runtime report; judging rules updated (knowledge doc + prompt): a failing runtime check is `implementation` failure regardless of diff plausibility.
  - [ ] 🟥 Playwright stub: define the interface (`BrowserCheck` type + a `runBrowserChecks` that throws "not implemented") so the schema slot exists; do NOT add the dependency.
  - [ ] 🟥 Eval: add a card whose fixture is a tiny HTTP server task with `runtime_checks`; assert the pipeline catches a deliberately-broken endpoint (regression card) and passes a working one.

- [ ] 🟥 **Step 6.5: Deployment verification (policy-conditional — the clearest long-term edge over IDE harnesses)**
  > Scope guard: TaskGraph's current repos have no deployment infrastructure, and auto-deploy is out of v1 scope. But merge-on-COMPLETE (v2 Step 1) means any repo with deploy-on-push (e.g. Vercel/Railway watching the default branch) gets deployed by our integration WITHOUT any post-deploy check — integration could break production silently. This step closes that, activated per repo by policy, never speculatively.
  - [ ] 🟥 Extend the 3.5f policy schema with an optional `deployment:` section — `{ provider: "vercel" | "railway" | "custom", health_url, deploy_timeout_ms, key_flow?: [{ method, path, expect_status, expect_body_contains }], migration_check?: "supabase", heartbeat_check?: { description, max_age_ms } }`.
  - [ ] 🟥 New module `src/core/deploy-verification.ts`: after a successful integration push on a repo whose policy declares `deployment`, poll until the deployed environment reflects `candidate_sha` (provider APIs expose deployment→sha mapping via `VERCEL_TOKEN`/`RAILWAY_TOKEN` env; `custom` = poll `health_url` for a `X-Commit-Sha`/body sha marker), then assert `health_url` + `key_flow` probes against the DEPLOYED environment, confirm migration state when `migration_check` is set, and check worker/cron heartbeat freshness when declared.
  - [ ] 🟥 Evidence + rollback: record a `deployment_verification` evidence record `{ candidate_sha, deployment_id, probes, rollback_target }` where `rollback_target` = the previously verified deployment id/sha. Failure → `integration_conflict`-style Telegram notification naming the rollback target + a `verdict_label`-compatible `missed_defect` candidate (the gate passed something production rejects — prime 7b material). v3 does NOT auto-rollback; it hands the human a loaded, specific runbook line.
  - [ ] 🟥 Eval: one full-cycle card with a fixture "deployment" simulated by a local static server serving the sha marker — assert the verifier refuses to green-light when the deployed sha never converges.

- [ ] 🟥 **Step 7: Lessons writeback (failures compound into knowledge)**
  - [ ] 🟥 New module `src/core/lessons.ts`: `recordLesson(repoFullName, taskId, trigger: "rework_escalated" | "contract_revised" | "integration_conflict", context: string)` — invoke cheap role `lessons` (env `MODEL_LESSONS`, cheap default) with: the trigger context (defects/failure summary/revision diff) + existing lessons file, prompt: `Distill ONE generalizable lesson (max 2 sentences) that would have prevented this. Merge into the list; dedupe aggressively; keep the newest 20.` Write to `system-knowledge/repos/${owner}__${name}-lessons.md`.
  - [ ] 🟥 Call sites: verification cell — rework-cap escalation branch and contract-revision branch; branch-integration conflict path.
  - [ ] 🟥 **Quarantine before injection — model-written lessons are hypotheses, not rules.** Lessons land in the file with status `candidate`. A lesson is promoted to `active` only when (a) a human labels it via `/flag`-style confirmation, or (b) the same failure pattern recurs (≥2 occurrences matched by the lessons model). ONLY `active` lessons are injected into the contract-draft prompt (`LESSONS FROM PAST FAILURES IN THIS REPO:`) and the verifier system prompt; `candidate` lessons are visible to humans in the file but never steer prompts. Prevents one bad model-written generalization from silently biasing every future contract.
  - [ ] 🟥 Tests: prompt-builder pure-function tests; file path derivation shared with repo-card (extract common helper).
  - [ ] 🟥 **7b Delayed ground truth — label the verdicts reality disagrees with.** The gate's only true labels are the defects that escape it and the blocks humans overturn; capture both:
    - **Reversion watcher**: extend the watchdog with a cheap per-cycle check — for repos with integrations in the last 14 days, `git log origin/<default> --grep="Revert"` (and merge-commit parent checks) against recorded `candidate_sha`s; a reverted integration writes a `verdict_label` artifact `{ verification_record_id, label: "missed_defect", source: "reversion" }` + Telegram notification.
    - **Human labels via Telegram**: new command `/flag T-NNN missed-defect|false-block <note>` (wire like `/answer` in `src/intake/telegram.ts` → helper in `conversation.ts`) writing `verdict_label` artifacts `{ label, note, source: "human" }` linked to the latest verification record for the task.
    - Labels feed two places: `evals/HISTORY.md` gains a "field labels" column (running counts of missed_defect / false_block — the gate's real-world confusion matrix accumulating over time), and each label triggers `recordLesson` (7a) with the original verdict + what reality showed.
  - [ ] 🟥 Final battery run; update `evals/HISTORY.md`; write a capability summary section into `STATUS.md` ("Capability v3: eval pass rate X% → Y% across steps; verifier holdout recall/precision; field labels to date").
