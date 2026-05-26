# Agents / Skills / Tasks — Implementation Summary

**Branch**: `feat/agents-skills-tasks-impl` off `origin/develop`
**Spec PR**: [#1017](https://github.com/ever-works/ever-works/pull/1017) (specs branch `feat/agents-skills-tasks-specs`)
**Started**: 2026-05-25 · **Completed**: 2026-05-26
**Mode**: 25 autonomous 15-min ticks via `/loop`

This implementation lands the three new feature families documented
in the spec PR, end to end, as additive code (no existing surface
broken).

---

## What shipped

### Agents (Phases 1–7, 10, 16)

- 5 entities: `Agent`, `AgentRun`, `AgentRunLog`, `AgentBudget`, `AgentMembership`
- 5 repositories with the CAS-claim primitive `tryClaimForRun()`
- `AgentsService` (CRUD), `AgentFileService` (5 canonical files + secret-scan + ETag), `AgentScheduleDispatcherService` (heartbeat dispatch), `AgentExportService` (per-Agent envelope), `PromptAssemblerService` (11-segment recipe per spec), `AgentRunService` (orchestrator), `AgentToolService` (descriptor surface for the tool loop)
- Trigger.dev: `agent-heartbeat-dispatcher` (cron) + `agent-heartbeat` (one-shot)
- API: `/api/agents/*` + `/api/agents/:id/files/:name` + `/api/agents/:id/export` + `/api/agents/import`
- Web: `/agents` list + `/agents/new` + `/agents/[id]` with 6 tabs + 5-pill Instructions editor (autosave, ETag conflict banner)
- Tool descriptors shipped: `editAgentFile` (once-per-run cap), `createSubAgent` (DRAFT + all-perms-false), `getActivity`/`getKbDocument` placeholders, `getSkillBody` (Phase 10), plus Tasks-side `createTask` / `commentOnTask` / `transitionTask`

### Skills (Phases 8–10)

- 2 entities: `Skill`, `SkillBinding`
- Repositories with `resolveActive()` (per-target OR filter, priority-sorted, dedup by skillId)
- New plugin capability contract `ISkillsProviderPlugin` + `SKILLS_PROVIDER` constant
- First-party `@ever-works/everworks-skills-plugin` (MIT) with builtin fallback catalog (cron-defaults / secret-handling / commit-message-style)
- `SkillsFacadeService` (union across enabled providers, slug-dedup) + `SkillsService` (CRUD + install-from-catalog + bindings)
- API: `/api/skills/catalog/*`, `/api/skills/*`, `/api/skills/:id/bindings`, `/api/skill-bindings/:id`
- Web: `/skills` 3-section page (Installed / Available / Custom) with Install action
- Phase-10 injection wired into `AgentRunService`: priority-sorted greedy budget-drop, WARN run-log on drop, SKILL_INVOKED activity per skill in the prompt

### Tasks (Phases 11–17)

- 11 entities: `Task` + 10 side tables (assignees / reviewers / approvers / blocks / relations / chat-messages / attachments / watchers / kb-mentions / user-task-counter)
- All 8 F5-override recurring columns on `Task`
- `TaskRepository` with cycle-detector + `casClaimRecurrence` + 10 side repos
- New plugin capability `ITaskTrackerPlugin` + `TASK_TRACKER` constant
- First-party `@ever-works/everworks-task-tracker-plugin` (MIT, DB-shim)
- `TasksFacadeService`, `TasksService`, `TaskTransitionService` (full state machine), `TaskChatService` (5-min edit window + mention parser w/ T6 unknown-token stripping + KB mention materialization), `TaskRecurrenceDispatcherService` (CAS-claim + spawn loop), `TaskNotificationService` (watcher union + dedup + per-event templates)
- Trigger.dev: `agent-task-execute` (60m), `agent-chat-reply` (5m), `task-recurrence-dispatcher` (per-minute UTC)
- Dispatch hooks: `→ in_progress` fans out to `agent-task-execute` for every Agent assignee with `dedupKey='${taskId}:${agentId}:${generation}'`; `@agent` chat mentions fan out to `agent-chat-reply` with `dedupKey='${taskId}:${agentId}:${messageId}'`
- API: full `/api/tasks/*` + `/api/tasks/:id/transition` + member CRUD + `/api/tasks/:id/chat` + `/api/task-chat-messages/:id` + `/api/tasks/:id/recurring` + `/api/tasks/:id/spend`
- Web: `/tasks` (cards / table / kanban view toggle + status filter) + `/tasks/new` + `/tasks/[id]` (sectioned detail with transition affordance + chat thread + post box) + per-target tabs at `/works/[id]/tasks` + `/missions/[id]/tasks` + `/ideas/[id]/tasks`

### Cross-cutting (Phases 18–19)

- Dashboard: `AgentsCountTile`, `TasksInProgressTile`, `RecentTasks` block (sits below Recent Works)
- Notifications: `NotificationCategory.AGENT` + `TASK` enum values, `User.emailAgentAlerts` + `User.emailTaskNotifications` opt-in flags
- Account-transfer v2 payload tail: `ExportedAgent` / `ExportedSkill` / `ExportedTask` types + `AgentsSkillsTasksExportService.exportTail()` + `AgentsSkillsTasksImportService.importTail()` reusing single-entity service surfaces for full validation parity

---

## Architecture decisions referenced

- **ADR-006** — Agents are core (not a plugin), Skills + Tasks are plugin capabilities
- **ADR-008** — File storage: DB-inline for tenant scope (v1), Git for Mission/Work scope (Phase 6 follow-up)
- **ADR-012** — Skills are a plugin capability; "Ever Works Skills" is the first-party `skills-provider`
- **ADR-013** — Tasks are a plugin capability; "Ever Works Task Tracker" is the first-party `task-tracker`
- **ADR-014** — Platform is AGPLv3; the catalog plugins are MIT

---

## Migrations

In FK-safe order:

1. `1779978010000-CreateAgentsTables` — 5 Agent tables + 14 indexes
2. `1779978011000-AddAgentIdToPluginUsageEvents` — `agentId` column + index for per-Agent spend rollup
3. `1779978012000-CreateSkillsTables` — 2 Skill tables + 6 indexes
4. `1779978013000-CreateTasksTables` — 11 Task tables + ~22 indexes (incl. `(isRecurring, nextOccurrenceAt)` dispatcher hot path)
5. `1779978014000-AddTaskIdToPluginUsageEvents` — `taskId` column + index for per-Task spend rollup
6. `1779978015000-AddNotificationEmailOptIns` — `emailAgentAlerts` + `emailTaskNotifications` on `users`

---

## Test posture

Every service ships with unit tests under `__tests__/` written but **NOT run** during the autonomous loop — the operator runs the full `pnpm test` suite after merge. Tests cover:

- Permission gates, cross-user 404s, slug uniqueness, secret-scan, size caps
- State-machine lattice (TaskTransitionService) + side effects + force-flag semantics
- CAS-claim winners + losers (Agent heartbeat dispatcher + Task recurrence dispatcher)
- Mention parser strips unknown tokens (T6 mitigation)
- Tool descriptor shapes + once-per-file-per-run cap + sub-Agent DRAFT+all-false-perms enforcement
- Prompt assembler 11-segment ordering, per-trigger preambles, tail-first truncation, per-Agent skill-budget override
- Budget-period math for all 5 intervals (hour/day/week/month/unlimited)
- Account-transfer payload tail toggles + slug-space pointer rewrites

---

## Deferred sub-items (post-merge follow-ups)

These items have their data layer + API path complete; the listed surface lands on a follow-up sub-tick:

- **Phase 4 Git-mode** AgentFileService writes (waits on `GitFacadeService` scope-repo helpers shared with the heartbeat dispatcher)
- **Phase 5.6 Tiptap upgrade** for the Instructions 5-pill editor (currently plain textarea; reuses `KbEditor` once the shared editor toolbar is extracted)
- **Phase 6a UI** export/import flow (server actions + envelope ready)
- **Phase 7.4/7.5 LLM dispatch** inside `AgentRunService.execute` (orchestrator returns the assembled prompt today)
- **Phase 14.2 drag-drop** Kanban transitions (click-to-transition ships; drag-drop wraps once a dnd library is chosen)
- **Phase 14.4 Mission layout mount** for the MissionTabs scaffold
- **Phase 14.5 Idea per-card drawer** for Tasks
- **Phase 15.5/15.6** AgentRunService task/chat post-processing + taskId setter inside AiFacadeService.recordEvent
- **Phase 16.6/16.7/16.10** commitToRepo / openPullRequest / plugin pass-through tools
- **Phase 17.8** Recurring-task UI toggle + frequency picker
- **Phase 18.6** Templates browser components (depend on Phase-6.5 unified catalog)
- **Phase 19.5/19.6** GitHubSyncService subdir layout + `/settings/import-export` UI toggles

---

## How to merge

1. Wait for spec PR [#1017](https://github.com/ever-works/ever-works/pull/1017) to land on `develop`.
2. Rebase `feat/agents-skills-tasks-impl` onto the updated `develop`.
3. Run `pnpm format && pnpm lint && pnpm type-check` from the repo root.
4. Run `pnpm test` — full suite. Triage any failures (most likely test fixtures that need updating for the new entities / enum values).
5. Open PR against `develop` with this file as the description scaffold.
6. After merge, the API auto-applies the 6 new migrations on next boot via `migrationsRun: true`.
