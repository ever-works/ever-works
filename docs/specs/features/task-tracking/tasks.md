# Task Breakdown: Task tracking

**Feature ID**: `task-tracking`
**Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-05-25

---

## How to use

Phases mirror [plan.md §10](./plan.md#10-phased-rollout). Tasks sequential unless `(parallel)`.

---

## Phase 1 — Data + read/write API + list page

- [ ] **T1**. Create entity files under `packages/agent/src/entities/`: `task.entity.ts`, `task-assignee.entity.ts`, `task-reviewer.entity.ts`, `task-approver.entity.ts`, `task-block.entity.ts`, `task-relation.entity.ts`, `task-chat-message.entity.ts`, `task-attachment.entity.ts` (per [plan.md §3.1](./plan.md#31-new-entities)). `(parallel)`
- [ ] **T2**. Register entities in `apps/api/src/typeorm.config.ts`.
- [ ] **T3**. Migration `CreateTasksTables.ts`. Inspect generated SQL.
- [ ] **T4**. Migration `AddTaskIdToPluginUsageEvents.ts` (additive column + index).
- [ ] **T5**. Repositories: `TaskRepository` (with `findByScope`, `findChildren`, `findBlockers`, `findActiveBlockers`, `findCycle(parentId, candidateId)`), `TaskAssigneeRepository`, etc.
- [ ] **T6**. State-machine class `TaskTransitionService.assertCanTransition(task, target, ctx)` enforcing [spec.md §3.2](./spec.md#32-lifecycle).
- [ ] **T7**. Cycle-detection helper `assertNoParentCycle(parentId, candidateChildId)` and `assertNoBlockCycle(...)`.
- [ ] **T8**. DTOs under `apps/api/src/tasks/dto/`: create, update, transition, filter, response.
- [ ] **T9**. `TasksController` + `TasksService` with CRUD + assignees/reviewers/approvers/blockers/relations endpoints (chat in Phase 2). **Tests**: unit + e2e.
- [ ] **T10**. Wire `TasksModule` into `app.module.ts`.
- [ ] **T11**. Slug generator: `T-<incrementing>` per user; uses an atomic counter in DB.
- [ ] **T12**. Activity log events: `TASK_CREATED`, `TASK_UPDATED`, `TASK_ASSIGNED`, `TASK_COMPLETED` wired through `ActivityLogService`.
- [ ] **T13**. i18n keys under `tasks.*` and sidebar key (already reserved in `agents/spec.md §5.1`).
- [ ] **T14**. Patch `DashboardSidebar.tsx` to surface the "Tasks" item (Phase 1 of agents wires the placeholder; this one wires the route).
- [ ] **T15**. `/tasks` list page (server component) with Cards + Table views. Filter chips for status; quick-filter dropdowns for scope/assignee/label/priority.
- [ ] **T16**. `/tasks/new` create form.
- [ ] **T17**. `apps/web/src/lib/api/tasks.ts` client wrappers.

## Phase 2 — Detail page + chat

- [ ] **T18**. `/tasks/[id]` page renders the full detail layout (header, sidebar, description editor, sub-tasks, attachments, activity, related, chat). Inline title editor.
- [ ] **T19**. Sub-task badge logic (`n/m` done).
- [ ] **T20**. Chat endpoints `GET/POST/PATCH /tasks/:id/chat` and `/task-chat-messages/:id`. 5-minute edit window enforced server-side.
- [ ] **T21**. Chat UI panel using the same Tiptap mention + wikilink extensions as `KbEditor.tsx`.
- [ ] **T22**. Mention parser (server-side) extracts `@<slug>` and validates against the user's Agents/users; stores `mentions` jsonb.
- [ ] **T23**. Attachment upload flow: re-use existing KB upload endpoint, then attach via `/tasks/:id/attachments`.
- [ ] **T24**. Activity feed: extend `ActivityFeedClient.tsx` filter to accept `taskId`; render new event icons.
- [ ] **T25**. Secret-scan applied to description + chat body saves.

## Phase 3 — Kanban + per-target tabs

- [ ] **T26**. Build `TasksKanbanView.tsx` adapted from `WorksKanbanView.tsx`. Columns per status.
- [ ] **T27**. Drag-drop status transitions: optimistic update, debounced 250 ms patch.
- [ ] **T28**. View-mode persistence: `localStorage` key `tasks-view-mode`.
- [ ] **T29**. Patch `WorkTabs.tsx` to add "Tasks" tab between Items and KB (per Q1 default).
- [ ] **T30**. Add "Tasks" tab to Mission detail page.
- [ ] **T31**. Add "Tasks" tab to Idea detail page.
- [ ] **T32**. Tab listings reuse the global `/tasks` list component with prefilled scope filter.

## Phase 4 — Agent integration

> Depends on [agents Phase 3](../agents/tasks.md) (heartbeat runtime + AgentRunService).

- [ ] **T33**. `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` (maxDuration 60m).
- [ ] **T34**. `packages/tasks/src/tasks/trigger/agent-chat-reply.task.ts` (maxDuration 5m).
- [ ] **T35**. Dispatch hook in `TaskTransitionService`: when target=`in_progress` and any assignee is an Agent, dispatch one run per Agent. Dedup by `(taskId, agentId, generation)`.
- [ ] **T36**. Dispatch hook in `TaskChatService.post`: when message body matches `@<agent-slug>` and that agent is on the task, dispatch reply run.
- [ ] **T37**. AgentRunService extended with `kind: 'task'` and `kind: 'chat'` paths (Agents Phase 5 task T51-T52 reference this).
- [ ] **T38**. Add `taskId` to `PluginUsageEvent` writes from inside `agent-task-execute` / `agent-chat-reply`.
- [ ] **T39**. `GET /tasks/:id/spend` endpoint returning per-task token + USD totals from `plugin_usage_events`.
- [ ] **T40**. UI: "Spend on this task" small block in the Task detail sidebar.
- [ ] **T41**. Playwright e2e: create Task → assign Agent → move to in_progress → Agent posts a chat message within 30 s.

## Phase 5 — Dashboard surfaces

- [ ] **T42**. `apps/web/src/components/dashboard/TasksInProgressTile.tsx`.
- [ ] **T43**. "Recent Tasks" block component + integration into the dashboard page.
- [ ] **T44**. "View all (N)" link → `/tasks`.

## Phase 6 — Reserved plugin interface

- [ ] **T45**. Create `packages/plugin/src/contracts/capabilities/task-tracker.interface.ts` (interface only, no plugin implements).
- [ ] **T46**. Add a section in `docs/specs/architecture/plugin-sdk.md` documenting the reserved capability with examples of what a future plugin (Linear, GitHub Issues) would look like.
- [ ] **T47**. Add a no-op contract test in `packages/plugin/src/contracts/__tests__/task-tracker.spec.ts` asserting type-shape only.

## Phase 7 — Default-on rollout

- [ ] **T48**. Feature flag `FEATURE_TASK_TRACKING` defaulting to off.
- [ ] **T49**. Internal beta on staging; gather "Kanban scrollbar / drag-drop weirdness" bugs.
- [ ] **T50**. Flip flag default to on.

## Definition of Done

- [ ] All boxes ticked.
- [ ] `pnpm test` + `pnpm lint` + `pnpm type-check` green.
- [ ] No regression in existing Works Kanban (still loads, drag-drop free of the new code).
- [ ] Architecture doc references updated.
- [ ] PR review-loop clean.
