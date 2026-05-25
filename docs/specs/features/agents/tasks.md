# Task Breakdown: Agents

**Feature ID**: `agents`
**Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-05-25

---

## How to use

Tasks are grouped into phases mirroring [plan.md §10](./plan.md#10-phased-rollout). Tasks within a phase are sequential unless marked `(parallel)`. File paths are absolute under the platform repo root. Mark tasks `- [x]` when the matching commit is on `develop` or its session branch.

Phases 1-3 land MVP (Agent entity + Instructions tab + heartbeat runtime). Phases 4-6 round out dashboards, task-driven runtime, and Mission Template integration.

---

## Phase 1 — Data model + read-only API

- [ ] **T1**. Create entity file `packages/agent/src/entities/agent.entity.ts` per [plan.md §3.1](./plan.md#31-new-entities).
- [ ] **T2** (parallel). Create entity file `packages/agent/src/entities/agent-run.entity.ts`.
- [ ] **T3** (parallel). Create entity file `packages/agent/src/entities/agent-run-log.entity.ts`.
- [ ] **T4** (parallel). Create entity file `packages/agent/src/entities/agent-budget.entity.ts`.
- [ ] **T5** (parallel). Create entity file `packages/agent/src/entities/agent-membership.entity.ts`.
- [ ] **T6**. Register the new entities in `packages/agent/src/entities/index.ts` and in the TypeORM datasource at `apps/api/src/typeorm.config.ts`.
- [ ] **T7**. Generate migration: `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateAgentsTables`. Inspect the generated SQL; replace any destructive `ALTER`/`DROP` with the two-phase forward-only pattern per `docs/specs/architecture/database-migrations.md`.
- [ ] **T8**. Add `agentId` column + index to `packages/agent/src/entities/plugin-usage-event.entity.ts` (nullable). Migration: `AddAgentIdToPluginUsageEvents`.
- [ ] **T9**. Extend `ActivityActionType` enum/string set with the 13 new event types listed in [architecture §10](../../architecture/agents-skills-tasks.md). Update the API's activity-feed group-filter mapping in `apps/api/src/activity-log/activity-log.controller.ts`.
- [ ] **T10**. Create repository `packages/agent/src/database/repositories/agent.repository.ts` with `findById`, `findByUserIdScoped`, `findByUserIdAndSlug`, `findDueForHeartbeat`, `casUpdateStatus(id, from, to)`, `incrementErrorCount`. **Test**: `packages/agent/src/database/repositories/__tests__/agent.repository.spec.ts`.
- [ ] **T11**. Create repositories for AgentRun, AgentRunLog, AgentBudget, AgentMembership. Same pattern. Tests per file.
- [ ] **T12**. Create DTO files under `apps/api/src/agents/dto/`: `create-agent.dto.ts`, `update-agent.dto.ts`, `list-agents-query.dto.ts`, `agent-response.dto.ts`. Use `class-validator` + zod for cross-field rules (scope ⇔ targetId consistency).
- [ ] **T13**. Create `apps/api/src/agents/agent.service.ts` with methods: `create`, `findOne`, `update`, `archive`, `list`, `validateScopeOwnership`. Cross-user reads return 404. **Test**: `apps/api/src/agents/__tests__/agent.service.spec.ts`.
- [ ] **T14**. Create `apps/api/src/agents/agent.controller.ts` covering routes in [plan.md §4 Phase-1 subset](./plan.md#4-api-surface) (GET, POST, PATCH, DELETE, list, pause/resume but no run-now yet). Use `@CurrentUser()` from existing auth module. **Test**: e2e in `apps/api/test/agents.e2e-spec.ts`.
- [ ] **T15**. Wire `AgentsModule` into `apps/api/src/app.module.ts`.
- [ ] **T16**. Extend `packages/agent/src/works-config/services/works-config.service.ts` Zod schema with optional `agents` + `skills` arrays. Round-trip read/write test.
- [ ] **T17**. Extend `packages/agent/src/missions/mission-template-manifest.service.ts` Zod schema same way. Round-trip test.
- [ ] **T18**. Add i18n keys per [spec.md §5.1](./spec.md#51-sidebar-i18n-keys-additive) to `apps/web/messages/en.json`. Run `pnpm translate:messages` to populate other locales.
- [ ] **T19**. Patch `apps/web/src/components/dashboard/DashboardSidebar.tsx` to insert "Agents", "Tasks", "Skills" items in the correct order with lucide-react icons. Don't wire Tasks/Skills routes yet (Phase 1 only).
- [ ] **T20**. Create the empty-state page `apps/web/src/app/[locale]/(dashboard)/agents/page.tsx` (server component) with `+ New Agent` CTA wired to `/agents/new`.

## Phase 2 — File storage + Instructions tab

- [ ] **T21**. Create `apps/api/src/agents/agent-file.service.ts`. Methods: `read(agentId, name)`, `write(agentId, name, body, commitMessage)`. Branches by scope: Git mode via `GitFacadeService` for Mission/Work-scoped; DB inline for Tenant-scoped (writes the matching `agent.{soulMd,agentsMd,heartbeatMd,toolsMd,agentYml}` column).
- [ ] **T22**. Add secret-scan regex helper `packages/agent/src/utils/secret-scan.ts` and unit test. Reject on `sk-`, `xoxb-`, `AKIA[A-Z0-9]{16,}`, `ghp_[A-Za-z0-9]{36,}`, `glpat-...`.
- [ ] **T23**. Add controller routes `GET /agents/:id/files/:name` and `PUT /agents/:id/files/:name`. Validate `name` against `['SOUL', 'AGENTS', 'HEARTBEAT', 'TOOLS', 'agent.yml']`. **Test**: e2e read/write cycle for both Git and DB-inline modes.
- [ ] **T24**. Update `agents.contentHash` on every `write`. Hash is sha256 of the 5-file canonical concatenation.
- [ ] **T25**. Add `AGENT_FILE_EDITED` activity row on every successful write; include `details: {name, prevHash, newHash, diff?}` (truncate diff to 5 KB).
- [ ] **T26**. Build the `/agents/[id]/instructions` page using the existing `KbEditor.tsx` Tiptap component, but with a 5-tab strip on top (one tab per file). 800 ms autosave debounce.
- [ ] **T27**. Add `apps/web/src/lib/api/agents.ts` API client wrappers.
- [ ] **T28**. Playwright test: create Mission-scoped agent → edit SOUL.md → verify commit landed on the Mission's `missionRepo` via the GitHub API mock used in other e2e tests.

## Phase 3 — Runtime

- [ ] **T29**. Create `packages/tasks/src/tasks/trigger/agent-heartbeat-dispatcher.task.ts`. Cron: `*/${AGENT_DISPATCH_INTERVAL_MINUTES} * * * *` (default 1m). Same shape as `work-schedule-dispatcher.task.ts`.
- [ ] **T30**. Implement `AgentScheduleDispatcherService.dispatchDue()` in `packages/agent/src/agents/agent-schedule-dispatcher.service.ts`. CAS-claim via `repo.casUpdateStatus(agentId, ACTIVE, RUNNING)`; on success insert `agent_runs` row + `runs.trigger('agent-heartbeat', ...)`. **Test**: race two concurrent calls, expect exactly one to claim.
- [ ] **T31**. Create `packages/tasks/src/tasks/trigger/agent-heartbeat.task.ts` (one-shot, `maxDuration: 30 * 60`). Bootstrap NestJS via the existing helper, then call `AgentRunService.execute({agentId, runId, kind: 'heartbeat'})`.
- [ ] **T32**. Implement `AgentRunService.execute()` in `packages/agent/src/agents/agent-run.service.ts`. Phases: load context → assemble prompt → resolve provider → enforce budget → AI call → handle response (file edits, task creates) → write summary → emit activity. **Test**: unit-test each phase with mocked facade.
- [ ] **T33**. Extend `BaseFacadeService.resolvePlugin` to accept an `agentId` hint that resolves via `agent.aiProviderId` → existing cascade. Default the call sites that don't pass `agentId` to current behavior. **Test**: facade unit tests get an additional `agentId` case.
- [ ] **T34**. Extend `BudgetGuardService` to accept `ownerType: 'work' | 'agent'`. Reuses the polymorphic-owner SQL already in `WorkBudgetRepository`. Add `AgentBudgetRepository.findByAgentId` and `aggregateSpend(agentId, intervalStart)`.
- [ ] **T35**. Wire `AgentRunService` into the internal RPC channel — add it to the `createRemoteProxy(client, 'AgentRunService')` proxy table in `apps/api/src/trigger/trigger-internal.controller.ts`.
- [ ] **T36**. Add `POST /agents/:id/run-now` controller action. Validates the agent is `active` (or `draft` and user opted in), inserts an `agent_runs` row, calls `runs.trigger`. Returns the runId. Rate-limit 5 RPM/user.
- [ ] **T37**. Add `POST /agents/:id/runs/:runId/cancel` → calls `runs.cancel(triggerRunId)` (same as `cancel work generation` flow). Writes `agent_runs.status='cancelled'`.
- [ ] **T38**. Playwright test: create active agent with `manual` heartbeat → press "Run heartbeat now" → poll until `agent_runs` row reaches `completed`.
- [ ] **T39**. Add `pauseAfterFailures` auto-pause: after `errorCount >= pauseAfterFailures`, status → `error` and `AGENT_PAUSED` activity row emitted.
- [ ] **T40**. Add budget-block path: when `BudgetGuardService` returns block, set `agent_runs.errorMessage='Budget exceeded'`, status='failed', emit `AGENT_BUDGET_EXCEEDED`.

## Phase 4 — Dashboards, surfaces

- [ ] **T41**. Build `/agents/[id]/dashboard` page. Components:
    - `LiveStatusCard.tsx` — current status + in-flight run row + cancel button.
    - `RunActivityChart.tsx` — 30-day bar chart of run counts. Reuse Recharts (already a dep — check `package.json`); if not present, follow [data-management spec](../data-management/spec.md) for chart library decision.
    - `TasksByPriorityChart.tsx` — stacked column.
    - `RecentTasksList.tsx` — 5 rows.
    - `CostSnapshotCard.tsx` — current-interval spend, headroom, reset time.
- [ ] **T42**. Build `/agents/[id]/activity` page — reuse `ActivityFeedClient.tsx` with a `filter={agentId}` prop addition.
- [ ] **T43**. Build `/agents/[id]/budgets` page. Form: intervalUnit dropdown, capCents number input, overage toggle, save button. Histogram of last 30 days from `plugin_usage_events`.
- [ ] **T44**. Build `/agents/[id]/settings` page. Forms: provider+model pickers, cadence (cron or "manual" radio), `pauseAfterFailures` number, permissions toggle grid (8 toggles), "Archive Agent" with typed confirmation.
- [ ] **T45**. Build the create-Agent page `/agents/new` reusing form primitives from Work creation.
- [ ] **T46**. Build the list page Cards + Table views. Default: Cards. Toggle stored in `localStorage` as `agents-view-mode`. Filter chips: All/Active/Paused/Error. Scope filter dropdown.
- [ ] **T47**. Add per-target tabs:
    - Patch `apps/web/src/components/works/detail/WorkTabs.tsx` — add "Agents", "Skills", "Tasks" (order: after Plugins, before Deploy).
    - Patch the Mission detail tab strip (path in the missions-ideas-works PR landing on develop) — add the same three.
    - Patch the Idea detail tab strip — add "Agents", "Tasks".
- [ ] **T48**. Build the per-target Agents tab listing (works/missions/ideas) — minor variant of `/agents` list filtered by scope+target.
- [ ] **T49**. Dashboard tiles:
    - `apps/web/src/components/dashboard/AgentsCountTile.tsx` — count of `status='active'` agents.
    - `apps/web/src/components/dashboard/TasksInProgressTile.tsx` — counts.
    - Add to the tile row in the existing dashboard layout (additive).
- [ ] **T50**. Recent Tasks list block on the main dashboard page — below the existing "Recent Works" block.

## Phase 5 — Task-driven runtime

> Depends on [task-tracking Phase 1](../task-tracking/tasks.md) (`tasks` table exists).

- [ ] **T51**. Create `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` (one-shot, `maxDuration: 60 * 60`). Calls `AgentRunService.execute({kind: 'task', taskId})`.
- [ ] **T52**. Create `packages/tasks/src/tasks/trigger/agent-chat-reply.task.ts` (one-shot, `maxDuration: 5 * 60`). Calls `AgentRunService.execute({kind: 'chat', chatMessageId})`.
- [ ] **T53**. Tool: `createTask` — exposed via the existing tool-loop helper (agent-pipeline plugin pattern). Validates `permissions.canAssignTasks`. Returns `{taskId}` or a structured error.
- [ ] **T54**. Tool: `commentOnTask` — validates the agent is assignee/reviewer/approver. Returns `{messageId}`.
- [ ] **T55**. Tool: `editAgentFile` — validates path under own subtree + `permissions.canEditAgentFiles`. Routes through `AgentFileService`.
- [ ] **T56**. Tool: `commitToRepo` — validates `permissions.canCommitToRepo`. Routes through `GitFacadeService.commit()`.
- [ ] **T57**. Tool: `createSubAgent` — validates `permissions.canCreateAgents` + scope cascade.
- [ ] **T58**. Add `agent-task-execute` dispatch hook on `tasks` status transitions: when a Task moves to `in_progress` and an assignee is an Agent, dispatch.
- [ ] **T59**. Add `agent-chat-reply` dispatch hook on `task_chat_messages` insert: when the body matches `@<agent-slug>` and the agent is on the task, dispatch.
- [ ] **T60**. Playwright e2e: human posts `@ceo plan this` → CEO Agent's reply lands within 30 s.

## Phase 6 — Mission Template integration

- [ ] **T61**. Extend the Mission scaffolder (location landed on develop with PR JJ) to also copy `.works/agents/` and `.works/skills/` from the template repo into the new `<slug>-mission` repo via `GitFacadeService`.
- [ ] **T62**. Insert matching `agents` + `skills` rows (status=`draft`) using the template's `.works/mission.yml` `agents`/`skills` arrays.
- [ ] **T63**. Playwright e2e: instantiate a Mission Template that declares 2 agents → 2 `draft` agents appear in `/missions/[id]/agents`; their MD files are present in the new mission repo.
- [ ] **T64**. Add a sample Mission Template (e.g. `ever-works/p2p-marketplace-mission-template`) with a CEO + VP-Engineering agent under `.works/agents/` and a `pr-review` skill under `.works/skills/`. Smoke-test instantiation.

## Phase 7 — Account-transfer (Export / Import / GitHub Sync) extension

> Per [ADR-008 §"v1 REQUIREMENT — extend existing Import / Export / Sync surfaces"](../../decisions/008-tenant-control-repo-deferred-to-v2.md). Tenant-scoped Agents must round-trip through the existing `packages/agent/src/account-transfer/` flow so users on the SaaS can already back up / migrate / Git-sync their Agents in v1, ahead of the dedicated tenant-control-repo feature in v2.

- [ ] **T70**. Extend `packages/agent/src/account-transfer/types.ts` with `ExportedAgent` (id, slug, scope, name, title, capabilities, aiProviderId, modelId, permissions, heartbeatCadence, MD-files inline body, `agentBudget` nested, `memberships`). Tenant-scoped agents only (Mission/Idea/Work-scoped agents live in their owning repos already).
- [ ] **T71**. Inject `AgentRepository` / `AgentBudgetRepository` / `AgentMembershipRepository` into `AccountExportService` constructor.
- [ ] **T72**. Implement `AccountExportService.exportAgents(userId, options)` returning `ExportedAgent[]`. Apply the existing `maskSecretSettings` posture to any secret-bearing metadata.
- [ ] **T73**. Add `agents: ExportedAgent[]` to `AccountExportPayload`. Bump payload version (`version: 2`) per the existing versioning posture.
- [ ] **T74**. Implement `AccountImportService` agents handler — create-or-update by `(userId, scope, slug)` UNIQUE key. Honor the existing conflict-resolution UI (skip / overwrite / merge).
- [ ] **T75**. Update `GitHubSyncService` synced layout: write tenant agents to `agents/<slug>/agent.yml` + the 5 MD files + `agent.yml` inside the `ever-works-config` repo. Reads pull them back.
- [ ] **T76**. Add UI affordance on `/settings/import-export` page: "Include Agents in export" checkbox (default ON for export, default ON for sync). Same shape as existing "Include works" toggles.
- [ ] **T77**. Activity-log events `AGENT_EXPORTED`, `AGENT_IMPORTED`, `AGENT_SYNCED` emitted via the existing event chain.
- [ ] **T78**. Round-trip Playwright test: create tenant Agent → export → reset DB → import → verify Agent state restored byte-for-byte (sans secrets).

## Phase 8 — Default-on rollout

- [ ] **T65**. Wire `FEATURE_AGENTS` env flag. When off, the sidebar items + tabs are hidden. When on, full surface visible.
- [ ] **T66**. Verify the new migrations apply cleanly on a staging DB snapshot.
- [ ] **T67**. Beta-test with internal users for ≥3 days; gather budget-spike incidents and runaway-loop reports.
- [ ] **T68**. Flip `FEATURE_AGENTS` default to `true`.
- [ ] **T69**. Update [`built-in-plugins.md`](../../../docs/plugin-system/built-in-plugins.md) reference list (no new plugins, but mention the reserved `task-tracker` interface).

## Definition of Done

- [ ] All Phase 1-6 task checkboxes ticked.
- [ ] `pnpm test` green across `apps/api`, `packages/agent`, `packages/tasks`, `packages/plugin`, `apps/web`.
- [ ] `pnpm lint` + `pnpm type-check` green.
- [ ] No `synchronize: true` introduced anywhere.
- [ ] Migration applied + reversible on staging.
- [ ] Constitution checks in [spec.md §9](./spec.md#9-constitution-gates) confirmed.
- [ ] PR review-loop clean (CodeRabbit / Codex / Sonar / Snyk / Vercel Agent Review per workspace NN #14 + #18).
- [ ] Architecture doc [`agents-skills-tasks.md`](../../architecture/agents-skills-tasks.md) status flipped from `Draft` to `Active`.
