# Missions → Ideas → Works — Detailed Execution Plan (v6)

**Owner:** Engineering · **Date:** 2026-05-24 · **Sibling spec:** [spec.md](spec.md)

> **What changed v5 → v6 in this PLAN:**
> Six deferred items promoted into v1 (per [spec v6 header](spec.md)). Net delta: 5 new PRs added (EE, FF, GG, HH, II, JJ), 4 phases get new sub-PRs, Phase 0 schema grows by 8 columns + 2 columns. Decision Log adds entries A21–A28.
> - **Phase 0** (schema): +`failureMessage`, +`failureKind` on `work_proposals`; +`maxAutoRetries`/`backoffSeconds`/`exponentialBackoffFactor`/`accountWideMonthlyCapCents`/`accountWideAllowOverage` on `work_agent_preferences`; +`sourceMissionId` on `missions` (Clone traceability).
> - **Phase 1**: +PR FF for `/retry` + `/rebuild` endpoints; build-flow handler extended with auto-retry loop.
> - **Phase 3**: +PR HH for `POST /me/missions/:id/clone` endpoint and the cloning service (metadata + repo snapshot + Idea fan-out + sourceMissionId FK).
> - **Phase 4**: +PR EE for Auto-retry policy settings sub-section + Account-wide budgets sub-section.
> - **Phase 6**: +PR GG for Mission detail page activity timeline + spend-over-time chart + Clone button + Failed-Idea inline error.
> - **Phase 7**: +PR II for Dashboard `Month Spend` tile + click-through to account-wide budget detail.
> - **Phase 8**: +PR JJ for `MissionTemplateManifestService` (parses `.works/mission.yml` with Zod) + mission-repo scaffolder integration (copies `kb.seedPaths` into the new Mission's repo; honors `defaults.*`; passes `recommendedWorkTemplates` to Idea→Work scaffolder).
>
> **What changed v4 → v5 in this PLAN:**
> - Added **§A. Decision Log** at the top — every architectural choice with the file/line that grounds it, so any AI agent picking up a phase knows what was decided vs. open.
> - Added **§B. Pre-flight code-read checklist per phase** — exact files the implementing agent MUST read before touching anything. Removes guesswork at the start of every phase.
> - Locked down the **build-from-Idea pipeline** (Phase 1 PR B): new endpoint creates a `WorkAgentGoal` with `maxWorksPerRun=1` + `ideaId`; on goal completion the existing accept-flow auto-runs and sets `acceptedWorkId`. The existing `POST /me/work-proposals/:id/accept` stays for user-created Works (additive, per [NN #20](file:///C:/Coding/Workspace/AGENTS.md)).
> - **Phase 9 split into PR Z1 (web-side AI tools) and PR Z2 (MCP whitelist)** — both surfaces ship, in parallel-mergeable PRs.
> - Pulled concrete file paths and patterns into every phase: `workScheduleDispatcherTask` for cron pattern, `gitFacade.createRepository()` for Mission repos, `WorkProposalsSection.tsx` + `WorkProposalCard.tsx` for extraction sources, `new-work-client.tsx` line-range for the three creation blocks to extract, `DashboardSidebar.tsx:204` for the `+ New Work` button location, all 21 locale files listed, Vitest as the snapshot runner.
> - Flagged **first-snapshot-test risk** in Phase 4 PR K — `apps/web/` has Vitest configured but no `*.snap` files yet; this PR creates the snapshot test infrastructure as well as the snapshots.
>
> **What changed v3 → v4 in this PLAN:**
> - Phase 6.5 was going to extend the existing `/works/new` page in place. **Corrected:** the unified entry lives at a **new route `/new`**. `/works/new` is left completely untouched (existing content, existing labels, existing flow). The new `/new` page is built fresh, and the three-Work-creation-block component on `/works/new` is **extracted to a shared component** so `/new` can render the same blocks (with a different label set passed as props) below its prompt input. No edits to `/works/new`'s rendered output.
> - PR set restructured: PR CC creates the `/new` page from scratch and extracts the shared block component. PR DD renames the sidebar `+ New Work` → `+ New` and points it at `/new`.
>
> **What changed v2 → v3 in this PLAN:**
> - Phase 6 (Missions UI) loses the Mission quick-add component (PR Q's "quick-add" part) and gains a small `+ New Mission` button top-right of `/missions` instead.
> - **New Phase 6.5** carves out the unified `+ New` page work as its own dedicated phase. (v4 correction above: distinct route, not in-place edit.)
> - No existing path is removed. The `+ Add` on `/ideas`, the `+ New Mission` on `/missions`, the existing `/works/new` three creation blocks, and the chat verbs from Phase 9 ALL stay alongside the new `+ New` page. Enforced by [Workspace NN #20](file:///C:/Coding/Workspace/AGENTS.md).
> - PR checklist (§15) updated: PR Q now ships only the `/missions` list + `+ New Mission` button (no quick-add). Two new PRs CC and DD ship the `+ New` page extensions + sidebar rename.

---

## §A. Decision Log (read before touching anything)

Every architectural decision with the file/line that grounds it. If a decision contradicts what you see in the code, the code wins and this log needs updating — flag and ask before deviating.

| # | Decision | Evidence in code | Phase impacted |
|---|---|---|---|
| A1 | `WorkProposalStatus` enum imported from `@ever-works/agent/user-research`, NOT `@ever-works/agent/entities` | `apps/api/src/work-proposals/work-proposals.controller.ts:19` (`import { WorkProposalStatus } from '@ever-works/agent/user-research';`) | 0, 1 |
| A2 | Today's `work_proposals` statuses: `PENDING` / `DISMISSED` / `ACCEPTED`. Sources: `AUTO_SIGNUP` / `USER_REFRESH` / `DISCOVER` / `SCHEDULED` | `packages/agent/src/entities/work-proposal.entity.ts:14–25` | 0, 1 |
| A3 | Today's `accept` endpoint takes a `workId` body param — i.e. user already built the Work, the endpoint just records the link. New `build` endpoint inverts this: it kicks off the build via WorkAgentGoal, then on completion the goal handler calls the existing accept-flow internally. **Existing accept endpoint stays untouched** (per NN #20) | `apps/api/src/work-proposals/work-proposals.controller.ts:172–189` | 1 |
| A4 | `WorkAgentGoal`/`WorkAgentRun`/`WorkAgentRunLog`/`WorkAgentPreference` are 4 separate entities. Goal-create is what initiates the build pipeline (Trigger.dev-based). | `apps/api/src/work-agent/work-agent.controller.ts`, `apps/web/src/lib/api/work-agent.ts:42–84` (interfaces) | 1, 3, 4 |
| A5 | AI Chat has TWO tool surfaces. Both ship in Phase 9. | (a) `apps/web/src/lib/ai/tools/suggest.tools.ts` (web-side, Vercel AI SDK `tool()` + Zod). (b) `apps/mcp/src/openapi-tools/tool-registration.service.ts` + `whitelist.ts` (MCP, auto-derives from `@ApiOperation` decorators) | 9 |
| A6 | Existing chat completion handler is OpenAI-compat and already accepts `dto.tools` from clients | `apps/api/src/ai-conversation/openai-compat.service.ts:142–165` | 6.5, 9 |
| A7 | Trigger.dev is the cron infra (not BullMQ). Pattern: `schedules.task({ id, cron, run })` where `run` builds a NestJS app context, gets a service, calls `.dispatchDue()` or similar | `packages/tasks/src/tasks/trigger/work-schedule-dispatcher.task.ts:12–32`. Other reference tasks in same dir: `user-research-rerun-dispatcher.task.ts`, `work-generation.task.ts`. | 3 |
| A8 | Mission repos and the Mission-repo scaffolder reuse `gitFacade.createRepository()` and land in the same org/account as today's `<slug>-data` Work repos | `packages/agent/src/ever-works-providers/ever-works-git.provider.ts:97`; usage example `packages/agent/src/account-transfer/github-sync.service.ts:78` | 8 |
| A9 | Mission Template catalog reuses the same source pattern as the existing Work Templates catalog | Implementer reads `apps/web/src/components/templates/TemplatesCatalog.tsx` + its data source (find via the Phase 8 pre-flight checklist) | 8 |
| A10 | Web app snapshot tests use **Vitest**, not Jest | `apps/web/vitest.config.ts` exists; no `*.snap` files yet — Phase 4 PR K creates the first snapshot tests for this app | 4, 5 |
| A11 | Existing three creation blocks on `/works/new` are rendered **inline** in `new-work-client.tsx` (lines 57+), NOT as a separate component. PR CC1 is a real extraction (not just a file-move) | `apps/web/src/app/[locale]/(dashboard)/works/new/new-work-client.tsx:57–...` | 6.5 |
| A12 | i18n namespaces in use: `dashboard.proposals.*` (Ideas block), `dashboard.workCreation.*` (the three creation blocks), `dashboard.settings.workAgent.*` (Work Agent settings), `dashboard.sidebar.newWork` (the `+ New Work` button label — confirmed via the `t('newWork')` call) | `apps/web/src/components/dashboard/WorkProposalsSection.tsx:30`, `apps/web/src/app/[locale]/(dashboard)/works/new/new-work-client.tsx:49`, `apps/web/src/components/dashboard/DashboardSidebar.tsx:209` | 2, 6.5 |
| A13 | All 21 web locales must be updated for every i18n change. Locales: `ar bg de en es fr he hi id it ja ko nl pl pt ru th tr uk vi zh`. Hebrew is RTL. | `ls apps/web/messages/` | 2, 10 |
| A14 | Sidebar `+ New Work` button: `apps/web/src/components/dashboard/DashboardSidebar.tsx:204–...`. Uses `ROUTES.DASHBOARD_WORKS_NEW`. Phase 6.5 adds `ROUTES.DASHBOARD_NEW = '/new'` (new constant — does NOT change the existing one) and points the sidebar button at the new constant. | as above | 6.5 |
| A15 | Mission detail page Live Run = list of all in-flight runs for this Mission's children (one row per Idea), each row using the extracted `<LiveRun />` + `<LogList />` from Phase 4 PR K | Spec §4.3, §10.6 | 6 |
| A16 | Dashboard stats source: `getWorkStats()` server action in `apps/web/src/app/actions/dashboard/works.ts`. Returns `{ totalWorks, totalItems, activeWebsites }` today. Phase 2 PR F adds `totalMissions` + `totalIdeas` to the same return shape. | as above | 2 |
| A17 | Ideas block on Dashboard is rendered by `<WorkProposalsSection>` (`apps/web/src/components/dashboard/WorkProposalsSection.tsx`). The component already has its own polling loop and uses `useTranslations('dashboard.proposals')`. Phase 5 PR M extracts the `<WorkProposalCard>` it uses; Phase 5 PR O reshapes the section itself to add toggles + `+Add` + gears + `View all` link. | `apps/web/src/components/dashboard/WorkProposalsSection.tsx`, `apps/web/src/components/dashboard/WorkProposalCard.tsx` | 5 |
| A18 | Existing rate-limit on `POST /me/work-proposals/refresh` uses `@Throttle()` decorator (3 per 60s). New endpoints should consider similar limits but are not gated to the same number — implementer's call per endpoint. | `apps/api/src/work-proposals/work-proposals.controller.ts:17–18` (import + usage) | 1 |
| A19 | All API controllers use NestJS Swagger decorators (`@ApiOperation`, `@ApiTags`, `@ApiResponse`). This is what makes MCP whitelist auto-derivation work (Decision A5) — every new endpoint MUST keep these decorators. | `apps/api/src/work-proposals/work-proposals.controller.ts:54–60` (example) | 1, 3, 7, 8 |
| A20 | Feature flag for the entire feature. Wrap sidebar items + page routes + Dashboard new blocks behind one flag (`feature.missions_v2` or your team's naming). Backend phases can land without exposing user surfaces. | Phase 14.2 (cross-cutting) | all UI phases |
| A21 | Mission Template manifest path: `.works/mission.yml` (NOT root-level `mission-template.yaml`). The `.works/` folder convention mirrors `.github/` / `.vscode/`. | spec §7.5 | 8 |
| A22 | Manifest parser uses Zod for schema validation. Unknown top-level keys → log warning + ignore (forward-compat). Invalid required fields → reject template ingest with clear error to UI. | spec §7.5 | 8 |
| A23 | Auto-retry transient-error classification is built into platform code (not user-configurable). User configures `maxAutoRetries` (0–5, default 2), `backoffSeconds` (10–3600, default 60), `exponentialBackoffFactor` (1.0–4.0, default 2.0). Wait between attempts = `backoffSeconds * factor ^ attempt`. | spec §3.9, §6.6 | 0, 1, 4 |
| A24 | Idea status stays `BUILDING` across auto-retries — it does NOT flicker to FAILED then QUEUED. Only transitions to FAILED on final exhaustion or non-transient error. | spec §3.9 | 1 |
| A25 | Mission Clone semantics = Full Fork: metadata + KB (snapshot of source's `<slug>-mission` repo at clone time) + Ideas (cloned as PENDING, source=MISSION, missionId=newMission.id, no back-FK) + Works (NOT cloned — `sourceMissionId` FK + read-only "Related Works" UI panel). Cloned Mission gets fresh `<slug>-mission` repo via `gitFacade.createRepository` (Decision A8). | spec §4.4a | 0, 3, 6 |
| A26 | Source Mission's DISMISSED Ideas are **skipped** during Clone (don't carry rejected ideas). All other statuses → PENDING on clone. | spec §4.4a | 3 |
| A27 | Re-build DONE Idea endpoint re-points `acceptedWorkId` to the NEW Work by default. Original Work is NOT deleted (NN #20). Optional `keepOriginalLink: true` flag creates a new Idea row instead (defer to v2 unless trivial). | spec §3.9 | 1 |
| A28 | Account-wide spend roll-up uses the same read-time roll-up query pattern as Mission-level spend (spec §8.2) but with the user as the scope key. Tile clicks → scrolls to Work Agent settings page's `#account-budgets` anchor. | spec §5.1, §6.6 | 7 |

---

## §B. Pre-flight code-read checklist (run before starting each phase)

Each phase says "before opening any editor, read these files in full." Skim is not sufficient — the file contains state, side effects, or i18n key references that bite if missed. After reading, the agent should be able to answer the listed questions without re-reading.

### Phase 0 (Schema)
- [ ] `packages/agent/src/entities/work-proposal.entity.ts`
- [ ] `packages/agent/src/entities/work-budget.entity.ts`
- [ ] `packages/agent/src/entities/usage-ledger-entry.entity.ts`
- [ ] `packages/agent/src/entities/plugin-usage-event.entity.ts`
- [ ] `packages/agent/src/entities/work-budget-alert-state.entity.ts`
- [ ] Find and read the `WorkAgentGoal` entity (path: `packages/agent/src/entities/work-agent-goal.entity.ts`) and the `WorkAgentPreference` entity in the same dir.
- [ ] `Ever Works/Code/platform/docs/specs/architecture/database-migrations.md` (the two-phase forward-only pattern for destructive enum changes)
- [ ] Latest 3 migration files under `apps/api/src/migrations/` for current naming/style conventions
- **Self-check:** what's the EXACT current `WorkProposalStatus` enum? What's the EXACT current `WorkProposalSource` enum? Where does `WorkAgentPreference` live and what columns does it have today? Are there any existing CHECK constraints on these columns or are they raw `varchar`?

### Phase 1 (Backend extensions)
- [ ] All of Phase 0's files (re-read; you've now landed migrations and the entity diffs matter)
- [ ] `apps/api/src/work-proposals/work-proposals.controller.ts` (full)
- [ ] `apps/api/src/work-proposals/work-proposals.service.ts`
- [ ] `apps/api/src/work-proposals/dto/work-proposal.dto.ts`
- [ ] `apps/api/src/work-agent/work-agent.controller.ts`
- [ ] `apps/api/src/work-agent/dto/work-agent.dto.ts`
- [ ] `apps/web/src/lib/api/work-agent.ts` (the web-side type definitions match the controller — keep aligned)
- [ ] `packages/agent/src/user-research/work-proposal.service.ts` + `proposal-coercion.ts` + `schemas.ts` (the generator)
- [ ] Find the Goal-completion handler — wherever it sets `acceptedWorkId` and updates Idea status. Search: `acceptedWorkId\s*=` across `packages/agent/src`
- **Self-check:** which service method actually creates a `WorkAgentGoal`? Does it return synchronously with an id, or via callback? Where is the existing rate-limit guard for `/refresh`?

### Phase 2 (Dashboard renames + stats)
- [ ] All 21 locale files under `apps/web/messages/` — `ar.json bg.json de.json en.json es.json fr.json he.json hi.json id.json it.json ja.json ko.json nl.json pl.json pt.json ru.json th.json tr.json uk.json vi.json zh.json` — open each and grep for `proposals.header.title`, `proposals.actions.accept`, `proposals.actions.refresh`, `dashboard.proposals`, and the "Recent Works" heading key
- [ ] `apps/web/src/app/[locale]/(dashboard)/(home)/page.tsx`
- [ ] `apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-client.tsx`
- [ ] `apps/web/src/app/actions/dashboard/works.ts` — the `getWorkStats()` action that returns `{ totalWorks, totalItems, activeWebsites }`
- [ ] Whatever backend endpoint that action calls (find by reading the action)
- **Self-check:** what's the exact i18n key path for "Recent Works"? What's the response shape of `getWorkStats()`?

### Phase 3 (Missions backend + tick worker)
- [ ] `packages/tasks/src/tasks/trigger/work-schedule-dispatcher.task.ts` (the canonical cron pattern — copy it)
- [ ] `packages/tasks/src/tasks/trigger/user-research-rerun-dispatcher.task.ts` (the existing Auto-generate Ideas loop)
- [ ] `packages/tasks/trigger.config.ts` (registration mechanism)
- [ ] `apps/api/src/work-agent/work-agent.controller.ts` (you'll call its service from the Mission tick)
- [ ] Whichever service `WorkScheduleDispatcherService` lives in — find via `rg 'class WorkScheduleDispatcherService' packages/agent`
- **Self-check:** what's the exact registration pattern for a new Trigger.dev cron job? How does the existing service get DI'd inside `run()`?

### Phase 4 (Work Agent settings refactor)
- [ ] `apps/web/src/components/settings/WorkAgentSettings.tsx` in full (490 lines)
- [ ] `apps/web/src/lib/api/work-agent.ts`
- [ ] `apps/web/src/app/actions/settings/work-agent.ts`
- [ ] `apps/web/vitest.config.ts` (snapshot test setup — confirm the runner + serializer plugins; this PR is the first to use snapshots in `apps/web`)
- [ ] Check `apps/web/package.json` for any `@vitest/snapshot` or testing-library setup; if missing, add as part of PR K
- **Self-check:** which subcomponents are currently inline (LiveRun, LogList, StatusPill, Metric, ToggleRow, NumberField, MoneyField)? What's the exact JSX they render so the snapshot test can assert byte-identical output post-extraction?

### Phase 5 (Ideas page + Dashboard Ideas block)
- [ ] `apps/web/src/components/dashboard/WorkProposalsSection.tsx` in full
- [ ] `apps/web/src/components/dashboard/WorkProposalCard.tsx`
- [ ] `apps/web/src/app/actions/dashboard/work-proposals.ts`
- [ ] `apps/web/src/lib/api/work-proposals.ts`
- [ ] All 21 locale files — for the existing `dashboard.proposals.*` keys and the new keys you're adding
- **Self-check:** what props does `WorkProposalsSection` accept? What polling cadence does it use? What's the `WorkProposalCard` signature?

### Phase 6 (Missions UI)
- [ ] All of Phase 5's files (the IdeaCard is reused on the Mission detail page)
- [ ] Phase 4's extracted `<LiveRun />` + `<LogList />` (you'll render one per in-flight Idea — Decision A15)
- [ ] `apps/web/src/components/dashboard/DashboardSidebar.tsx` (add new sidebar items here)
- [ ] Existing chat-sidebar visibility mechanism (find via `rg 'ChatSidebar|AiChatSidebar' apps/web/src`)

### Phase 6.5 (Unified `+ New` page at `/new`)
- [ ] `apps/web/src/app/[locale]/(dashboard)/works/new/page.tsx`
- [ ] `apps/web/src/app/[locale]/(dashboard)/works/new/new-work-client.tsx` (full — the three blocks live inline starting around line 57; Phase 6.5 PR CC1 extracts them)
- [ ] `apps/web/src/components/dashboard/DashboardSidebar.tsx:204–...` (the existing `+ New Work` button; PR DD renames + repoints)
- [ ] `apps/web/src/lib/routes.ts` (or wherever `ROUTES.DASHBOARD_WORKS_NEW` is defined — Phase 6.5 ADDS `ROUTES.DASHBOARD_NEW = '/new'`; the existing constant stays)
- [ ] Chat-sidebar visibility mechanism (route-aware hide on `/new` until submit)
- [ ] `apps/web/src/lib/ai/tools/suggest.tools.ts` (model for chip-hinted tool routing in Phase 9)

### Phase 7 (Budgets)
- [ ] `apps/api/src/budgets/budgets.controller.ts` + `usage.controller.ts` + `admin-usage.controller.ts` + `budget-alert.handler.ts`
- [ ] Find `BudgetGuardService` — search `rg 'class BudgetGuardService' packages/agent`
- [ ] Where plugin calls are intercepted (search `rg 'BudgetGuardService' packages/agent`)
- [ ] Existing per-Work budget UI (find via `rg 'workBudgetAPI|budgetsAPI' apps/web/src`)

### Phase 8 (Mission Templates)
- [ ] `apps/web/src/components/templates/TemplatesCatalog.tsx` in full
- [ ] `apps/web/src/components/templates/CreateCustomTemplateDialog.tsx`
- [ ] `apps/web/src/app/[locale]/(dashboard)/templates/page.tsx`
- [ ] Find the source of today's Work Templates catalog list (read the page's data-fetching path)
- [ ] `packages/agent/src/ever-works-providers/ever-works-git.provider.ts:97` — the `createRepository` signature you'll call
- [ ] `packages/agent/src/account-transfer/github-sync.service.ts:78` — a real usage example
- [ ] `packages/plugins/github/` — the underlying plugin, in case the provider exposes anything more
- **Self-check:** does `gitFacade.createRepository()` already handle name collisions? Where does the destination org come from?

### Phase 9 (AI Chat tools)
- [ ] `apps/web/src/lib/ai/tools/suggest.tools.ts` (web-side pattern — copy for new tools)
- [ ] Other files under `apps/web/src/lib/ai/tools/` (e.g. `search.tools.ts`, `user.tools.ts`)
- [ ] `apps/mcp/src/openapi-tools/whitelist.ts` (the WHITELIST entries pattern)
- [ ] `apps/mcp/src/openapi-tools/tool-registration.service.ts` (how WHITELIST is consumed)
- [ ] All controllers from Phases 1, 3, 7, 8 that need MCP exposure — confirm each has `@ApiOperation` + `@ApiTags` decorators

### Phase 10 (Localization)
- [ ] All 21 locale files; diff against `en.json` to find missing keys

### Phase 11 (Docs)
- [ ] `apps/docs/` structure and `docs/features/` index
- [ ] The two sibling docs from this Workspace KB

---

> **Hard rule (repeat from spec):** This is an **extension**. Nothing in production today is removed, rewritten, or significantly changed. Every phase below is additive. Where existing components are *extracted into shared modules*, the original call sites continue to work unchanged. Where the spec proposes a "rename", it's i18n string changes only — never a code path deletion.
>
> **Hard rule on workspace process:** Every PR landing this plan must follow the platform repo conventions in [`Ever Works/Code/platform/CLAUDE.md`](file:///C:/Coding/Ever%20Works/Code/platform/CLAUDE.md) and the workstation conventions in [`Workspace/AGENTS.md`](file:///C:/Coding/Workspace/AGENTS.md) — notably:
> - TypeORM entity changes ship with a migration in the same PR (NN #16).
> - PR drives to clean review state (NN #14) and bot reviews are a pre-merge gate (NN #18).
> - CI must be green before stopping (NN #19).

---

## 0. Goals and non-goals of this plan

**Goal:** sequence the work so it can ship in independent, reviewable, deployable PRs — backend before frontend within a phase, schema before code, and shared-component extraction before any new consumer relies on it.

**Non-goal:** day-by-day estimates. Each phase is "small enough to merge as 1–3 PRs"; sizing is the implementer's call.

**Sequencing principle:** the spec describes a system; the plan ships it back-to-front. Phase 0 is plumbing only. The first user-visible change lands in Phase 2 (rename + Total Ideas on Dashboard) — a tiny PR designed to verify the migration and stats path before the bigger surfaces land.

---

## 1. Phase map at a glance

```
Phase 0  Schema and migrations (additive only)
Phase 1  Backend: extend WorkProposal, exclusion-list generator, work-agent constants → settings
Phase 2  Frontend: Dashboard renames + Total Ideas/Missions tiles (smallest user-visible PR)
Phase 3  Backend: Missions entity, API, tick worker
Phase 4  Work Agent settings page additive refactor (extract shared components, add anchors, promote constants)
Phase 5  Frontend: /ideas page + Dashboard Ideas block reshape
Phase 6  Frontend: /missions page + Mission detail page + Dashboard Missions block
Phase 6.5 Frontend: unified `+ New` entry page (extends /works/new) + sidebar rename
Phase 7  Budgets generalization (polymorphic owner)
Phase 8  Mission Templates (templates page kind-switch + Mission repo scaffolder)
Phase 9  AI Chat tool registrations (Missions + extended Ideas)
Phase 10 Localization sweep across all locales
Phase 11 Docs ship to docs.ever.works, sign-off
```

Each phase below has: **What ships**, **Files touched (read-only orientation)**, **PRs**, **Tests**, **Risks & rollback**, **Definition of done**.

---

## 2. Phase 0 — Schema and migrations (additive)

### 2.1 What ships

All schema changes the rest of the plan depends on, in a single migration set. No app behavior changes. The migrations are forward-only; rollback is via revert if executed before any app code reads the new columns (after that, treat as forward-only — see [database-migrations spec](file:///C:/Coding/Ever%20Works/Code/platform/docs/specs/architecture/database-migrations.md)).

### 2.2 Migrations

| Migration | Table | Change |
|---|---|---|
| `<ts>-ExtendWorkProposalForMissions.ts` | `work_proposals` | Add `missionId uuid NULL` FK (no constraint yet — will be activated in Phase 3 when `missions` exists). Add new permitted values to `status` and `source` columns (`QUEUED`, `BUILDING`, `FAILED`, `USER_MANUAL`, `MISSION`). Drop existing index, add `(userId, status, missionId, generatedAt)`. |
| `<ts>-CreateMissionsTable.ts` | `missions` (NEW) | See §4.1 entity spec. Adds the FK constraint on `work_proposals.missionId`. |
| `<ts>-ExtendBudgetsToPolymorphicOwner.ts` | `work_budgets`, `usage_ledger_entries`, `plugin_usage_events`, `work_budget_alert_states` | Add `ownerType varchar(16) NOT NULL DEFAULT 'work'` and `ownerId uuid NULL` to each. Backfill `ownerType='work', ownerId=workId`. Add composite index `(ownerType, ownerId)`. Existing `workId` columns stay. |
| `<ts>-PromoteWorkAgentConstantsToSettings.ts` | `work_agent_preferences` (or whatever table backs `WorkAgentPreferences`) | Add nullable columns for: `auto_generate_cadence` (cron string), `auto_generate_batch_size` (int), `auto_build_throttle_per_day` (int, nullable=`Unlimited`), `mission_default_outstanding_cap` (int, nullable=`Unlimited`). |
| `<ts>-AddAutoRetryPrefs.ts` (v6) | `work_agent_preferences` | Add `max_auto_retries` (int, default 2, range 0–5), `backoff_seconds` (int, default 60, range 10–3600), `exponential_backoff_factor` (decimal, default 2.0, range 1.0–4.0). Decision A23. |
| `<ts>-AddAccountWideBudget.ts` (v6) | `work_agent_preferences` | Add `account_wide_monthly_cap_cents` (bigint, nullable), `account_wide_allow_overage` (boolean, default true). Decision A28. |
| `<ts>-AddIdeaIdToWorkAgentGoal.ts` | `work_agent_goals` (whatever the table is) | Add `ideaId uuid NULL` FK to `work_proposals.id`. Lets us join "this build run" back to "the Idea it was building" (§6.1 row 4 of spec). |
| `<ts>-AddIdeaFailureColumns.ts` (v6) | `work_proposals` | Add `failure_message` (text, nullable), `failure_kind` (varchar(32), nullable; values: `transient_network`, `transient_rate_limit`, `transient_upstream_5xx`, `transient_plugin`, `permanent_invalid_input`, `permanent_unknown`, etc.). Decisions A23, A24. |
| `<ts>-AddMissionRefsToWorkProposalAndWork.ts` | `works` | Add `accepted_from_idea_id uuid NULL` (back-pointer to the Idea this Work came from). Lets the Mission detail page roll up Works without a heavy join. |
| `<ts>-AddSourceMissionIdToMissions.ts` (v6) | `missions` | Add `source_mission_id uuid NULL` self-FK for Clone traceability. Decision A25. |

> Confirm table names by reading the entity decorators before generating migrations (`packages/agent/src/entities/`). The migration filenames above are illustrative.

### 2.3 Generation

Per platform CLAUDE.md and workspace AGENTS.md NN #16:

```bash
cd "Ever Works/Code/platform/apps/api"
pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/<Name>
# READ the generated SQL — never trust diff blindly.
# If TypeORM proposes DROP / ALTER TYPE, use the two-phase forward-only pattern
# from docs/specs/architecture/database.md §6.2.
```

### 2.4 Tests

- Add `*.integration.spec.ts` covering: insert with new columns / enum values; backfill correctness for budgets; new index is used by the page-load query plan (`EXPLAIN`).
- Update existing TypeORM-using specs to confirm no regression on existing reads.

### 2.5 Risks & rollback

- TypeORM diff sometimes proposes destructive enum recreation — read SQL, apply two-phase pattern if so.
- Workstation rule: API auto-applies migrations on boot (`migrationsRun: true`). The deploy after this phase will run all four migrations on stage/prod. Verify against [`knowledge/runbooks/EVER_WORKS_DB_MIGRATIONS.md`](file:///C:/Coding/Workspace/knowledge/runbooks/EVER_WORKS_DB_MIGRATIONS.md) before merging.
- Rollback: each migration's `down()` reverses cleanly *before* any app code reads the new columns. After Phase 1+ code lands, treat as forward-only.

### 2.6 Definition of done

- All migrations applied on stage; smoke-test API boots without error; all existing tests still green; no behavior change visible to users.

---

## 3. Phase 1 — Backend extensions to existing surfaces

### 3.1 What ships

- `WorkProposal` entity reflects the new enum values + `missionId` column.
- A new endpoint to user-manually create Ideas: `POST /me/work-proposals` (NestJS controller, body = prompt). Persists with `source='USER_MANUAL'`, calls shared titler for `title`, defaults `status='PENDING'` (or `QUEUED` if global Auto-build is on — see Decision A3 for the auto-flow). Returns the created `WorkProposalResponseDto`. **Must carry `@ApiOperation` + `@ApiTags` + Throttle decorators** (Decisions A18, A19) so it auto-exposes via MCP and is rate-limited.
- A new endpoint to queue an existing Idea for build: `POST /me/work-proposals/:id/build`. Flow (matches Decision A3):
  1. Validate Idea exists, user owns it, `status IN ('PENDING','FAILED')`.
  2. Transition Idea to `status='QUEUED'`.
  3. Call the existing Work Agent goal-create service (the one `apps/api/src/work-agent/work-agent.controller.ts` calls via `POST /me/work-agent/goals`) with `{ instruction: toProposalUserPrompt(idea), maxWorksPerRun: 1, ideaId: idea.id, dryRun: <global default>, guardrailsOverride: <mission.guardrailsOverride if idea.missionId, else undefined> }`.
  4. Return the created Goal id + the updated Idea.
  5. **Goal-completion hook** (in the goal-completion handler — find via Phase 1 pre-flight): when a Goal with non-null `ideaId` completes successfully and produced exactly one Work, internally invoke the existing accept-flow logic (DO NOT bypass it — extract the body of the existing `accept` controller method into a service method `acceptInternal(ideaId, workId)` and call it from both the controller AND the goal-completion handler). On goal failure, transition Idea to `status='FAILED'` and persist the error message on the proposal.
  6. **The existing `POST /me/work-proposals/:id/accept` endpoint and its controller method stay untouched** (per NN #20) — it still works for the existing "user already built a Work, now record the link" flow.
- The user-research proposal generator (`packages/agent/src/user-research/*`) extended to accept an exclusion-and-context list (every existing Idea title/slug/description, ALL statuses — including DONE — per spec §3.3) AND an optional `missionContext` (Goal + relevant Mission KB excerpts).
- The four promoted constants (Phase 0) wired through to `work-agent.service.ts` / generator service so they read user prefs instead of hardcoded constants.

### 3.2 Files (read-only orientation — for the implementer to open)

- `packages/agent/src/entities/work-proposal.entity.ts`
- `apps/api/src/work-proposals/work-proposals.controller.ts` + `*.service.ts` + `*.module.ts`
- `packages/agent/src/user-research/work-proposal.service.ts` + `proposal-coercion.ts` + `schemas.ts`
- `apps/api/src/work-agent/work-agent.controller.ts` + `work-agent.module.ts` + `dto/work-agent.dto.ts`
- `apps/web/src/lib/api/work-agent.ts` (extend `UpdateWorkAgentPreferencesInput` / `WorkAgentPreferences` to include the four new fields)

### 3.3 PRs

1. **PR A** — `feat(api): extend WorkProposal statuses/sources + missionId column wiring`. Entity-only + service code that handles the new enum values.
2. **PR B** — `feat(api): user-manual Idea create + build-from-Idea endpoint`. New controllers; wires through to existing work-agent goal creation.
3. **PR C** — `feat(api): proposal generator accepts exclusion+context list and missionContext`. Generator + prompt-template change. Unit-test the prompt assembly.
4. **PR D** — `feat(api): promote four work-agent constants to user settings`. Reads now come from prefs; writes via existing `PUT /me/work-agent/preferences`. Default values match today's hardcoded constants for back-compat.
5. **PR FF** (v6) — `feat(api): retry + rebuild Idea endpoints + auto-retry handler`. Adds:
   - `POST /me/work-proposals/:id/retry` — only valid when `status='FAILED'`; clears `failure_message`/`failure_kind`, transitions to QUEUED, creates a new Goal (same shape as original).
   - `POST /me/work-proposals/:id/rebuild` — only valid when `status='ACCEPTED'`; creates a new Goal with the same instruction; on completion re-points `acceptedWorkId` to the new Work (per Decision A27).
   - **Auto-retry loop in Goal-completion handler**: on Goal failure, classify the error against the built-in transient set. If transient AND `attempts < user.maxAutoRetries`, schedule a re-queue after `backoffSeconds * factor ^ attempts`. Idea status stays `BUILDING` across attempts (Decision A24). On exhaustion → FAILED + persist `failure_message` + `failure_kind`.
   - Decorate both endpoints with `@ApiOperation` + `@ApiTags` (Decision A19) and `@Throttle` (Decision A18).

### 3.4 Tests

- Unit: extended generator excludes provided titles; respects missionContext; returns identical output for empty exclusion list (back-compat).
- Integration: create-idea endpoint persists with correct status/source; build endpoint creates a goal and returns; per-idea concurrency safe.
- Reuse existing work-proposals test suite — make sure nothing regresses.

### 3.5 Risks & rollback

- Generator prompt change could degrade suggestion quality. Mitigation: keep the old prompt path behind a feature flag for the first week, A/B sample with internal users, then remove the flag.
- Constants promotion: ensure defaults read from settings fall back to the same hardcoded values if the column is NULL (back-compat).

### 3.6 Definition of done

- All four PRs merged, stage smoke-tested, existing dashboard "Suggest more" still works identically when no exclusion list is given.

---

## 4. Phase 2 — Smallest user-visible PR (Dashboard renames + stats reorder)

### 4.1 What ships

The first thing the user sees. Tiny PR. Validates the stats endpoint + i18n updates before anything bigger.

- i18n renames in **every locale**:
  - `proposals.header.title` → "Ideas"; drop the `titleWithName` username variant in display (leave key for now).
  - `proposals.actions.accept` → "Build".
  - `proposals.actions.refresh` → "Suggest more".
  - Dashboard "Recent Works" key → "Works".
- Dashboard stats row gains **two new tiles** in the new order: `[Total Missions]  [Total Ideas]  [Total Works]  [Total Items]  [Active Websites]`.
  - `Total Missions` returns 0 for now (table is empty until Phase 3) — render the tile anyway so the layout is correct from the start.
  - `Total Ideas` counts ALL `work_proposals` for the user across all statuses.

### 4.2 Files

- `apps/web/messages/{ar,bg,de,en,es,...}.json` — every locale.
- The Dashboard page component that renders the stats row (locate via `grep` for the existing tile labels — `Total Works`, `Total Items`).
- Whatever API endpoint backs the stats row (likely `apps/api/src/...` — find with `rg 'totalWorks|total_works'`).

### 4.3 PRs

1. **PR E** — `feat(web): i18n renames for Ideas/Works/Build/Suggest-more` (locale files + verification the keys are consumed correctly).
2. **PR F** — `feat(api+web): add Total Missions + Total Ideas to dashboard stats`. Two SQL COUNTs, two tiles. Order per spec §5.1.

### 4.4 Tests

- Snapshot/integration test for the dashboard stats endpoint shape.
- i18n unit: every locale file parses; every renamed key still exists in every locale.

### 4.5 Risks & rollback

- Mistranslation in locales — recruit translators or accept MT for the v2 ship and patch via follow-up. Spec §13 covers this in sign-off.

### 4.6 Definition of done

- Dashboard shows the new 5-tile row; rename copy reads correctly in every locale.

---

## 5. Phase 3 — Backend: Missions entity, API, tick worker

### 5.1 Mission entity (TypeORM)

`packages/agent/src/entities/mission.entity.ts`:

```ts
@Entity({ name: 'missions' })
@Index('idx_missions_user_status', ['userId', 'status'])
export class Mission {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column('uuid') userId: string;
    @ManyToOne(() => User, { onDelete: 'CASCADE' }) user?: User;

    @Column({ length: 200 }) title: string;
    @Column({ type: 'text' }) description: string;

    @Column({ type: 'varchar', length: 16 })
    type: 'one-shot' | 'scheduled';

    @Column({ type: 'varchar', length: 16, default: 'active' })
    status: 'active' | 'paused' | 'completed' | 'failed';

    /** Cron string; null when type='one-shot'. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    schedule?: string | null;

    @Column({ type: 'boolean', default: false })
    autoBuildWorks: boolean;

    /** null = inherit global; -1 (or NULL semantic) = Unlimited. Default = global default. */
    @Column({ type: 'int', nullable: true })
    outstandingIdeasCap?: number | null;

    /** Sparse override of WorkAgentGuardrails for Ideas this Mission spawns. */
    @Column('simple-json', { nullable: true })
    guardrailsOverride?: Partial<WorkAgentGuardrails> | null;

    /** Repo this Mission was scaffolded from, e.g. 'ever-works/p2p-marketplace-mission-template'. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    missionTemplateRepo?: string | null;

    /** Per-Mission repo, e.g. 'ever-works/cats-business-mission'. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    missionRepo?: string | null;

    @CreateDateColumn() createdAt: Date;
    @UpdateDateColumn() updatedAt: Date;
}
```

(Generate the migration off this entity — covered in Phase 0 as `<ts>-CreateMissionsTable.ts`. Land entity + migration in the same PR per NN #16.)

### 5.2 Module

`apps/api/src/missions/`:

- `missions.module.ts`
- `missions.controller.ts` — CRUD: list, get, create, update (title/description/schedule/auto-build/cap/guardrails/Template), pause, resume, complete, delete, run-now.
- `missions.service.ts` — encapsulates the lifecycle. The `create` path:
  1. Calls the shared titler (§5.4) to generate the Mission title from the prompt.
  2. (Phase 8 — Mission Templates) If `missionTemplateRepo` is set, calls the Mission repo scaffolder. Otherwise scaffolds from a generic baseline.
  3. Persists the Mission row.
  4. If `type === 'one-shot'`, immediately runs the first tick (§5.3).
- `dto/` for input validation.
- `*.spec.ts` for service and controller.

### 5.3 Mission tick worker

A new BullMQ queue (or Trigger.dev job — match the existing scheduled-Works infra) named `mission-tick`:

- Scheduled by the existing cron infra for every `Mission WHERE status='active' AND type='scheduled' AND schedule != null`.
- Per tick:
  1. Re-read the Mission.
  2. **Honor the outstanding-Ideas cap:** count `WorkProposal WHERE missionId = mission.id AND status IN ('PENDING','QUEUED','BUILDING')`. If `count >= cap` (and cap !== Unlimited), log `mission_at_cap` event and exit.
  3. Call the extended user-research generator (Phase 1 PR C) with `missionContext = { description, kb: <fetched-from-mission-repo> }` and the standard exclusion list.
  4. For each returned proposal, persist a `WorkProposal` with `source='MISSION'`, `missionId=mission.id`, `status='PENDING'`.
  5. If `mission.autoBuildWorks` (after Mission override falls back to global), for each new Idea call `workAgentAPI.createGoal({ instruction, ideaId, maxWorksPerRun: 1, ...mission.guardrailsOverride })`.
  6. Append a tick log entry (events are the existing `WorkAgentRunLog` machinery — or a parallel `MissionRunLog` if it's cleaner; recommend reuse).

### 5.4 Shared titler service

`packages/agent/src/titler/titler.service.ts` (NEW) — single AI call that takes prompt body and returns a short title (≤80 chars). Used by user-manual Idea create, Mission-spawned Idea create, Mission create, Work title fallback. One implementation; four call sites.

### 5.5 PRs

1. **PR G** — `feat(api): Mission entity + migration` (table + FK constraint on `work_proposals.missionId` + `source_mission_id` self-FK for Clone).
2. **PR H** — `feat(api): MissionsModule with CRUD + lifecycle endpoints`.
3. **PR I** — `feat(api): shared titler service` (extract from wherever title generation exists today; cover all four call sites).
4. **PR J** — `feat(api): mission tick worker` (cron registration + handler).
5. **PR HH** (v6) — `feat(api): Mission Clone endpoint + cloning service`. Adds:
   - `POST /me/missions/:id/clone` accepting optional overrides for `{ title, description, type, schedule }`.
   - `MissionCloneService` orchestrating: (a) read source Mission row + assert ownership, (b) build new Mission row with `sourceMissionId = source.id` and (default) title=`"<source.title> (clone)"`, (c) call `gitFacade.createRepository()` for new `<slug>-mission` repo, (d) **snapshot copy** of source repo contents into the new repo (use the same git provider's repo-content-copy primitive — or sequential file fetch+commit if no primitive exists), (e) iterate source's `WorkProposal[]`: skip `DISMISSED`, clone all others as new rows with `status='PENDING'`, `missionId = new.id`, `source='MISSION'`, fresh `generatedAt`, no `acceptedWorkId`, (f) return new Mission DTO + count of cloned Ideas. Does NOT clone Works (they remain on source; the new Mission detail page surfaces them via a `sourceMissionId` join — see Phase 6 PR GG).
   - Decorate with `@ApiOperation` + `@ApiTags` (Decision A19).

### 5.6 Tests

- Unit: tick worker honors cap; tick worker uses missionContext; tick worker skips if Mission is paused.
- Integration: full create → tick → Idea persisted → optional build goal created.

### 5.7 Risks & rollback

- Tick worker runaway: cap defaults to 20; even with Unlimited the existing per-run / per-day work-agent guardrails apply.
- Auto-build with low budget: existing BudgetGuardService still enforces (Phase 7 generalizes ownership but the per-Work cap still bites).

### 5.8 Definition of done

- Mission CRUD works via API; tick worker can be invoked manually via `POST /missions/:id/run-now`; Ideas appear in `work_proposals` tagged with the Mission.

---

## 6. Phase 4 — Work Agent settings page additive refactor

### 6.1 What ships

The careful "unbundle without removing" work the spec §6 mandates. After this phase the existing settings page is unchanged in behavior but its internals are reusable, and it carries two new anchors and the promoted-constant fields.

### 6.2 Steps (in order, all in one PR or two)

1. **Extract shared components** from `apps/web/src/components/settings/WorkAgentSettings.tsx` into `apps/web/src/components/work-agent/`:
   - `LiveRun.tsx` — the active-run progress + metrics block (lines 246–288 in the existing file).
   - `LogList.tsx` — the log tail (lines 470–489).
   - `StatusPill.tsx` — (lines 448–459).
   - `Metric.tsx` — (lines 461–468).
   - `ToggleRow.tsx`, `NumberField.tsx`, `MoneyField.tsx` — small primitives reused by the existing settings page AND by Mission detail page's per-Mission override UI.
   - Keep the existing `WorkAgentSettings.tsx` importing these from the new location. **No visual change.**
2. **Add anchor IDs** to the two relevant sub-sections:
   - The Agent section's Auto-generate Ideas sub-region gets `id="auto-generate-ideas"`.
   - The Guardrails section's Auto-build Works sub-region gets `id="auto-build-works"`.
3. **Render the four promoted-constant fields** (cadence, batch size, throttle, Mission cap default) using the existing `<NumberField>` and a new schedule-picker primitive (cadence as cron with a friendly preset dropdown).
4. **Add discoverability links**: small "See this in the new view →" affordance in the Live Run and Recent Goals section headers, linking to `/ideas` (and `/missions/<id>` when the active goal has `missionId`).
5. **Add the "Advanced — direct goal queue" label** to the Queue section (small description tweak so it reads as the power-user surface).

### 6.3 Files

- `apps/web/src/components/settings/WorkAgentSettings.tsx` (refactored to import from new location, otherwise unchanged).
- `apps/web/src/components/work-agent/*` (NEW directory).
- `apps/web/src/app/[locale]/(dashboard)/settings/work-agent/page.tsx` (unchanged; verify still works).
- `apps/web/src/lib/api/work-agent.ts` (extended in Phase 1 PR D — verify types flow through).
- `apps/web/src/app/actions/settings/work-agent.ts` (unchanged unless new server actions are needed for the new fields — likely just extends the existing `updateWorkAgentPreferencesAction` input).

### 6.4 PRs

1. **PR K** — `refactor(web): extract shared work-agent components (no behavior change)`.
2. **PR L** — `feat(web): add anchors + promoted-constant fields to work-agent settings page`.
3. **PR EE** (v6) — `feat(web): Auto-retry policy + Account-wide budgets sub-sections on work-agent settings`. Adds two new sub-sections to the settings page:
   - **Auto-retry policy** (anchor `#auto-retry`): three `<NumberField>` rows for `maxAutoRetries`, `backoffSeconds`, `exponentialBackoffFactor`. Help-text per spec §6.6 (4) explains transient-error classification is platform-managed.
   - **Account-wide budgets** (anchor `#account-budgets`): one `<MoneyField>` for `accountWideMonthlyCapCents` + one `<ToggleRow>` for `accountWideAllowOverage`. Help-text links to per-Work and per-Mission budget surfaces.
   - All four fields read/write through extended `updateWorkAgentPreferencesAction` (PR D already added the action's signature flexibility).

### 6.5 Tests

- Snapshot test of `WorkAgentSettings.tsx` before/after PR K — should be byte-identical render output.
- Anchor IDs are present and unique on the rendered page.
- New fields read/write through the existing API.

### 6.6 Risks & rollback

- Pure refactor risk: shared components don't render the same. Mitigated by the snapshot test.
- **First snapshot tests in `apps/web/`** (Decision A10) — `apps/web/vitest.config.ts` exists but no `*.snap` files yet. PR K is the first snapshot test for the web app. Verify the Vitest snapshot serializer is configured (it usually is by default, but check `apps/web/package.json` for testing-library / react setup); if any dependency missing, add it as part of PR K so subsequent phases (Phase 5 PR M, Phase 6.5 PR CC1) can rely on the same infra.
- Tight coupling between extracted components and `next-intl` keys. Use the same `useTranslations('dashboard.settings.workAgent')` namespace at the call site and pass strings as props, OR keep `useTranslations` inside the components (acceptable since they're only used in one i18n namespace today; Phase 5/6 will introduce a second namespace for Ideas/Missions — switch to props-based then).

### 6.7 Definition of done

- Settings page renders identically; new fields persist; deep-link from `/ideas#auto-generate-ideas` works (manual smoke test).

---

## 7. Phase 5 — Frontend: /ideas page + Dashboard Ideas block reshape

### 7.1 What ships

- New `/ideas` page (sidebar-linked) with: quick-add input, Auto-generate Ideas + Auto-build Works switches with ⚙ gears, sorted list (Queued/Building first, Pending next), Done filter chip.
- Dashboard's Ideas preview block reshape to match (3 cards, the same toggles and `+ Add` and ⚙ gears, `View all (N)` link).
- IdeaCard component extracted from the existing dashboard `proposals` UI; the existing usage continues to work via the extracted component.
- Per-Idea inline progress on `BUILDING` Idea Cards (reuses the shared `<LiveRun />` primitive from Phase 4 in compact mode).

### 7.2 Files

- New: `apps/web/src/app/[locale]/(dashboard)/ideas/page.tsx`.
- New: `apps/web/src/components/ideas/IdeasPage.tsx`, `IdeaCard.tsx`, `IdeasToggles.tsx`, `IdeasQuickAdd.tsx`.
- Touched: whatever component renders the dashboard's `proposals` block today (grep for `proposals.header.title`) — swap inner UI to use the new shared `IdeaCard` and `IdeasToggles` components.
- New: `apps/web/src/lib/api/ideas.ts` — thin client over the work-proposals endpoints (mirrors `lib/api/work-agent.ts`).
- New: `apps/web/src/app/actions/dashboard/ideas.ts` — server actions for create/build/dismiss.

### 7.3 PRs

1. **PR M** — `refactor(web): extract IdeaCard from dashboard proposals (no behavior change)`.
2. **PR N** — `feat(web): /ideas page + sidebar item`.
3. **PR O** — `feat(web): dashboard Ideas block reshape (toggles, +Add, gears, View-all link)`.
4. **PR P** — `feat(web): Done filter chip on /ideas`.

### 7.4 Tests

- Snapshot tests for `IdeaCard` (before refactor vs after PR M — byte-identical).
- E2E: user opens `/ideas`, hits `+ Add`, sees new Idea in list; clicks Build; sees Building status; receives completion (mock the build pipeline).
- E2E: Auto-generate switch flips → preference is persisted → opening `/settings/work-agent` shows the same value.

### 7.5 Risks & rollback

- Dashboard block reshape risk if the existing component is heavily coupled. The PR M extraction de-risks this.

### 7.6 Definition of done

- `/ideas` page works end-to-end, Dashboard block matches spec §5.5 layout.

---

## 8. Phase 6 — Frontend: /missions, Mission detail page, Dashboard Missions block

### 8.1 What ships

> v3: the large prompt + Type switch at the top of `/missions` that v2 originally planned is **dropped** before shipping. That role moves to the unified `+ New` page (Phase 6.5). What stays on `/missions` is the Cards list, the small `+ New Mission` button top-right, and everything on the Mission detail page (`/missions/[id]`).

- New `/missions` page with a small **`+ New Mission`** button top-right (no large quick-add input). The button routes to `/new?type=mission` with the `Mission` chip pre-selected.
- New `/missions/[id]` Mission detail page: header (title, description, status, schedule), Schedule switch, per-Mission Auto-build switch, per-Mission Outstanding-Ideas cap, per-Mission guardrails overrides (using the extracted components from Phase 4), live run (using shared `<LiveRun />`), Ideas list scoped to this Mission, Works list scoped to this Mission, Pause/Resume/Complete/Delete/Run-now actions.
- New Dashboard Missions preview block (above Ideas block) — 3 Cards with live counters (Ideas/Works/Sites), `View all (N)` link, clock-icon on scheduled Missions.

### 8.2 Files

- New: `apps/web/src/app/[locale]/(dashboard)/missions/page.tsx`, `missions/[id]/page.tsx`.
- New: `apps/web/src/components/missions/MissionsPage.tsx`, `MissionCard.tsx`, `MissionDetailPage.tsx`, `MissionGuardrailsOverride.tsx` (no `MissionQuickAdd.tsx` — Phase 6.5 provides that role at the unified `+ New` page).
- New: `apps/web/src/lib/api/missions.ts`.
- New: `apps/web/src/app/actions/dashboard/missions.ts`.
- Touched: Dashboard page component — add Missions block above Ideas block.

### 8.3 Live counter mechanism

Use whichever mechanism the existing Live Run on the Work Agent settings page uses (poll or SSE — check Phase 4 extracted components). One mechanism across the whole product.

### 8.4 AI Chat integration for Mission create-flow

The create flow (regardless of which entry point — `+ New` page in Phase 6.5, `+ New Mission` button on `/missions`, or a direct chat verb in Phase 9) ends up in one path:

1. Caller posts the user's prompt into AI Chat as the user's first message.
2. AI Chat invokes the `missions.create` tool (Phase 9) with `{ instruction, type?, schedule?, missionTemplateRepo? }`.
3. Server: shared titler generates title; (Phase 8) optionally scaffolds Mission repo from Mission Template; persists Mission row; if `one-shot`, runs first tick.
4. Tool response includes the new Mission id; AI Chat client navigates Canvas to `/missions/<new-id>`.

One server-side create path; many client-side entry points feed into it.

### 8.5 PRs

1. **PR Q** — `feat(web): /missions page with Cards + small +New Mission button` (no large quick-add; that's Phase 6.5).
2. **PR R** — `feat(web): /missions/[id] detail page (header, overrides, live run, Ideas list, Works list)`.
3. **PR S** — `feat(web): Dashboard Missions block above Ideas block with live counters`.
4. **PR GG** (v6) — `feat(web): Mission detail page extras + Idea failure UI`. Adds:
   - **Activity timeline** component on `/missions/[id]` reading the event stream (ticks, generations, build outcomes, schedule changes, Pause/Resume). Renders as vertical timeline with month-based pagination. Reuses any existing event-stream UI primitives if present; otherwise builds from scratch.
   - **Spend-over-time chart** component on `/missions/[id]` rendering a small line chart of the Mission's monthly spend (current + previous 5 months) with the cap as horizontal reference. **Phase 7 must land first** (it owns the per-Mission spend query); PR GG depends on PR U from Phase 7.
   - **Related Works (inherited from source Mission)** read-only panel — visible only when `mission.sourceMissionId != null`. Lists source's Works via FK join, links to them but does NOT allow edits.
   - **Clone button** on Mission detail page header AND on Mission Cards' context menu (`/missions` page + Dashboard Missions block). Opens a small confirmation modal with the cloned title prefilled (editable); on confirm calls `POST /me/missions/:id/clone`.
   - **Idea failure inline error** on `WorkProposalCard` (or whatever the card component is in Phase 5) — when `idea.status='FAILED'`, renders `failure_message` (truncated, expandable) in a muted danger block below the title.
   - **Source-Mission backlink affordance** in the Mission detail page header — "Cloned from: [source title]" → click navigates to source Mission. Visible only when `mission.sourceMissionId != null`.
   - **Cloned-to count** on source Mission detail page header — "Cloned as: N other Mission(s)" → click opens a small popover listing the clones.

### 8.6 Tests

- E2E: create Mission via quick-add → see it in list → open detail → flip schedule → see schedule applied → trigger Run now → see Idea generated → see Idea built (mocked) → counters update.
- Snapshot: Dashboard layout matches spec §5.5.

### 8.7 Risks & rollback

- Live counter mechanism choice may not match — fall back to polling every 10s for the dashboard block if SSE adds complexity.

### 8.8 Definition of done

- `/missions` round-trip works; Dashboard layout matches §5.5; users can create, schedule, pause, complete, and delete Missions; all actions reachable from AI Chat (Phase 9). Mission creation via the small `+ New Mission` button routes correctly to the `+ New` page (Phase 6.5).

---

## 8b. Phase 6.5 — Unified `+ New` entry page at NEW route `/new`

### 8b.1 What ships

Spec §4.0. **Purely additive — `/works/new` is left exactly as it is today.** A new route `/new` is built fresh, reusing the same three-Work-creation-block component as `/works/new` but with a different label set.

- Sidebar item label: **`+ New Work` → `+ New`**, and the link href changes from `/works/new` to `/new`. (Direct URL navigation to `/works/new` continues to work for anyone with bookmarks or deep-links; only the sidebar entry-point destination moves.)
- New page `/new`:
  - `<h1>` text: "What do you want to build?".
  - Large prompt input at the top (textarea + paperclip + mic + arrow submit + char counter — modeled on the operator-supplied screenshot).
  - Chips row below the input in exact order: `Mission` · `Idea` · `Website` · `Landing Page` · `Blog` · `Directory` · `Awesome Repo`.
  - Three creation blocks below the chips, rendered by the shared block component with the `unified` label set: Create Work with AI · Create Work Manually · Import Existing Work. Click destinations identical to today's blocks on `/works/new`.
  - AI Chat sidebar is hidden on `/new` until the user submits the prompt. Use the existing chat-visibility mechanism (wherever the chat decides to render — likely a layout-level guard).
- `/works/new` page: **untouched.** Same `page.tsx`, same content, same labels, same flow. The three creation blocks there continue to render via the same shared component (now extracted) with the `work-only` label set (default — preserves today's output byte-for-byte).
- Submit handler on `/new`:
  - Posts prompt as the user's first message into AI Chat (re-using the chat's existing send-message client action).
  - If a chip is selected, includes a hint in the chat's tool-routing context: `Mission` → `missions.create`; `Idea` → `ideas.create`; Work-Type chip → existing Work create flow with that template hint.
  - If no chip is selected, the chat's normal intent-router decides (existing chat behavior — Phase 9 may add a small bias for Mission/Idea inference, but the chat already does this in some form).
  - Reveals the chat sidebar.
  - Navigates Canvas to the newly-created object once the tool response returns.

### 8b.2 Files

- **Extract first** — pull the three-Work-creation-block component out of the existing `apps/web/src/app/[locale]/(dashboard)/works/new/page.tsx` (or wherever the three blocks live today) into a new shared component, e.g. `apps/web/src/components/creation/CreationBlockTrio.tsx`. The component accepts `labelSet?: 'work-only' | 'unified'` (default `'work-only'`). With the default, render output must be **byte-identical** to today's `/works/new`. Snapshot-test before/after.
- Update `apps/web/src/app/[locale]/(dashboard)/works/new/page.tsx` to use `<CreationBlockTrio />` (no `labelSet` prop). **This is the only change to the existing file** — a refactor that does not change rendered output.
- Sidebar component — find via `rg '\\+ New Work' apps/web/src` (likely under `apps/web/src/components/Sidebar/*`). Change both the i18n key and the link href: now points to `/new`.
- New: `apps/web/src/app/[locale]/(dashboard)/new/page.tsx` — the brand-new `/new` route.
- New: `apps/web/src/components/new/UnifiedNewEntry.tsx` — the prompt + chips component used only on `/new`.
- Whatever component renders the AI Chat sidebar (find via `rg 'ChatSidebar|AiChatSidebar'`) — add a route-aware guard so it hides when `pathname === '/new'` AND the prompt hasn't been submitted yet (client-state flag scoped to `/new`). **No change to chat behavior on `/works/new` or anywhere else.**

### 8b.3 PRs

1. **PR CC1** — `refactor(web): extract CreationBlockTrio from /works/new (no behavior change)`. Snapshot test confirms `/works/new` output is byte-identical.
2. **PR CC2** — `feat(web): /new page (prompt + Mission/Idea/Work chips + three blocks, hide chat until submit)`.
3. **PR DD** — `chore(web): rename sidebar '+ New Work' to '+ New' and point at /new across all locales`.

### 8b.4 Tests

- Snapshot test on `/works/new` before vs after PR CC1 — must be byte-identical.
- E2E on `/works/new` (regression): clicking any of the three existing creation blocks (Create with AI / Create Manually / Import Existing) still works exactly as it did before; same labels, same destinations.
- E2E on `/new`: chat sidebar is hidden; type prompt, click `Mission` chip, submit; chat appears, Mission is created, Canvas opens `/missions/<id>`.
- E2E on `/new`: same as above with `Idea` chip → Idea created.
- E2E on `/new`: same as above with `Website` chip → existing Work create flow runs with the template hint.
- E2E on `/new`: no-chip submit with a short prompt ("blog about cats") → AI infers Work or Idea.
- E2E on `/new`: no-chip submit with an ambitious prompt ("run the best cats business worldwide") → AI infers Mission.
- Regression: sidebar `+ New` link navigates to `/new` (not `/works/new`).
- Regression: any other in-app surface that links to `/works/new` (the existing `/works/new` URL still resolves and renders).

### 8b.5 Risks & rollback

- The block-component extraction (PR CC1) is the riskiest piece — getting byte-identical output is non-negotiable per NN #20. Mitigated by snapshot test.
- AI Chat sidebar visibility guard scoped only to `/new` — no risk to chat on other routes.
- Chip → tool routing in the chat may need a small extension to the chat's intent router if it doesn't already accept hints. Confirm in Phase 9 prep.
- If chip detection logic depends on something not yet shipped (e.g. Mission tools from Phase 9), gate the new chips behind a feature flag so Phase 6.5 can ship before Phase 9 if needed.

### 8b.6 Definition of done

- Sidebar reads `+ New`; clicking opens `/new`; the page has the prompt + chips at top AND the three creation blocks below; AI Chat is hidden until submit; submit routes correctly to Mission/Idea/Work depending on chip+prompt.
- `/works/new` renders exactly as today (snapshot-verified). Existing links and bookmarks to `/works/new` continue to work.

---

## 9. Phase 7 — Budgets generalization

### 9.1 What ships

- `WorkBudget`, `UsageLedgerEntry`, `PluginUsageEvent`, `WorkBudgetAlertState` entities + their controllers extended with `ownerType + ownerId` (Phase 0 columns).
- `BudgetGuardService` extended to query by `ownerType + ownerId` with fallback to per-Work for back-compat.
- New API endpoints (or extensions of existing): `GET /me/missions/:id/budget`, `GET /me/work-proposals/:id/budget`, plus the global defaults under `/me/work-agent/preferences#budgets`.
- Web UI: Budget & Usage section on Mission detail page; spend indicator on Mission Card; spend indicator on Idea progress view; new Budgets sub-section on Work Agent settings page.

### 9.2 Roll-up policy

Read-time roll-up via FK joins (spec §8.2). Cache nothing in v1.

```
mission spend (this month)
  = SUM(usage where ownerType='mission' AND ownerId=:m)
  + SUM(usage where ownerType='idea' AND ideaId IN (SELECT id FROM work_proposals WHERE missionId=:m))
  + SUM(usage where ownerType='work' AND workId IN (SELECT acceptedWorkId FROM work_proposals WHERE missionId=:m))
```

(All three legs union; queries indexed by `(ownerType, ownerId)`.)

### 9.3 Files

- `packages/agent/src/entities/work-budget.entity.ts` + budgets-related siblings.
- `apps/api/src/budgets/budgets.controller.ts` + `usage.controller.ts` + `admin-usage.controller.ts` + `budget-alert.handler.ts`.
- Web: `apps/web/src/components/missions/MissionBudgetSection.tsx`, `apps/web/src/components/ideas/IdeaBudgetIndicator.tsx`, `apps/web/src/components/settings/WorkAgentBudgetsSection.tsx`.

### 9.4 PRs

1. **PR T** — `feat(api): polymorphic owner on budget + usage entities (back-compat preserved)`.
2. **PR U** — `feat(api): per-Idea + per-Mission budget query endpoints`.
3. **PR V** — `feat(web): Budget UI on Mission detail page + Idea progress view + settings page`.
4. **PR II** (v6) — `feat(api+web): account-wide spend roll-up + Dashboard Month Spend tile`. Adds:
   - API: `GET /me/usage/account-wide` returning `{ monthlyCents, capCents?, allowOverage, periodStart, periodEnd }`. Implementation reuses the `(ownerType, ownerId)` index from PR T but scopes by `userId` across all owner types.
   - Web: 6th Dashboard stat tile rendering `$X.XX / $Y.YY` (or just `$X.XX` if `capCents=null`). Small inline progress bar when capped. Click → scrolls to `/settings/work-agent#account-budgets`.
   - Update `getWorkStats()` server action to also return the account-wide spend OR fetch in parallel from the Dashboard page (implementer's call; parallel fetch is simpler if the existing action's caching makes adding fields awkward).

### 9.5 Tests

- Integration: existing per-Work guard still blocks at cap (back-compat).
- Integration: per-Mission cap blocks (when configured) regardless of per-Work cap not being hit.
- Unit: roll-up SQL returns correct sum for hand-crafted fixture.

### 9.6 Risks & rollback

- The polymorphic-owner change is the schema-riskiest of the v2 plan. Mitigated by keeping `workId` column intact for v1, and by the backfill `ownerType='work', ownerId=workId` so existing rows are immediately compatible.

### 9.7 Definition of done

- Existing per-Work budgets still enforce correctly; new per-Idea and per-Mission caps enforce and surface in UI.

---

## 10. Phase 8 — Mission Templates

### 10.1 What ships

- Templates page (`/templates`) gains a top-of-page **kind switch**: `Mission Templates` (default) ↔ `Work Templates`.
- Mission Template catalog backend: same shape as Work Templates, filtered by `kind`.
- Mission Template detection: by repo name suffix `-mission-template` (manifest schema deferred).
- Mission repo scaffolder: a new agent service that, given a Mission Template repo + new Mission slug, creates `<owner>/<slug>-mission` repo seeded from the Template. Uses the existing GitHub plugin (`packages/plugins/github`).
- "Use this Template" button on each Mission Template Card → routes to `/missions` with the chosen Template prefilled in the quick-add.

### 10.2 Files

- `apps/web/src/components/templates/TemplatesCatalog.tsx` — add `kindSwitch` UI; pass through the `kind` URL param.
- `apps/web/src/app/[locale]/(dashboard)/templates/page.tsx` — accept `?kind=mission` (default) or `?kind=work`.
- `apps/api/src/templates/*` (or wherever Work Templates catalog logic lives — find via grep on `directory-web-template`) — extend to filter by `kind`.
- New: `apps/api/src/missions/mission-repo-scaffolder.service.ts` — creates the per-Mission repo. Uses `packages/plugins/github`.

### 10.3 Mission Template manifest

Deferred. v1 ships with naming-convention detection only (suffix `-mission-template`).

### 10.4 PRs

1. **PR W** — `feat(web): kind-switch on TemplatesCatalog (Mission default, Work secondary)`.
2. **PR X** — `feat(api): Mission Templates catalog filter + per-Mission repo scaffolder`.
3. **PR Y** — `feat(web): Use-this-Template button → /missions quick-add prefill`.
4. **PR JJ** (v6) — `feat(api): MissionTemplateManifestService — parse .works/mission.yml`. Adds:
   - `MissionTemplateManifestService` under `apps/api/src/mission-templates/` (or `packages/agent/src/mission-templates/` — pick whichever side already owns Work Template manifests if any, otherwise API side).
   - Reads `.works/mission.yml` from the template repo at template-ingest time (when a user adds a custom Mission Template OR when the catalog refresh job runs). Uses the GitHub provider to fetch the file contents.
   - Parses YAML with `yaml` package (already in monorepo, check `pnpm-lock.yaml`). Validates with Zod against the schema in spec §7.5.
   - Returns `{ valid: true, manifest } | { valid: false, errors }`. On parse failure the catalog UI shows the error inline on the template card.
   - **Integrates with PR X scaffolder**: when the user creates a Mission from a template, the scaffolder:
     1. Reads the manifest (if present).
     2. Copies `kb.seedPaths` directories from template repo → new Mission repo (recursive).
     3. Applies `defaults.*` to the new Mission row (type, cadence, outstandingIdeasCap, autoBuildWorks, guardrailsOverride, budget overrides) — overridable by user input at create-time.
     4. Passes `recommendedWorkTemplates` to the Mission tick worker (Phase 3 PR J) as an advisory list — when the tick generates Ideas, the Idea→Work scaffolder biases template selection toward this list. Advisory only; user can override per-Work.
   - Forward-compat: unknown top-level keys in the manifest emit a single log warning and are ignored. New top-level keys can ship in schema v2 without breaking v1 parsers.

### 10.5 Tests

- E2E: pick a Mission Template → kick off Mission → verify per-Mission repo is created in the test org.
- Unit: scaffolder handles repo-name collisions (append `-2`, `-3`).

### 10.6 Risks & rollback

- Repo creation hits GitHub rate limits — reuse the existing rate-limit handling in `packages/plugins/github`.
- Naming-convention detection is loose; manifest schema in follow-up locks this down.

### 10.7 Definition of done

- Templates page defaults to Mission Templates; selecting one creates the Mission repo correctly; the Mission tick worker reads from the Mission repo when generating Ideas.

---

## 11. Phase 9 — AI Chat tool registrations (TWO surfaces)

Per Decision A5: the platform has two distinct chat-tool surfaces. Both ship in Phase 9, in two parallel-mergeable PRs.

### 11.1 What ships

Tool definitions for everything the user must be able to do via chat (spec §3.8 and §4.5), exposed on BOTH:

- **In-app AI Chat** (web app at `app.ever.works`) — Vercel AI SDK `tool()` definitions, passed model-side via the OpenAI-compat endpoint (Decision A6).
- **MCP server** (`apps/mcp/`) — external clients (Claude Desktop, Cursor, Claude Code, any MCP client) — auto-derived from the API's OpenAPI spec via the WHITELIST mechanism (Decision A5).

### 11.2 Tools

For Ideas:
- `ideas.list`, `ideas.create`, `ideas.build`, `ideas.dismiss`, `ideas.suggestMore`, `ideas.setAutoBuild`, `ideas.setAutoGenerate`, `ideas.listDone`.

For Missions:
- `missions.list`, `missions.create`, `missions.pause`, `missions.resume`, `missions.complete`, `missions.delete`, `missions.runNow`, `missions.setSchedule`, `missions.setAutoBuild`, `missions.setCap`, `missions.listIdeas`, `missions.listWorks`.

Each tool is a thin wrapper around the existing REST controllers — **no new business logic**. New controllers from Phases 1, 3, 7, 8 must keep their `@ApiOperation` + `@ApiTags` decorators so MCP auto-derivation works (Decision A19).

### 11.3 PR Z1 — web-side tools

**Files:**
- `apps/web/src/lib/ai/tools/ideas.tools.ts` (NEW)
- `apps/web/src/lib/ai/tools/missions.tools.ts` (NEW)
- Wherever the in-app chat surface assembles its `tools` array (find by following from `apps/web/src/lib/ai/tools/suggest.tools.ts` to its caller — likely an `ai/index.ts` or per-page chat-provider component) — add the new tool factories to that assembly.
- `apps/web/src/lib/api/ideas.ts`, `apps/web/src/lib/api/missions.ts` — thin REST clients (already added in Phases 5 and 6 — reuse here).

**Pattern (copy from `suggest.tools.ts`):**

```ts
import { tool } from 'ai';
import { z } from 'zod';
import { missionsAPI } from '@/lib/api/missions';

export const createMission = tool({
  description: 'Create a new Mission from a Goal/Project description...',
  inputSchema: z.object({
    instruction: z.string().min(10),
    type: z.enum(['one-shot', 'scheduled']).default('one-shot'),
    schedule: z.string().optional(),
  }),
  execute: async ({ instruction, type, schedule }) => {
    return missionsAPI.create({ instruction, type, schedule });
  },
});
```

Repeat for every verb in §11.2.

### 11.4 PR Z2 — MCP whitelist

**Files:**
- `apps/mcp/src/openapi-tools/whitelist.ts` — append WHITELIST entries for every new endpoint added in Phases 1, 3, 7, 8.
- Verify by reading `apps/mcp/src/openapi-tools/tool-registration.service.ts:20–58` that the registration loop picks them up.

**Pattern (existing entries in `whitelist.ts` are the template):**

```ts
{ method: 'POST', path: '/api/me/missions', toolName: 'missions.create', description: '...' },
{ method: 'POST', path: '/api/me/missions/:id/run-now', toolName: 'missions.runNow', description: '...' },
// ...one entry per verb
```

The actual MCP tool name + description + parameter schema are auto-derived from the OpenAPI spec (Swagger decorators on the controllers). The whitelist entry just gates which endpoints become MCP-exposed.

### 11.5 PRs

1. **PR Z1** — `feat(web): in-app AI Chat tools for Missions + extended Ideas`.
2. **PR Z2** — `feat(mcp): WHITELIST entries for Missions + Ideas endpoints`.

Z1 and Z2 are independent and can land in either order.

### 11.6 Tests

- PR Z1: per-tool unit test (Vitest) — given input schema, tool calls the right `missionsAPI.X()` and returns the response. Use mocked API client.
- PR Z1: one E2E (Playwright) that drives a real chat session and asserts a Mission gets created from a chat prompt.
- PR Z2: integration test — start the MCP server, list tools, assert every Mission + Idea verb is present.

### 11.7 Definition of done

- Spec §3.8 and §4.5 chat verbs all work in:
  - the in-app AI Chat (web app) — PR Z1
  - the MCP server (verified via an external client like Claude Desktop, or a stub MCP client in the integration test) — PR Z2

---

## 12. Phase 10 — Localization sweep

### 12.1 What ships

Translations for every new string introduced by Phases 2–9, in every locale present in `apps/web/messages/`.

### 12.2 Process

- Generate a string-export of all newly-added keys (Phase 2 already did the renames; this phase covers the bigger surface).
- Hand the export to translators (recommend professional translation, MT acceptable for v2 ship with follow-up patches).
- One PR per locale (or one bundled PR with all locales) — translator's preference.

### 12.3 Definition of done

- No untranslated strings on any of `/missions`, `/missions/[id]`, `/ideas`, Dashboard, or Settings.

---

## 13. Phase 11 — Docs ship + sign-off

### 13.1 What ships

- The end-user documentation lifted into `docs/features/` as four pages: [Missions](../../../features/missions.md), [Ideas](../../../features/ideas.md), [Mission Templates](../../../features/mission-templates.md), [Budgets & Usage](../../../features/budgets-and-usage.md); `docs/features/index.md` updated to list them.
- Spec doc (this directory) referenced from `docs/specs/features/missions-ideas-works/spec.md` + this PLAN as `plan.md`.
- Sign-off checklist (spec §13) actually walked.

### 13.2 PRs

1. **PR AA** — `docs: end-user pages for Missions, Ideas, Mission Templates, Budgets`.
2. **PR BB** — `docs(specs): link Missions-Ideas-Works spec + plan under docs/specs/features/`.

### 13.3 Definition of done

- docs.ever.works renders all new pages; spec sign-off complete.

---

## 14. Cross-cutting concerns

### 14.1 Per-PR conventions (repeat from workspace rules)

- Worktree per session: `git worktree add ../wt-<id> -b session/<id> origin/develop` from each repo root (NN #10).
- TypeORM entity ↔ migration in same PR (NN #16).
- After `gh pr create`, poll for bot reviews and CI until clean (NN #14, NN #18, NN #19).

### 14.2 Feature flag

Wrap the new sidebar items (`/missions`, `/ideas`) and the Dashboard Missions block in a single feature flag (`feature.missions_v2` or similar) so we can ship the backend phases without exposing user-visible surfaces until the frontend phases are merged + smoke-tested on stage.

### 14.3 Phase parallelization

- **Sequential**: 0 → 1 → 2 → 3 → 4. Phase 0's migrations gate everything.
- **Parallel** (after Phase 4): Phase 5 (Ideas page) and Phase 6 (Missions pages) can be developed concurrently by different engineers. Phase 7 (Budgets) and Phase 8 (Templates) are independent; can be parallel to 5/6.
- **Sequential** at the end: Phase 9 (chat tools) after at least one of 5/6 lands. Phase 10 (locales) and Phase 11 (docs) at the very end.

### 14.4 Rollback strategy

- Each phase is independently revertible up to its merge point.
- Schema migrations (Phase 0) are forward-only once Phase 1+ code reads the new columns — treat any rollback need as a forward-fix migration.
- Feature flag (§14.2) is the rollback for user-visible surfaces.

### 14.5 Out-of-scope reminders

See [spec §11](spec.md#11-out-of-scope-v2) for what we are NOT doing in v2.

---

## 15. PR checklist (one-line summary)

| # | PR | Phase | Brief |
|---|---|---|---|
| A | feat(api): extend WorkProposal statuses/sources + missionId | 1 | Entity + service updates |
| B | feat(api): user-manual Idea create + build-from-Idea endpoint | 1 | New REST endpoints |
| C | feat(api): proposal generator excludes existing + accepts missionContext | 1 | Generator extension |
| D | feat(api): promote four work-agent constants to user settings | 1 | Cadence / batch / throttle / Mission cap |
| FF | feat(api): retry + rebuild Idea endpoints + auto-retry handler | 1 | POST /retry + /rebuild; transient classifier + backoff loop |
| E | feat(web): i18n renames (Ideas/Works/Build/Suggest more) | 2 | Every locale |
| F | feat(api+web): Total Missions + Total Ideas dashboard tiles | 2 | Stats reorder |
| G | feat(api): Mission entity + migration | 3 | Schema |
| H | feat(api): MissionsModule CRUD + lifecycle endpoints | 3 | Controller/service/DTOs |
| I | feat(api): shared titler service | 3 | One AI call, four sites |
| J | feat(api): mission tick worker | 3 | Cron + handler |
| HH | feat(api): Mission Clone endpoint + cloning service | 3 | Full Fork: metadata + repo snapshot + Idea fan-out + sourceMissionId FK |
| K | refactor(web): extract shared work-agent components | 4 | LiveRun / LogList / pills / fields |
| L | feat(web): anchors + promoted-constant fields on work-agent settings | 4 | Deep-link targets + new fields |
| EE | feat(web): Auto-retry + Account-wide budgets sub-sections | 4 | Two new sub-sections, anchored for deep-link |
| M | refactor(web): extract IdeaCard from dashboard proposals | 5 | No behavior change |
| N | feat(web): /ideas page + sidebar item | 5 | Full Ideas page |
| O | feat(web): Dashboard Ideas block reshape | 5 | Toggles / +Add / gears / View-all |
| P | feat(web): Done filter chip on /ideas | 5 | Surface hidden Ideas |
| Q | feat(web): /missions page with Cards + small +New Mission button | 6 | List only — no large quick-add |
| R | feat(web): /missions/[id] detail page | 6 | Header / overrides / live run / lists |
| S | feat(web): Dashboard Missions block above Ideas | 6 | 3 cards + live counters |
| GG | feat(web): Mission detail page extras + Idea failure UI | 6 | Timeline + spend chart + Clone button + Related Works + inline failure msg |
| CC1 | refactor(web): extract CreationBlockTrio from /works/new | 6.5 | Snapshot-verified byte-identical; enables reuse on /new |
| CC2 | feat(web): NEW /new page (prompt + Mission/Idea/Work chips + three blocks + hide chat) | 6.5 | Brand-new route, brand-new page; /works/new untouched |
| DD | chore(web): rename sidebar `+ New Work` → `+ New` AND point href at /new | 6.5 | Label + href change |
| T | feat(api): polymorphic owner on budget + usage entities | 7 | Phase 0 columns wired |
| U | feat(api): per-Idea + per-Mission budget endpoints | 7 | Query + alerts |
| V | feat(web): Budget UI on Mission detail + Idea progress + settings | 7 | Three surfaces |
| II | feat(api+web): account-wide spend roll-up + Dashboard Month Spend tile | 7 | 6th stat tile; reuses (ownerType, ownerId) index |
| W | feat(web): kind-switch on TemplatesCatalog | 8 | Mission Templates default |
| X | feat(api): Mission Templates catalog + Mission repo scaffolder | 8 | GitHub plugin reuse |
| Y | feat(web): Use-this-Template → /missions prefill | 8 | One-click start |
| JJ | feat(api): MissionTemplateManifestService — parse .works/mission.yml | 8 | Zod-validated; integrates with PR X scaffolder; honors defaults + KB seed + recommended Work Templates |
| Z1 | feat(web): in-app AI Chat tools for Missions + extended Ideas | 9 | Vercel AI SDK tool() defs under apps/web/src/lib/ai/tools/ |
| Z2 | feat(mcp): WHITELIST entries for Missions + Ideas endpoints | 9 | apps/mcp/src/openapi-tools/whitelist.ts; auto-derives from @ApiOperation |
| AA | docs: end-user pages for Missions, Ideas, Mission Templates, Budgets | 11 | Lift from user-docs file |
| BB | docs(specs): link spec + plan under docs/specs/features/ | 11 | Cross-link |

---

## 16. What this plan deliberately does NOT do

- **Does not remove the Work Agent settings page.** Sections 3, 4, 5 stay verbatim. They get small "see this in the new view →" links, nothing else. (Spec §6.5.)
- **Does not drop the `workId` column on `work_budgets` or siblings.** v2 keeps it; future cleanup is a separate spec.
- **Does not couple Mission counts to a cache layer.** Simple `COUNT(*)`. (Spec §5.1.)
- **Does not gate budgets to subscription tiers.** Voluntary caps only in v2. (Spec §8.5.)
- **Does not finalize the Mission Template manifest schema.** Naming-convention detection only in Phase 8; manifest in a follow-up spec.
- **(v3, refined v4) Does not modify `/works/new`** at all. The three existing creation blocks there (Create with AI / Create Manually / Import Existing) keep their existing labels, their existing destinations, and their existing position. The only Phase 6.5 touch to that file is a pure refactor (extract the block component into a shared one), snapshot-verified byte-identical. The new prompt + chips + renamed-label blocks live entirely on the NEW `/new` page.
- **(v3) Does not remove the `+ Add` button on `/ideas` page or the Dashboard Ideas block.** Stays inline as the fastest path for atomic Ideas. (Spec §3.4, §4.0.6.)
- **(v3) Does not remove the `+ New Mission` button on `/missions` page.** Stays top-right as one of the additional paths to create a Mission. (Spec §4.1.)
- **(v3, corrected v4) Does not change or remove the URL `/works/new`.** That route stays exactly as it is, rendering exactly what it does today. What changes: the sidebar `+ New Work` button is renamed `+ New` AND repointed to the NEW route `/new`. The old `/works/new` URL continues to resolve and render for anyone who navigates to it directly, via bookmark, or via any internal link that still uses it.
- **(v3) Does not replace any existing path with the unified `+ New` page.** It is the one main path; every existing entry point coexists with it. Enforced by [NN #20](file:///C:/Coding/Workspace/AGENTS.md).
- **(v6) Does not auto-delete the original Work when a DONE Idea is re-built.** PR FF's `/rebuild` endpoint creates a NEW Work and re-points `acceptedWorkId`. The original Work stays in the user's account — they decide whether to keep, repurpose, or manually delete it. (Decision A27.)
- **(v6) Does not clone the source Mission's Works during Mission Clone.** Works remain owned by the source Mission only; the cloned Mission gets a `sourceMissionId` FK + a read-only "Related Works (inherited)" UI panel. The source Mission's Works are NOT duplicated as new Works. (Decision A25.)
- **(v6) Does not expose the transient-error classifier to users.** `maxAutoRetries`/`backoffSeconds`/`exponentialBackoffFactor` are user-configurable; the list of error categories that count as "transient" is platform-maintained in code. Implementers MUST NOT add a "configure which errors to retry" UI without a separate spec. (Decision A23.)
- **(v6) Does not version the manifest in v1.** `.works/mission.yml` schema v1 has no `schemaVersion` field. Future v2 features add the field; v1 manifests stay forever-valid. Do not add unknown-key strictness to the parser — unknown top-level keys are intentionally tolerated for forward-compat. (Decision A22.)

If the implementer finds themselves about to do any of the above, stop and re-read this section. The hard rule from the spec header applies: **extension only, never replacement.**
