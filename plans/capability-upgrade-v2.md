# Capability Upgrade v2 — Work Integration, Binding Requirements, Project-Aware Comms

**Overall Progress:** `0%`

> **Executor notes (read first):** This plan is written for step-by-step execution by an agent.
> - Run `npm run typecheck && npm test` after EVERY step; all tests must stay green (baseline: 100+ passing).
> - `src/cells/planning/workflow.ts` has blank lines between most statements — copy Edit anchor strings exactly from a fresh Read.
> - After code steps are done, deploy with `pm2 restart taskgraph-scheduler taskgraph-intake --update-env` then `pm2 save`. The watchdog does not need restarting unless `scripts/watchdog.ts` changes.
> - `.env` line 1 has a UTF-8 BOM (see Step 0). Never parse `.env` with line-anchored grep until fixed.
> - No new Supabase migrations are required by this plan.

## TLDR

The T-011/T-012 chain proved the pipeline can build, self-repair contracts, and hand off dependencies — but exposed three capability gaps this plan closes:

1. **Completed work is never integrated.** Task branches (`taskgraph/t-NNN`) live only in the local clone; `origin/HEAD` never advances. Every new task and every repo scan starts from a base without prior work — iterative development ("add a feature to the app we built") is structurally impossible. T-012 had to re-implement T-011's backend because it couldn't see it.
2. **Requirements are not binding on planning or verification.** The intake conversation recorded "Dependencies like Express are allowed"; planning still drafted a "no new dependencies" AC, and the verifier — which never sees intake requirements — burned 3 rework attempts classifying the resulting conflict as an `implementation` failure before escalating.
3. **The comms agent has no project awareness.** Its repo snapshot reflects `origin/HEAD` (no app, per gap 1), its `notes` memory predates the notes feature, and nothing tells it what tasks exist. Asking it to "add features" to a project it just built draws a blank.

## Critical Decisions

- **Integration = merge-to-default-branch on COMPLETE, gated by `TASKGRAPH_AUTO_INTEGRATE=true`.** Not PR-based (no tunnel/review loop in v1); a direct merge + push using the existing `GITHUB_TOKEN`. Conflicts do NOT fail the task (it is already COMPLETE) — they emit an `integration_conflict` notification for a human.
- **Integration runs BEFORE `wakeDependentTasks`** in the verification COMPLETE branch, so a woken dependent's `resolveRepoRoot` fetch/reset picks up the merged base.
- **Requirements flow as text, not schema.** `source_context.requirements_summary` (already stored on every conversation-created task) is injected into the contract-draft prompt, both review prompts, and the verifier prompt as a clearly-labeled BINDING block. No DB changes.
- **Comms agent learns the project from the tasks table**, not from notes — the DB is the source of truth for what exists; notes remain for decisions/preferences only.

## Defect → Step map

| Defect observed E2E | Step |
|---|---|
| Task branches never merged; new work builds on stale base; T-012 re-implemented backend | 1 |
| Contract contradicted recorded requirements ("no new deps" vs "Express allowed") | 2 |
| Verifier misclassified contract-vs-requirements conflict as `implementation` (3 wasted rework cycles) | 2 |
| Comms agent unaware of existing project/tasks | 3 |
| T-011 + T-012 branches both unmerged with overlapping changes (one-time cleanup) | 4 |
| `.env` BOM breaks line-anchored parsing | 0 |

## Tasks:

- [ ] 🟥 **Step 0: Preflight**
  - [ ] 🟥 Strip the UTF-8 BOM from `.env`: read the file bytes, remove leading `EF BB BF`, write back (PowerShell: `$c = Get-Content .env -Raw; [IO.File]::WriteAllText("$PWD\.env", $c.TrimStart([char]0xFEFF), (New-Object Text.UTF8Encoding $false))`). Verify with `Format-Hex .env | Select-Object -First 1` (must start `53 55 50` = "SUP").
  - [ ] 🟥 Baseline: `npm run typecheck && npm test` green; `pm2 status` all online. Record test count.

- [ ] 🟥 **Step 1: Merge-on-COMPLETE (work integration)**
  - [ ] 🟥 Create `src/core/branch-integration.ts` exporting `integrateCompletedTaskBranch(taskId: string): Promise<{ ok: boolean; detail: string; merged?: boolean }>`:
    - Resolve the shared clone exactly like `resolveRepoRoot` in `src/cells/engineering/workflow.ts` does: `getTaskRepo(taskId)` → if no `repoFullName`, return `{ ok: true, merged: false, detail: "no external repo" }`; if repo matches local cwd remote, use `process.cwd()`; else `path.join(TASKGRAPH_WORKTREE_ROOT ?? tmpdir()/taskgraph-os, "repos", owner, name)`. If that dir has no `.git`, return ok:false with detail (nothing to integrate — engineering never ran here).
    - Branch name: `taskgraph/${taskId.toLowerCase()}`. If `git rev-parse --verify` fails for it in the clone, return ok:false "task branch not found".
    - Determine default branch: `git remote set-head origin -a` then `git symbolic-ref refs/remotes/origin/HEAD` → strip `refs/remotes/origin/` prefix (fallback `"main"`). If the remote is empty (no HEAD), push the task branch AS the default: `git push origin taskgraph/t-nnn:main` and return.
    - Integrate WITHOUT touching the shared clone's checked-out branch (worktrees may be active): create a temp integration worktree — `git worktree add <TASKGRAPH_WORKTREE_ROOT>/integration/<taskId> origin/<default>` → in it `git merge --no-ff taskgraph/t-nnn -m "integrate(T-NNN): merge completed task branch"` → on success `git push origin HEAD:<default>` → always `git worktree remove --force` the temp dir (also on failure paths) + `git worktree prune`.
    - On merge conflict: `git merge --abort`, clean up worktree, return `{ ok: false, detail: "merge conflict: <stderr head>" }`.
    - Use `runCommand` from `src/core/command.js` for every git call (matches repo convention; no shell strings).
  - [ ] 🟥 Gate on env: at the top of the function, if `process.env.TASKGRAPH_AUTO_INTEGRATE !== "true"`, return `{ ok: true, merged: false, detail: "auto-integrate disabled" }`.
  - [ ] 🟥 Call site — `src/cells/verification/workflow.ts`, in `publishVerificationRecord`, inside the `if (effectiveVerdict === "COMPLETE" && transitioned)` block, AFTER the `task_complete` notification and BEFORE `await wakeDependentTasks(...)`:
    ```ts
    const integration = await integrateCompletedTaskBranch(state.taskId).catch(
      (err) => ({ ok: false, merged: false, detail: err instanceof Error ? err.message : String(err) }),
    );
    if (integration.merged) {
      await recordArtifact({ taskId: state.taskId, artifactType: "human_notification", content: {
        type: "work_integrated", task_id: state.taskId,
        message: `${state.taskId}'s changes were merged into the default branch.`,
        notified_at: new Date().toISOString(),
      }});
    } else if (!integration.ok) {
      await recordArtifact({ taskId: state.taskId, artifactType: "human_notification", content: {
        type: "integration_conflict", task_id: state.taskId,
        message: `${state.taskId} is COMPLETE but could not be merged automatically: ${integration.detail}. Merge branch taskgraph/${state.taskId.toLowerCase()} manually.`,
        notified_at: new Date().toISOString(),
      }});
    }
    ```
  - [ ] 🟥 `src/intake/notifications.ts` — add `formatNotification` cases: `work_integrated` (prefix `📦`) and `integration_conflict` (prefix `⚠️`, include the message). Follow existing case style.
  - [ ] 🟥 `.env.example` — document `TASKGRAPH_AUTO_INTEGRATE` (default false; requires push rights via `GITHUB_TOKEN`); add `TASKGRAPH_AUTO_INTEGRATE=true` to the real `.env` (append with `printf`, never rewrite the file).
  - [ ] 🟥 Tests — `tests/branch-integration.test.ts`: follow the local-fixture-repo pattern used in `tests/verification-diff.test.ts` (git init a bare "origin" + clone, commit on a task branch, run `integrateCompletedTaskBranch` with `TASKGRAPH_WORKTREE_ROOT` pointed at the fixture, assert default branch on the bare origin contains the commit; second test: conflicting commit on default → expect ok:false + branches untouched; third: env gate off → merged:false). Set/restore env vars inside the tests.
  - [ ] 🟥 Also add `formatNotification` tests for the two new cases in `tests/notifications.test.ts`.

- [ ] 🟥 **Step 2: Requirements as binding constraints**
  - [ ] 🟥 New helper in `src/db/records.ts`: `getTaskRequirementsSummary(taskId: string): Promise<string | null>` — select `source_context` from `tasks`, return `source_context.requirements_summary` if a non-empty string, else null.
  - [ ] 🟥 Planning (`src/cells/planning/workflow.ts`): in the contract-DRAFT node's system prompt and in BOTH review-node prompts, append a block (only when a summary exists — fetch it once early in the workflow and thread through state, or fetch in each node; prefer one fetch in the entry node stored on a new `requirementsSummary` state channel):
    ```
    BINDING PRODUCT DECISIONS (from the product owner's intake conversation):
    <summary text>
    The contract MUST NOT contradict these decisions. If they allow a dependency,
    the contract must not forbid it. If they prescribe an approach, acceptance
    criteria must be compatible with it. A contradiction is a contract defect.
    ```
  - [ ] 🟥 Verification (`src/cells/verification/workflow.ts`): in `runModelReview`, fetch `getTaskRequirementsSummary(state.taskId)` and, when present, insert a `Product owner requirements (binding):` section into the user message between `Scope out` and `Acceptance criteria`. Extend the system prompt's failure_owner guidance: `If an acceptance criterion conflicts with the product owner requirements, use failure_owner "contract" — do not classify it as implementation.`
  - [ ] 🟥 Update `system-knowledge/concepts/evidence-and-verification.md` "Verifier judging rules" section (it is injected into the verifier prompt via `readKnowledgeExcerpt` — keep the heading text unchanged) with the same rule, so the knowledge layer and prompt stay in sync.
  - [ ] 🟥 Tests: unit-test `getTaskRequirementsSummary` shape handling is DB-bound — instead, export and test any pure prompt-assembly helper you introduce; at minimum add a regression test in `tests/verification.test.ts` asserting `routeVerdictByFailureOwner("REWORK_REQUIRED", "contract") === "BLOCKED"` (the T-012 first-pass path).

- [ ] 🟥 **Step 3: Project-aware comms agent**
  - [ ] 🟥 `src/intake/conversation.ts` — new function `recentWorkSummary(): Promise<string>`: query `tasks` (`select id, title, status, repo_full_name`, `order id desc`, `limit 15`), format one line each: `T-012 [COMPLETE] jackye426/swarm-sandbox — Dark-Themed To-Do List Frontend`. Return "" when empty. Wrap in try/catch → "" (convenience, not requirement — match `knownRepos` style).
  - [ ] 🟥 Inject into `buildSystemPrompt` (extend `PromptContext` with `workSummary: string | null`) after the repos list:
    ```
    EXISTING AND IN-FLIGHT WORK (source of truth — the user may refer to these in plain words):
    <lines>
    When the user asks to change or extend something listed above, that project EXISTS:
    do not ask them to describe it from scratch. Completed work is merged into the repo,
    so the repo snapshot reflects it. Create NEW tasks for the change, referencing the
    existing files.
    ```
  - [ ] 🟥 Call `recentWorkSummary()` in `handleConversationMessage` alongside `knownRepos` and pass it through.
  - [ ] 🟥 Tests (`tests/conversation.test.ts`): `buildSystemPrompt` embeds a work summary when provided; omits the section when null/empty.

- [ ] 🟥 **Step 4: One-time integration of the existing to-do app (manual, after Step 1 deploys)**
  - [ ] 🟥 T-011 and T-012 branches overlap (T-012 re-added the backend). Integrate T-012's branch ONLY (it contains the full app): in the shared clone (`C:\tmp\taskgraph-os\repos\jackye426\swarm-sandbox`), merge `taskgraph/t-012` into the default branch and push (same procedure as `integrateCompletedTaskBranch`; running `npx tsx -e` against it is fine, or do it with plain git). Do NOT merge `taskgraph/t-011` afterward — discard it (documented superseded-by-T-012).
  - [ ] 🟥 Verify: fresh scan (`delete the .taskgraph-seed-scan.json cache file` or wait 10 min) → repo snapshot now shows `server.js`, `public/`, `scripts/test-api.js`.

- [ ] 🟥 **Step 5: Deploy + live E2E validation**
  - [ ] 🟥 `npm run typecheck && npm test` green; `pm2 restart taskgraph-scheduler taskgraph-intake --update-env; pm2 save`.
  - [ ] 🟥 Live test (needs the human on Telegram): message the bot *"add a clear-completed button to the to-do app"* and verify: (a) the agent recognizes the app exists (references real files, does not re-interview from scratch); (b) the contract draft does not contradict recorded requirements; (c) engineering builds on a base that already contains the app; (d) on COMPLETE, a `work_integrated` notification arrives and `origin/HEAD` contains the cumulative app.
  - [ ] 🟥 Record outcomes (task id, timings, any defect) in `system-knowledge/operations/soak-2026-07.md` under a "Capability upgrade v2 validation" heading.
