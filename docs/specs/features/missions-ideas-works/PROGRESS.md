# Missions → Ideas → Works — Build PROGRESS Tracker

**Branch:** `feat/missions-ideas-works`
**Worktree:** `C:/Coding/Worktrees/wt-missions-build`
**Loop:** autonomous self-paced `/loop` with 30-min ticks. See [Per-tick procedure](#per-tick-procedure) below.
**Started:** 2026-05-24
**Spec:** [Workspace v6 spec](https://github.com/ever-works/workspace/blob/develop/knowledge/notes/2026-05-24-missions-ideas-works-spec.md) · [PLAN v6](https://github.com/ever-works/workspace/blob/develop/knowledge/notes/2026-05-24-missions-ideas-works-plan.md)

---

## Current focus

**Tick 2 (DONE):** PR 0.2 — created `Mission` entity + `CreateMissionsTable` migration (table + index + `users` FK + deferred FK on `work_proposals.missionId`). Registered in `database.config.ts` ENTITIES + `_entity-names.ts` drift list. Type-check + database-config drift spec + database-module drift spec + work-proposal integration spec all green (82 tests total).
**Next:** PR 0.3 — `ExtendBudgetsToPolymorphicOwner` migration. Add `ownerType` + `ownerId` columns to `work_budgets`, `usage_ledger_entries`, `plugin_usage_events`, `work_budget_alert_states`; backfill `ownerType='work', ownerId=workId` for existing rows; composite index `(ownerType, ownerId)`. Existing `workId` columns stay (back-compat per Decision A3 of v6 plan).

---

## Per-tick procedure (canonical — copy into the loop prompt verbatim)

1. `cd C:/Coding/Worktrees/wt-missions-build`.
2. Confirm branch is `feat/missions-ideas-works`. Pull from origin in case a prior tick pushed.
3. **Read this PROGRESS.md.** Find the topmost item in the table below marked `TODO` whose dependencies are all `DONE`.
4. **Read the corresponding PLAN phase + the §B pre-flight checklist for it.** Then read every file the pre-flight tells you to read.
5. Do one PR-equivalent unit of work. Aim for committable progress within this tick. If a PR is too big, slice it (capture the slice in this tracker as sub-rows e.g. `A.1`, `A.2`).
6. **Run targeted checks** for what you changed (NOT the full suite — too slow):
   - `pnpm lint --filter <affected-package>` (or `cd packages/<x> && pnpm lint`)
   - `pnpm type-check --filter <affected-package>`
   - Targeted test: `cd <pkg-or-app> && npx jest -t '<pattern>'` or `npx vitest run <file>`
7. Update the PR row below: change status `TODO` → `DONE` (or `IN PROGRESS` if sliced; or `WIP` if commit lands broken with a clear next-tick plan; or `BLOCKED` if human input needed). Add a one-line summary. Leave commit hash placeholder `<hash>`.
8. Commit using conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:` — enforced by commitlint). After commit, replace `<hash>` with the real short hash in this file (small follow-up amend or a second commit is fine).
9. `git push origin feat/missions-ideas-works`.
10. `ScheduleWakeup(delaySeconds=1800, prompt=<the loop's orchestration prompt verbatim>)`.

### Hard constraints

- **Workspace NN #20**: extension only, never replacement.
- **Platform CLAUDE.md NN #16**: any TypeORM entity change ships with its migration in the SAME commit.
- **Commitlint**: conventional commits only.
- **No push to develop/main.** Only `feat/missions-ideas-works`.
- **No PRs created.** Per operator instruction this build runs on one branch; final PR pass happens manually after the loop completes.
- **Stop conditions**:
  - All PRs marked `DONE` → write final summary, commit it, push, STOP (no ScheduleWakeup).
  - Real blocker requiring human input → mark `BLOCKED`, write one-sentence user message, STOP.
  - Broken build with no clear forward fix → commit as `WIP`, ScheduleWakeup so next tick attempts repair.

---

## Phase-by-phase PR checklist

Status legend: `TODO` · `IN PROGRESS` · `WIP` (committed broken, next tick continues) · `BLOCKED` · `DONE`

Dependency notation `[after X]` means PR X must be DONE before this PR starts.

### Phase 0 — Schema and migrations (additive)

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| 0.1 | DONE | `ExtendWorkProposalForMissions` migration: add `missionId uuid NULL` FK; extend `status` enum (`QUEUED`, `BUILDING`, `FAILED`); extend `source` enum (`USER_MANUAL`, `MISSION`); new index `(userId, status, missionId, generatedAt)`. Entity edits in same commit. | — | `9b3b32b4` | Entity extended (status + source enums + `missionId` column + new composite index decorator); migration `1779978000000-ExtendWorkProposalForMissions.ts` idempotent up/down. Type-check + work-proposal integration test green. FK constraint to `missions(id)` intentionally deferred to PR 0.2 when target table exists. |
| 0.2 | DONE | `CreateMissionsTable` migration: new `missions` table per spec §1.3 + Mission entity. Defer the FK constraint on `work_proposals.missionId` to here (added in 0.1 as nullable). | 0.1 | _next-commit_ | New `Mission` entity (`packages/agent/src/entities/mission.entity.ts`) with title/description/type/status/schedule/autoBuildWorks/outstandingIdeasCap/guardrailsOverride/missionTemplateRepo/missionRepo + `idx_missions_user_status (userId, status)`. Migration creates table + index + `users` FK (ON DELETE CASCADE) + attaches the deferred `fk_work_proposals_mission` FK (ON DELETE SET NULL — preserves Done-Idea history). Registered in `database.config.ts` ENTITIES array + `_entity-names.ts` drift list. Type-check + 82 tests (drift specs) green. `sourceMissionId` self-FK deferred to PR 0.10 per phased plan. |
| 0.3 | TODO | `ExtendBudgetsToPolymorphicOwner` migration: add `ownerType` + `ownerId` to `work_budgets`, `usage_ledger_entries`, `plugin_usage_events`, `work_budget_alert_states`; backfill `ownerType='work', ownerId=workId`; composite index `(ownerType, ownerId)`. | — | `<hash>` | |
| 0.4 | TODO | `PromoteWorkAgentConstantsToSettings` migration: add `auto_generate_cadence`, `auto_generate_batch_size`, `auto_build_throttle_per_day`, `mission_default_outstanding_cap` to `work_agent_preferences`. | — | `<hash>` | |
| 0.5 | TODO | `AddAutoRetryPrefs` migration: `max_auto_retries`, `backoff_seconds`, `exponential_backoff_factor` on `work_agent_preferences`. (v6 / Decision A23) | 0.4 | `<hash>` | |
| 0.6 | TODO | `AddAccountWideBudget` migration: `account_wide_monthly_cap_cents`, `account_wide_allow_overage` on `work_agent_preferences`. (v6 / Decision A28) | 0.4 | `<hash>` | |
| 0.7 | TODO | `AddIdeaIdToWorkAgentGoal` migration: add `ideaId uuid NULL` FK on `work_agent_goals` → `work_proposals`. | 0.1 | `<hash>` | |
| 0.8 | TODO | `AddIdeaFailureColumns` migration: `failure_message text NULL`, `failure_kind varchar(32) NULL` on `work_proposals`. (v6 / Decisions A23, A24) | 0.1 | `<hash>` | |
| 0.9 | TODO | `AddMissionRefsToWorkProposalAndWork` migration: `accepted_from_idea_id uuid NULL` on `works`. | 0.1 | `<hash>` | |
| 0.10 | TODO | `AddSourceMissionIdToMissions` migration: `source_mission_id uuid NULL` self-FK on `missions`. (v6 / Decision A25) | 0.2 | `<hash>` | |

### Phase 1 — Backend extensions

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| A | TODO | Extend `WorkProposal` entity + service for new statuses/sources + `missionId`. (PLAN §3.3 PR A) | 0.1 | `<hash>` | |
| B | TODO | Add `POST /me/work-proposals` (user-manual create) + `POST /me/work-proposals/:id/build` (queue for build via `WorkAgentGoal` with `maxWorksPerRun=1` + `ideaId`). Extract `acceptInternal(ideaId, workId)` from existing `accept` controller method so it can be called from both the controller AND the goal-completion handler. (PLAN §3.3 PR B; Decision A3) | A, 0.7 | `<hash>` | |
| C | TODO | Extend user-research proposal generator to accept exclusion+context list (every existing Idea title/slug/desc across ALL statuses incl. DONE) + `missionContext` parameter. (PLAN §3.3 PR C) | A | `<hash>` | |
| D | TODO | Promote four work-agent constants (cadence, batch size, throttle, mission cap) from hardcoded to user settings. (PLAN §3.3 PR D) | 0.4 | `<hash>` | |
| FF | TODO | `POST /me/work-proposals/:id/retry` + `POST /me/work-proposals/:id/rebuild` endpoints + auto-retry handler in goal-completion. Built-in transient classifier (network/429/5xx/plugin-internal). (v6 / PLAN §3.3 PR FF; Decisions A23, A24, A27) | B, 0.5, 0.8 | `<hash>` | |

### Phase 2 — Dashboard renames + stats reorder (smallest user-visible PR)

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| E | TODO | i18n renames across all 21 locales: `proposals.header.title` → "Ideas", drop `titleWithName` rendering, `proposals.actions.accept` → "Build", `proposals.actions.refresh` → "Suggest more", Dashboard "Recent Works" → "Works". (PLAN §4.3 PR E) | — | `<hash>` | |
| F | TODO | Add Total Missions + Total Ideas tiles to Dashboard stats row. New order: `[Missions][Ideas][Works][Items][Sites]`. Extend `getWorkStats()` server action. (PLAN §4.3 PR F) | — | `<hash>` | |

### Phase 3 — Missions backend + tick worker

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| G | TODO | Mission entity (already implied by 0.2's migration); `MissionsModule` skeleton. (PLAN §5.5 PR G) | 0.2 | `<hash>` | |
| H | TODO | `MissionsModule` full CRUD + lifecycle endpoints (pause/resume/complete/delete/run-now). (PLAN §5.5 PR H) | G | `<hash>` | |
| I | TODO | Shared titler service (one service, four callers: user-manual Idea, Mission-spawned Idea, Mission itself, Work title fallback). (PLAN §5.5 PR I) | — | `<hash>` | |
| J | TODO | Mission tick worker — Trigger.dev `schedules.task({id, cron, run})` per `workScheduleDispatcherTask` pattern. Honors outstanding-Ideas cap; generates Ideas via PR C generator with `missionContext`; if `autoBuildWorks` true, queues each new Idea for build via PR B. (PLAN §5.5 PR J) | H, C, I, 0.4 | `<hash>` | |
| HH | TODO | `POST /me/missions/:id/clone` + `MissionCloneService` — Full Fork: metadata + repo snapshot + Ideas as PENDING (skip DISMISSED) + `sourceMissionId` FK; Works NOT cloned. (v6 / PLAN §5.5 PR HH; Decisions A25, A26) | H, 0.10 | `<hash>` | |

### Phase 4 — Work Agent settings additive refactor

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| K | TODO | Extract `<LiveRun />`, `<LogList />`, `<StatusPill />`, `<Metric />`, `<ToggleRow />`, `<NumberField />`, `<MoneyField />` from `WorkAgentSettings.tsx` to `apps/web/src/components/work-agent/`. **First snapshot tests for `apps/web/`** — set up the Vitest snapshot infra as part of this PR. Byte-identical output. (PLAN §6.4 PR K; Decision A10) | — | `<hash>` | |
| L | TODO | Add `#auto-generate-ideas` + `#auto-build-works` anchors; add four promoted-constant `<NumberField>` rows. (PLAN §6.4 PR L) | K, D | `<hash>` | |
| EE | TODO | Add Auto-retry policy sub-section (anchor `#auto-retry`) + Account-wide budgets sub-section (anchor `#account-budgets`) to settings page. (v6 / PLAN §6.4 PR EE) | L, 0.5, 0.6 | `<hash>` | |

### Phase 5 — Ideas page + Dashboard Ideas block

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| M | TODO | Extract `<IdeaCard />` from `WorkProposalsSection.tsx` to `apps/web/src/components/ideas/`. Snapshot-verify byte-identical. (PLAN §7.3 PR M) | K | `<hash>` | |
| N | TODO | New `/ideas` page (sidebar + page + quick-add `+Add` button + two toggles + ⚙ gears + sorted list). (PLAN §7.3 PR N) | M, B | `<hash>` | |
| O | TODO | Reshape Dashboard Ideas preview block: add toggles + `+Add` + gears + `View all (N)` link. Max 3 cards. (PLAN §7.3 PR O) | N | `<hash>` | |
| P | TODO | Done filter chip on `/ideas`. (PLAN §7.3 PR P) | N | `<hash>` | |

### Phase 6 — Missions UI

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| Q | TODO | `/missions` page: Cards list + small `+ New Mission` button top-right (NO large quick-add — Phase 6.5's `/new` owns that). (PLAN §8.5 PR Q) | H | `<hash>` | |
| R | TODO | `/missions/[id]` Mission detail page: header + Schedule switch + per-Mission Auto-build + outstanding-Ideas cap + guardrails overrides + live run (LIST of all in-flight runs per Decision A15) + Ideas list + Works list + Pause/Resume/Complete/Delete/Run-now. (PLAN §8.5 PR R) | Q, K | `<hash>` | |
| S | TODO | Dashboard Missions preview block above Ideas block. 3 cards with live counters (Ideas/Works/Sites). (PLAN §8.5 PR S) | Q | `<hash>` | |
| GG | TODO | Mission detail page extras: activity timeline + spend-over-time chart + Clone button (with confirmation modal) + Related Works (inherited) panel (visible when `sourceMissionId != null`) + Idea failure inline error. (v6 / PLAN §8.5 PR GG) | R, HH, U | `<hash>` | |

### Phase 6.5 — Unified `+ New` page at `/new`

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| CC1 | TODO | Extract `CreationBlockTrio` from `new-work-client.tsx` (lines 57+) to shared component. **Byte-identical `/works/new` output** (snapshot test). Decision A11. (PLAN §8b.3 PR CC1) | K | `<hash>` | |
| CC2 | TODO | New `/new` route + page: large prompt input + chips (`Mission`/`Idea`/`Website`/`Landing Page`/`Blog`/`Directory`/`Awesome Repo` in that order) + reused CreationBlockTrio with `labelSet='unified'` ("Create Work with AI" / "Create Work Manually" / "Import Existing Work"). AI Chat sidebar HIDDEN on `/new` until submit. Submit posts prompt into chat and navigates Canvas to created object. (PLAN §8b.3 PR CC2) | CC1, H | `<hash>` | |
| DD | TODO | Sidebar `+ New Work` → `+ New` rename + repoint to new route `ROUTES.DASHBOARD_NEW = '/new'`. All 21 locales. Existing `ROUTES.DASHBOARD_WORKS_NEW` stays. (PLAN §8b.3 PR DD) | CC2 | `<hash>` | |

### Phase 7 — Budgets generalization

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| T | TODO | Polymorphic owner on budget + usage entities (use Phase 0.3 columns). `BudgetGuardService` extended with `ownerType + ownerId` query; falls back to per-Work for back-compat. (PLAN §9.4 PR T) | 0.3 | `<hash>` | |
| U | TODO | Per-Idea + per-Mission budget query endpoints. Read-time roll-up via FK joins per spec §8.2. (PLAN §9.4 PR U) | T | `<hash>` | |
| V | TODO | Budget UI on Mission detail page + Idea progress view + Work Agent settings page. (PLAN §9.4 PR V) | U, EE | `<hash>` | |
| II | TODO | Account-wide spend roll-up + Dashboard `Month Spend` 6th tile. `GET /me/usage/account-wide`. Click → `/settings/work-agent#account-budgets`. (v6 / PLAN §9.4 PR II) | U, EE, F | `<hash>` | |

### Phase 8 — Mission Templates

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| W | TODO | Kind-switch on `TemplatesCatalog` (Mission Templates default, Work Templates secondary). (PLAN §10.4 PR W) | — | `<hash>` | |
| X | TODO | Mission Templates catalog backend + per-Mission `<slug>-mission` repo scaffolder via `gitFacade.createRepository()` (Decision A8). Same destination org as `-data` repos. (PLAN §10.4 PR X) | H | `<hash>` | |
| Y | TODO | "Use this Template" button on Mission Template cards → `/new?type=mission` prefill. (PLAN §10.4 PR Y) | W, X, CC2 | `<hash>` | |
| JJ | TODO | `MissionTemplateManifestService` — parse `.works/mission.yml` with Zod. Forward-compat on unknown keys. Integrate with PR X scaffolder: copy `kb.seedPaths`, apply `defaults.*`, pass `recommendedWorkTemplates` to Idea→Work scaffolder. (v6 / PLAN §10.4 PR JJ; Decisions A21, A22) | X | `<hash>` | |

### Phase 9 — AI Chat tool registrations (TWO surfaces)

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| Z1 | TODO | Web-side in-app AI Chat tools (Vercel AI SDK `tool()` defs at `apps/web/src/lib/ai/tools/missions.tools.ts` + `ideas.tools.ts`). Verbs per spec §3.8 + §4.5. (PLAN §11.3) | H, B, FF, HH | `<hash>` | |
| Z2 | TODO | MCP WHITELIST entries at `apps/mcp/src/openapi-tools/whitelist.ts` for every new endpoint. Auto-derives from `@ApiOperation` decorators. (PLAN §11.4) | H, B, FF, HH, T, U, II, X, JJ | `<hash>` | |

### Phase 10 — Localization sweep

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| LOC | TODO | All 21 locale files brought to parity with `en.json` for every new key introduced by Phases 2–9. MT acceptable for v1; flag for translator pass post-merge. (PLAN §12) | (all UI phases) | `<hash>` | |

### Phase 11 — Docs

| PR | Status | Description | Deps | Commit | Summary |
|---|---|---|---|---|---|
| DOC1 | TODO | Lift end-user docs from Workspace into `apps/docs/` under `docs/features/missions.md`, `ideas.md`, `mission-templates.md`, `budgets-and-usage.md`. Index updated. (PLAN §13) | — | `<hash>` | |
| DOC2 | TODO | Cross-link spec + plan under `docs/specs/features/missions-ideas-works/{spec,plan}.md` (copy from Workspace). (PLAN §13) | — | `<hash>` | |

---

## Decisions made during build (append-only log)

Use this section to record any choice the loop makes mid-build that isn't already in PLAN §A. Format: `<date> · <PR> · <decision> · <why>`.

(No entries yet.)

---

## Blockers (if any — append-only)

(No entries yet.)

---

## Final Summary (filled at completion)

(Not yet complete.)
