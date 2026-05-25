# Agents / Skills / Tasks — Implementation Progress

**Branch**: `feat/agents-skills-tasks-impl` off `origin/develop`
**Worktree**: `C:/Coding/Worktrees/wt-agents-skills-tasks-impl`
**Started**: 2026-05-25
**Mode**: autonomous overnight `/loop` — 15 min ticks; no human in the loop until done.

This file is the source of truth for "where are we in implementation." **Every tick reads it first, updates it last, and commits both code + this file in the same commit.** That way a tick that crashes mid-way leaves the progress unchanged and the next tick retries cleanly.

---

## Source specs (DO NOT MODIFY)

The full specification set is on branch [`feat/agents-skills-tasks-specs`](https://github.com/ever-works/ever-works/tree/feat/agents-skills-tasks-specs/docs/specs) (PR [#1017](https://github.com/ever-works/ever-works/pull/1017)). Key files implementers must consult:

- **Anchor**: `docs/specs/architecture/agents-skills-tasks.md` (read first, on spec branch URL above)
- **Shipping plan**: `docs/specs/architecture/implementation-reuse-map.md` §14 — this PROGRESS tracker is grouped by the PRs listed there
- **Tools API**: `docs/specs/architecture/agent-tools-catalog.md`
- **Prompt assembly**: `docs/specs/architecture/agent-prompt-assembly.md`
- **Security**: `docs/specs/architecture/security-agents-skills-tasks.md`
- **agent.yml schema**: `docs/specs/architecture/agent-yml-manifest-schema.md`
- **Feature specs**: `docs/specs/features/{agents,skills,task-tracking}/{spec,plan,tasks}.md`
- **ADRs**: `docs/specs/decisions/{006..014}-*.md`

Specs are NOT in this implementation branch's checkout (we branched off `develop`, not off the spec branch). Read from the spec-branch URL above when needed. After spec PR #1017 lands on develop, rebase this branch to pull them in.

---

## Tick rules (for the autonomous loop)

1. **Read this file first.** Find the first phase still marked `[ ]` (not done). That's where to work.
2. **One tick = one phase** if it fits in 15 min, else **one chunk** of a phase. The "Next chunk" field below tells you exactly what to do.
3. **Write code + e2e/unit tests, but DO NOT RUN tests.** Operator will run the full suite later. Just author and commit them.
4. **Commit + push at the end of every tick.** Conventional-commit format (`feat:`, `test:`, `chore:`, etc.). Push to `feat/agents-skills-tasks-impl`.
5. **Update this file in the SAME commit.** Tick the box, refresh "Next chunk", increment "Last tick #", set "Last tick at" to current UTC.
6. **Never delete or modify existing platform code without checking the spec.** This work is additive (per NN #20).
7. **No cloud agents.** Everything runs locally. Workspace `.config/` has credentials if needed.
8. **No questions to operator.** Default to the ★ choice / spec text. If a real ambiguity blocks, write `[BLOCKED-NEEDS-OPERATOR: <question>]` into this file and skip to the next phase.
9. **Never run destructive git ops** (force push, reset --hard, branch -D on shared branches) without explicit need.
10. **Stale-tick recovery**: if "In progress now" below is older than 30 min, assume the previous tick is stuck — clear that field and start the same phase fresh.

---

## Tick counter

- **Last tick #**: 4
- **Last tick at**: 2026-05-25 (tick 4 — Phase 3 complete)
- **In progress now**: (none — next tick picks up Phase 4 AgentFileService + file endpoints)

---

## Phase tracker

The phases below mirror the 18-PR shipping plan in `implementation-reuse-map.md §14`, sub-divided where a single PR is too large to fit in a 15-min tick. Critical-path phases are marked **HIGH RISK** (allocate extra ticks).

### Phase 0 — Bootstrap (DONE)

- [x] **0.1** Create implementation worktree off `origin/develop` ✓
- [x] **0.2** Write IMPLEMENTATION-PROGRESS.md ✓
- [x] **0.3** Initial commit + push branch ✓

### Phase 1 — Core Agent entities

- [x] **1.1** Create `packages/agent/src/entities/agent.entity.ts` per `features/agents/plan.md §3.1`. Includes the 3-avatar columns (`avatarMode` / `avatarIcon` / `avatarImageUploadId`) per H3 override, all 5 `intervalUnit` values per N6 override. ✓ Tick 1
- [x] **1.2** Create `agent-run.entity.ts`, `agent-run-log.entity.ts`, `agent-budget.entity.ts`, `agent-membership.entity.ts`. ✓ Tick 1
- [x] **1.3** Register entities in `packages/agent/src/entities/index.ts` and `packages/agent/src/database/database.config.ts` (the actual loader the typeorm.config.ts wraps). ✓ Tick 1
- [x] **1.4** Generate migration `CreateAgentsTables.ts` — `apps/api/src/migrations/1779978010000-CreateAgentsTables.ts` (5 tables + FKs + 14 indexes, idempotent guards, portable `text` for simple-json). ✓ Tick 2
- [x] **1.5** Extend `BudgetOwnerType` enum in `_types.ts` to add `AGENT` value. ✓ Tick 1
- [x] **1.6** Migration: `AddAgentIdToPluginUsageEvents.ts` — `apps/api/src/migrations/1779978011000-AddAgentIdToPluginUsageEvents.ts` (additive column + index, no FK — Agent delete must not cascade audit rows). Also added the matching `agentId` column to `PluginUsageEvent` entity. ✓ Tick 2
- [x] **1.7** Unit tests for entity shape + indexes (don't run): `agent.entity.spec.ts`, `agent-run.entity.spec.ts`, `agent-budget.entity.spec.ts`. Metadata-only assertions via `getMetadataArgsStorage()` — no DB needed. ✓ Tick 2

### Phase 2 — Agent repositories

- [x] **2.1** `AgentRepository` with `findById`, `findByIdAndUser`, `findByUserIdScoped`, `findByUserIdAndSlug` (scope-aware), `findDueForHeartbeat`, `tryClaimForRun` (CAS-claim mirroring `WorkScheduleRepository.tryMarkDispatched`), `releaseAfterRun`, `incrementErrorCount` (with auto-pause at threshold), `transitionStatus` (state-machine guarded), `findStuckRunning`, `findByScopeTarget`. ✓ Tick 3
- [x] **2.2** `AgentRunRepository` (createQueued/markStarted/markCompleted/markFailed/markCancelled, `findInFlightForTaskAgent` for chat-dedup), `AgentRunLogRepository` (append/findByRun), `AgentBudgetRepository` (findByAgentId/upsert/summary), `AgentMembershipRepository` (findByAgent/findAgentIdsForTarget/addMembership/removeMembership/replaceForAgent/findAgentIdsForAnyTarget). ✓ Tick 3
- [x] **2.3** Repository unit tests — `agent.repository.spec.ts` covers CAS-claim (6 assertions: null on no-row / null nextHeartbeatAt / non-ACTIVE / success returns original timestamp / failure on affected=0 / exact CAS guards), `incrementErrorCount` auto-pause threshold, `transitionStatus` state-machine. Mocked Repository<Agent>; no DB needed. ✓ Tick 3

### Phase 3 — AgentService + AgentsController (read-only)

- [x] **3.1** DTOs under `apps/api/src/agents/dto/agent.dto.ts` — `CreateAgentDto`, `UpdateAgentDto`, `ListAgentsQueryDto`, `AgentPermissionsDto`, `AgentTargetDto`. class-validator decorators throughout (+`@Type` for class-transformer nested validation). ✓ Tick 4
- [x] **3.2** `AgentsService` at `packages/agent/src/agents/agents.service.ts` — create / getOne / list / update / transition / pause / resume / archive / deleteHard / assertCanAssignAcrossScope. Scope-cascade validation, slug derivation + uniqueness, permission refinement (canOpenPullRequests ⇒ canCommitToRepo), 3-avatar-mode field coherence, user-transition state machine, cross-user 404. ✓ Tick 4
- [x] **3.3** `AgentsController` at `apps/api/src/agents/agents.controller.ts` — `/api/agents` routes (list, create, get, update, archive/hard-delete via `?hard=true`, pause, resume). `@Throttle` 30/min on writes per `agents/plan.md §7.1`. `@ApiTags('agents')` + `@ApiOperation` per Decision A19 so the MCP whitelist auto-derivation picks each route up. ✓ Tick 4
- [x] **3.4** `apps/api/src/agents/agents.module.ts` + `packages/agent/src/agents/agents.module.ts` (agent-side module). Wired into `apps/api/src/api.module.ts`. `package.json` of `@ever-works/agent` gets the new `./agents` subpath export so `@ever-works/agent/agents` resolves. ✓ Tick 4
- [x] **3.5** Service unit tests at `packages/agent/src/agents/__tests__/agents.service.spec.ts` (~20 assertions: scope validation, slug uniqueness, permission refine, avatar pairing, status transitions, cross-scope assignment authorization). e2e scaffold at `apps/api/test/agents.e2e-spec.ts` (skipped pending shared bootstrap helper wire-up). ✓ Tick 4

### Phase 4 — AgentFileService + file endpoints

- [ ] **4.1** Secret-scan helper at `packages/agent/src/utils/secret-scan.ts` with all 6 patterns from `security-agents-skills-tasks.md §6`.
- [ ] **4.2** `AgentFileService.read(agentId, name)` + `.write(agentId, name, body, commitMessage)`. Branches Git mode (Mission/Work-scoped via `GitFacadeService`) vs DB-inline (Tenant-scoped).
- [ ] **4.3** `GET /agents/:id/files/:name` + `PUT /agents/:id/files/:name`. Validate `name ∈ {SOUL, AGENTS, HEARTBEAT, TOOLS, agent.yml}`.
- [ ] **4.4** Update `agents.contentHash` on every write (sha256 of 5-file canonical concat).
- [ ] **4.5** Activity row `AGENT_FILE_EDITED` on success.
- [ ] **4.6** Tests (don't run).

### Phase 5 — Web list + Instructions tab + Create dialog

- [ ] **5.1** Sidebar item insertion in `DashboardSidebar.tsx` for Agents / Tasks / Skills.
- [ ] **5.2** i18n keys per `features/agents/spec.md §5.1`.
- [ ] **5.3** `/agents` empty-state page + populated Cards/Table list with view-mode switcher.
- [ ] **5.4** `/agents/new` 2-step create dialog.
- [ ] **5.5** `/agents/[id]` layout + tabs (Dashboard / Activity / Instructions / Skills / Budgets / Settings).
- [ ] **5.6** Instructions tab — 5-pill Tiptap editor reusing `KbEditor.tsx`. 800ms autosave.
- [ ] **5.7** `apps/web/src/lib/api/agents.ts` client wrappers.

### Phase 6 — Agent heartbeat dispatcher (HIGH RISK)

- [ ] **6.1** `packages/tasks/src/tasks/trigger/agent-heartbeat-dispatcher.task.ts` cron `*/${AGENT_DISPATCH_INTERVAL_MINUTES} * * * *`.
- [ ] **6.2** `AgentScheduleDispatcherService.dispatchDue()` with CAS-claim (mirrors `WorkScheduleDispatcherService.markRunDispatched`).
- [ ] **6.3** Race test (two concurrent calls → exactly one claims).
- [ ] **6.4** `packages/tasks/src/tasks/trigger/agent-heartbeat.task.ts` (one-shot, maxDuration=30m).
- [ ] **6.5** Wire to `apps/api/src/trigger/trigger-internal.controller.ts` via remote-proxy table.

### Phase 6a — Per-Agent export + import (N5 override)

- [ ] **6a.1** `AgentExportEnvelope` DTO per spec §5.11.
- [ ] **6a.2** `AgentExportService.exportOne(agentId)`.
- [ ] **6a.3** Controller `GET /agents/:id/export`.
- [ ] **6a.4** `AgentImportService.importOne(envelope, options)` with conflict resolution.
- [ ] **6a.5** Controller `POST /agents/import?onConflict=...`.
- [ ] **6a.6** UI export button + import-with-preview flow.
- [ ] **6a.7** Activity events `AGENT_EXPORTED`, `AGENT_IMPORTED`.

### Phase 7 — AgentRunService + PromptAssemblerService (HIGHEST RISK)

- [ ] **7.1** `PromptAssemblerService.assemble(...)` — 11-segment recipe from `agent-prompt-assembly.md §2`.
- [ ] **7.2** Per-trigger preamble (heartbeat / task / chat) per §2.1.
- [ ] **7.3** Token-budget enforcement + tail-first truncation + warning log row.
- [ ] **7.4** `AgentRunService.execute(context)` — the orchestrator per `agent-prompt-assembly.md §8` pseudocode.
- [ ] **7.5** Extend `BaseFacadeService.resolvePlugin` to accept `agentId` hint per `agents/plan.md §3.3`.
- [ ] **7.6** Multi-interval `BudgetService` aggregator (per N6 — `getCurrentPeriodStart` / `getNextPeriodStart` handling hour/day/week/month/unlimited).
- [ ] **7.7** Tests (don't run).

### Phase 8 — Skill catalog + entities + read-only API

- [ ] **8.1** Entity `skill.entity.ts` per `features/skills/plan.md §3.1`.
- [ ] **8.2** Entity `skill-binding.entity.ts`.
- [ ] **8.3** Migration `CreateSkillsTables.ts`.
- [ ] **8.4** Repositories + `resolveActive()` unit tests.
- [ ] **8.5** **"Ever Works Skills" plugin** at `packages/plugins/everworks-skills/` per ADR-012. Reads `ever-works/skills` repo via clone+cache. `ISkillsProviderPlugin` contract.
- [ ] **8.6** `SkillsFacadeService` resolving enabled `skills-provider` plugins; dedupe by slug.
- [ ] **8.7** Read-only API routes (`GET /skills/catalog`, `GET /skills`, `GET /skills/:id`).
- [ ] **8.8** Tests (don't run).

### Phase 9 — Skill mutations + /skills page + Bindings tab

- [ ] **9.1** `POST /skills/install`, `POST /skills`, `PATCH /skills/:id`, `DELETE /skills/:id`.
- [ ] **9.2** Bindings CRUD endpoints.
- [ ] **9.3** `/skills` page (3 sections: Installed / Available / Custom).
- [ ] **9.4** `/skills/[id]` Body + Bindings tabs.
- [ ] **9.5** Tests.

### Phase 10 — Skill injection into AI calls

- [ ] **10.1** `SkillBindingRepository.resolveActive()` priority-sorted resolver.
- [ ] **10.2** `AiFacadeService.assembleSystemMessage()` extension calling resolver.
- [ ] **10.3** `getSkillBody` tool auto-registration when bound skills present.
- [ ] **10.4** Priority-based drop on budget exceeded + log warning row.
- [ ] **10.5** `SKILL_INVOKED` activity row.
- [ ] **10.6** Tests.

### Phase 11 — Tasks family of entities (as "Ever Works Task Tracker" plugin per ADR-013)

- [ ] **11.1** Entity `task.entity.ts` per `features/task-tracking/plan.md §3.1` — includes recurring columns per F5 override (isRecurring, recurrenceRule, recurrenceTimezone, nextOccurrenceAt, recurrenceEndsAt, recurrenceMaxOccurrences, recurrenceOccurredCount, parentRecurringTaskId).
- [ ] **11.2** Entities `task-assignee.entity.ts`, `task-reviewer.entity.ts`, `task-approver.entity.ts`, `task-block.entity.ts`, `task-relation.entity.ts`, `task-chat-message.entity.ts`, `task-attachment.entity.ts`, `task-watcher.entity.ts`, `task-kb-mention.entity.ts`, `user-task-counter.entity.ts`.
- [ ] **11.3** Migration `CreateTasksTables.ts`.
- [ ] **11.4** Migration `AddTaskIdToPluginUsageEvents.ts`.
- [ ] **11.5** Repositories (cycle detector, casClaimRecurrence, etc.).
- [ ] **11.6** `ITaskTrackerPlugin` contract in `packages/plugin/src/contracts/capabilities/task-tracker.interface.ts`.
- [ ] **11.7** **"Ever Works Task Tracker" plugin** at `packages/plugins/everworks-task-tracker/`.
- [ ] **11.8** `TasksFacadeService`.

### Phase 12 — TasksController + /tasks list page

- [ ] **12.1** State machine `TaskTransitionService`.
- [ ] **12.2** Slug generator + atomic counter.
- [ ] **12.3** DTOs + CRUD endpoints (create, list with filters, update, transition, assignees/reviewers/approvers/blockers/relations).
- [ ] **12.4** Activity events.
- [ ] **12.5** Sidebar Tasks route wired.
- [ ] **12.6** `/tasks` list page (Cards + Table).
- [ ] **12.7** `/tasks/new` create form.
- [ ] **12.8** Tests.

### Phase 13 — Task detail page + chat

- [ ] **13.1** `/tasks/[id]` page (header + sidebar + sections).
- [ ] **13.2** Chat endpoints + 5-min edit window enforcement.
- [ ] **13.3** Chat UI panel (Tiptap-lite + mention picker + KB wikilink).
- [ ] **13.4** Mention parser (server-side validates against user's owned Agents/users; strips unknown).
- [ ] **13.5** Attachments via existing KB upload pipeline.
- [ ] **13.6** Secret-scan on description + chat body writes.

### Phase 14 — Kanban + per-target tabs

- [ ] **14.1** `TasksKanbanView.tsx` adapted from `WorksKanbanView.tsx`.
- [ ] **14.2** Drag-drop status transitions (debounced 250ms PATCH).
- [ ] **14.3** Tasks tab on Work detail (extends `WorkTabs.tsx`).
- [ ] **14.4** **Mission detail tab strip** — first tab strip on Mission detail; create `MissionTabs.tsx` modeled on `WorkTabs.tsx`; Overview wraps current single-column body.
- [ ] **14.5** Idea-side per-card expansion drawer for Tasks (v1 approach, not full detail page).

### Phase 15 — Agent ↔ Task runtime tasks

- [ ] **15.1** `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` (maxDuration 60m).
- [ ] **15.2** `packages/tasks/src/tasks/trigger/agent-chat-reply.task.ts` (maxDuration 5m).
- [ ] **15.3** Dispatch hook in `TaskTransitionService` on `* → in_progress` if any Agent assignee; dedup by `(taskId, agentId, generation)`.
- [ ] **15.4** Dispatch hook in `TaskChatService.post` on `@<agent-slug>` mention.
- [ ] **15.5** `AgentRunService` `kind: 'task'` and `kind: 'chat'` paths.
- [ ] **15.6** `taskId` propagation to `PluginUsageEvent` from inside task/chat runs.
- [ ] **15.7** `GET /tasks/:id/spend` per-task spend endpoint.

### Phase 16 — Tools surface wired to Agent runs (HIGH RISK)

- [ ] **16.1** `AgentToolService.resolveAllowedTools(agent)` per `agent-tools-catalog.md §4`.
- [ ] **16.2** `createTask` tool (gated by canAssignTasks).
- [ ] **16.3** `commentOnTask` tool.
- [ ] **16.4** `transitionTask` tool.
- [ ] **16.5** `editAgentFile` tool (path validation, secret scan, hash check, once-per-run).
- [ ] **16.6** `commitToRepo` tool.
- [ ] **16.7** `openPullRequest` tool.
- [ ] **16.8** `createSubAgent` tool (sub-Agents always created in `draft`, permissions all false).
- [ ] **16.9** `getActivity` / `getMissionState` / `getKbDocument` / `getSkillBody` tools.
- [ ] **16.10** Plugin pass-through tools (searchWeb / screenshot / extractContent).

### Phase 17 — Recurring tasks (F5 override)

- [ ] **17.1** Add `rrule` npm package.
- [ ] **17.2** Validate `recurrenceRule` on every write via `RRule.fromString()`.
- [ ] **17.3** Helper `computeNextOccurrence(rule, tz, from)` honoring `recurrenceEndsAt` + `recurrenceMaxOccurrences`.
- [ ] **17.4** Repository method `casClaimRecurrence(taskId, expectedNextOccurrenceAt)`.
- [ ] **17.5** Helper `cloneRecurringTaskAsInstance(template)`.
- [ ] **17.6** `TaskRecurrenceDispatcherService.dispatchDue(batchSize)`.
- [ ] **17.7** Trigger.dev cron `packages/tasks/src/tasks/trigger/task-recurrence-dispatcher.task.ts` (every minute UTC).
- [ ] **17.8** UI: "Make this recurring" toggle + frequency picker + "Recurring" badge + "View template" link.

### Phase 18 — Dashboard + Notifications + per-feature templates browser

- [ ] **18.1** `AgentsCountTile.tsx`, `TasksInProgressTile.tsx` on Dashboard.
- [ ] **18.2** "Recent Tasks" block below "Recent Works".
- [ ] **18.3** New `Notification.category` enum values (AGENT, TASK).
- [ ] **18.4** `TaskNotificationService.emit(event, context)` wrapper around existing `NotificationsService.create()`.
- [ ] **18.5** Notification email opt-in flags (`emailAgentAlerts`, `emailTaskNotifications`) on User.
- [ ] **18.6** Templates browser components reusable across `/templates` hub + per-feature pages.

### Phase 19 — Account-transfer extension (per ADR-008 v1 requirement)

- [ ] **19.1** `ExportedAgent` type + `AccountExportService.exportAgents` + bump payload version.
- [ ] **19.2** `ExportedSkill` + `ExportedSkillBinding` + same.
- [ ] **19.3** `ExportedTask` (opt-in) + same.
- [ ] **19.4** `AccountImportService` handlers for all three.
- [ ] **19.5** `GitHubSyncService` repo layout extension (agents/, skills/, tasks/ subdirs in `ever-works-config` sync repo).
- [ ] **19.6** UI toggles in `/settings/import-export`.

### Phase 20 — Final polish + docs site

- [ ] **20.1** Update `docs/plugin-system/built-in-plugins.md` to include `everworks-skills` and `everworks-task-tracker`.
- [ ] **20.2** Add API docs for `/agents/*`, `/skills/*`, `/tasks/*` to the Docusaurus site.
- [ ] **20.3** Run `pnpm format` + `pnpm lint` + `pnpm type-check` (DO NOT run tests).
- [ ] **20.4** Open PR against develop (after spec PR #1017 merges, or with note that it depends on it).

---

## Notes for the loop runner

### Catalog repos to create externally

When you reach Phase 8 / 11, the plugins will try to clone `ever-works/skills` and `ever-works/tasks`. These repos don't exist yet. **Do NOT block on this** — write the plugins to handle "repo not reachable / empty" by returning an empty catalog with a warning log row. Operator will create the repos separately. The platform self-recovers when they appear.

### Conventions

- Tabs not spaces (root prettier).
- pnpm only.
- Files: kebab-case.
- Migrations: `<unix-millis>-<Name>.ts` per `CLAUDE.md`.
- Conventional commits.
- Co-Authored-By footer.
- No emojis in code/files.
- If touching an existing platform file (e.g. extending `BudgetGuardService` for `ownerType='agent'`), add a code comment with the PR reference for findability.

### What "don't run tests" means

Write the test files (Jest in `apps/api/`, Vitest in `packages/plugins/*`, Playwright in `apps/web/tests/`). Don't invoke `pnpm test`. Don't gate progression on test pass. The operator will run the full suite later and report failures back as a separate cycle.

### Commit cadence

One commit per phase or per chunk (smaller is fine). Always include this PROGRESS file update in the SAME commit as the work. Push every commit. Don't batch multiple phases into one mega-commit.
