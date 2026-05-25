# Feature Specification: Task tracking

**Feature ID**: `task-tracking`
**Branch**: `feat/task-tracking`
**Status**: `Draft`
**Created**: 2026-05-25
**Last updated**: 2026-05-25
**Owner**: Product (Ruslan)

**Related code today**:

- Existing kanban for Works: `apps/web/src/components/works/WorksKanbanView.tsx`
- Tiptap editor + wikilinks + mentions: `apps/web/src/components/works/detail/kb/KbEditor.tsx`
- KB uploads: `packages/agent/src/entities/work-knowledge-upload.entity.ts`
- Activity feed: `apps/web/src/components/works/detail/activity/ActivityFeedClient.tsx`
- Mission/Idea/Work entities (on develop): `packages/agent/src/entities/mission.entity.ts`, `work-proposal.entity.ts`, `work.entity.ts`

> **Scope**: A minimal but full-featured task-tracking system. Tasks can attach to Missions, Ideas, or Works (one each, all optional). Assignees are humans **or** Agents. Tasks have status, priority, labels, parent/sub, blockers, reviewers, approvers, descriptions, attachments, KB mentions, a flat per-task chat, and an activity log. New "Tasks" sidebar item + tabs on Work/Mission/Idea detail pages.
>
> **Hard rule (additive)**: Nothing existing changes. Existing KB, Items, activity log, generators — all unchanged. We add a new `tasks` table family and new UI surfaces.
>
> **Future**: A reserved `task-tracker` plugin capability allows the platform to later proxy tasks into Linear / GitHub Issues / Jira. v1 ships the platform-native path; the interface is declared but no plugin implements it.

---

## 1. Overview

A **Task** is a unit of work with rich metadata: status, priority, labels, multiple assignees (humans + Agents), reviewers, approvers, a parent task (for sub-tasks), blockers, related tasks, a description (markdown), attachments, KB-document mentions, and a flat chat thread. Tasks can be scoped to a Work, a Mission, an Idea, or stand free (tenant-scoped). They drive Agent execution (when an Agent is an assignee on a Task moving to `in_progress`, the platform dispatches an `agent-task-execute` Trigger.dev run — see [agents/spec.md S4](../agents/spec.md)).

The default v1 backend stores everything in the platform's own tables. A future `task-tracker` plugin capability (reserved, not consumed in v1) will let a Mission/Idea/Work proxy tasks into an external tracker. The platform-native rows and the future plugin path share the same DTO shape so UI code doesn't fork.

## 2. User Scenarios

### 2.1 Primary scenarios

**S1 — Create a tenant-scoped task.**
*Given* a signed-in user on the new `/tasks` sidebar page,
*When* they click "+ New Task", fill `title`, set `priority='p1'`, add label `"investor"`, and save,
*Then* a `tasks` row is created (no missionId/workId/ideaId), `TASK_CREATED` activity row emitted.

**S2 — Create a task scoped to a Work.**
*Given* the user on `/works/<id>` Tasks tab clicking "+ New Task",
*When* they save,
*Then* the task is created with `workId=<id>` and appears on the Work's Tasks tab AND on the global `/tasks` page filtered by Work.

**S3 — Assign humans + Agents.**
*Given* a Task being edited,
*When* the user adds `@self` (a User) and `@ceo` (an Agent) to assignees,
*Then* two `task_assignees` rows are created (assigneeType=user vs agent). Both names render with distinct icons.

**S4 — Status flow.**
*Given* a Task in `todo` with the CEO Agent as assignee,
*When* the user moves it to `in_progress` (either by drag-drop on the kanban or status select),
*Then* `TASK_UPDATED` activity row emitted, AND because an Agent is assigned, the platform dispatches an `agent-task-execute` Trigger.dev run. Agent posts progress messages into the Task's chat.

**S5 — Parent + sub-tasks.**
*Given* a Task "Launch v1",
*When* the user clicks "+ Subtask" and adds 3 sub-tasks,
*Then* three new `tasks` rows are created with `parentTaskId=<parent>`. The parent's progress badge shows `2/3` when 2 sub-tasks are done.

**S6 — Blockers.**
*Given* a Task being edited,
*When* the user adds "Blocked by: Task #42",
*Then* a `task_blocks(taskId=<this>, blockedByTaskId=42)` row is created. The Task gets status `blocked` (auto-cascaded) until #42 is `done`.

**S7 — Chat with attachment + mention.**
*Given* a Task open on its detail page,
*When* a user types `@vp-engineering can you review docs/spec.md?` and uploads `screenshot.png`,
*Then* a `task_chat_messages` row is inserted with `mentions=[{type:'agent',slug:'vp-engineering'}]` and `attachments=[{uploadId:<id>}]`. An `agent-chat-reply` run is dispatched. Activity row `TASK_COMMENTED` emitted.

**S8 — Reviewers + Approvers.**
*Given* a Task moving from `in_progress` to `in_review`,
*When* a reviewer marks "Reviewed" or an approver marks "Approved",
*Then* the row is annotated; the parent Task transitions to `done` only when ALL approvers have approved (configurable via `requireAllApprovers` setting on the task — default true).

**S9 — Kanban view.**
*Given* the user opens `/tasks` and switches to Kanban,
*When* the data loads,
*Then* tasks render in columns by status (backlog, todo, in_progress, in_review, blocked, done). The component reuses `WorksKanbanView.tsx`'s column-config + card pattern (see Spec §5).

**S10 — Tasks scoped to a Mission shown on Mission Tasks tab.**
*Given* a Mission with 5 attached tasks,
*When* the user opens `/missions/<id>` Tasks tab,
*Then* the tab shows those 5 tasks with the same Cards/Table/Kanban toggle as the global page.

**S11 — Dashboard "Recent Tasks".**
*Given* the user on `/` dashboard,
*When* the page loads,
*Then* below the existing "Recent Works" preview block, a "Recent Tasks" block shows the latest 5 tasks the user owns or is assigned to, with "View all (N)" link.

**S12 — KB document mention inside Task description.**
*Given* the user typing the Task description in Tiptap,
*When* they type `[[Investor brief]]` (matched against the KB),
*Then* it renders as a wikilink — same WikiLinkExtension reused from `KbEditor.tsx`.

### 2.2 Edge cases & failures

**E1 — Cycle in parent/sub-tasks.** Setting `parentTaskId` to a descendant returns 409 — server-side cycle check on every update.

**E2 — Cycle in blockers.** Same posture — `task_blocks` insert rejects cycles.

**E3 — Multiple scopes set simultaneously.** Server rejects `tasks` with more than one of {missionId, ideaId, workId} non-null. A Task may be associated with at most one scope.

**E4 — Assignee is an Agent that lacks `canCallExternalTools` and the Task description asks for an external tool call.** The platform doesn't block assignment — that's the user's choice — but the Agent's run will tool-error on tool invocation. Surfaces as an `agent_run_logs` entry; the Task is not auto-failed.

**E5 — Agent assignee fails repeatedly.** If the Agent's pause-after-failures threshold trips while in flight on a Task, the Task stays in `in_progress` with a warning banner; the user can re-assign or pause the Task.

**E6 — Chat attachment too large.** Reuses existing KB upload size limits and error surfacing.

**E7 — Concurrent chat posts.** No threading; messages append in `createdAt` order. Concurrent inserts are fine (no parent FK among siblings).

**E8 — Task with no assignees.** Allowed. Stays in whatever status the user chose; no Agent dispatch.

**E9 — Future plugin path on a Mission with `task-tracker` plugin enabled.** When a `task-tracker` plugin is enabled at the Mission level, the platform stops writing to native `tasks` rows for that Mission and proxies to the plugin. v1 doesn't ship a plugin, so this branch is unreachable; the controller has the branch stubbed and the e2e test asserts the unreachable path is correctly skipped.

## 3. Functional Requirements

### 3.1 Persistence

- **FR-1** The system MUST persist a `tasks` table with the columns enumerated in [plan.md §3.1](./plan.md#31-new-entities).
- **FR-2** The system MUST allow at most one of {missionId, ideaId, workId} non-null per `tasks` row.
- **FR-3** The system MUST persist join tables `task_assignees`, `task_reviewers`, `task_approvers`, `task_blocks`, `task_relations`.
- **FR-4** Polymorphic assignee/reviewer/approver: rows carry `(assigneeType ∈ {user, agent}, assigneeId)` pair.
- **FR-5** The system MUST persist `task_chat_messages` (flat, no threading). Author can be user or agent.
- **FR-6** The system MUST persist `task_attachments` referencing `work_knowledge_upload` rows for binary content reuse.

### 3.2 Lifecycle

- **FR-7** Status enum: `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled`.
- **FR-8** Status transitions: `backlog → todo → in_progress → in_review → done`. `* → blocked` and `blocked → previous` allowed. `* → cancelled` allowed. `done → *` is rejected unless the user has admin perms (out of v1 scope).
- **FR-9** When a Task with active blockers tries to move to `in_progress`, the system MUST reject the transition with `409 Conflict — has unresolved blockers`.
- **FR-10** When all blockers for a `blocked` Task are `done`, the Task MUST auto-transition back to its prior status (stored in `previousStatus` column on the row).
- **FR-11** On `done` transition: if any approvers are configured, the system MUST require all approvers' `approved=true` row before allowing `done`. Configurable per-task via `requireAllApprovers`.

### 3.3 Agent integration

- **FR-12** When a Task with an Agent assignee transitions to `in_progress`, the system MUST dispatch one `agent-task-execute` Trigger.dev run per Agent assignee.
- **FR-13** When a `task_chat_messages` row is inserted with an `@<agent-slug>` mention and that agent is on the task, the system MUST dispatch one `agent-chat-reply` run.
- **FR-14** Agent's response message(s) MUST insert `task_chat_messages` rows with `authorType='agent'`.
- **FR-15** The Agent MAY transition the Task to `in_review` or `blocked` via the `transitionTask` tool, gated by `permissions.canAssignTasks` (or a dedicated `canTransitionTask` flag — v1 reuses `canAssignTasks` for simplicity).
- **FR-16** Cost accounting: every `agent-task-execute` and `agent-chat-reply` AI call MUST record `PluginUsageEvent` with `agentId` AND a new `taskId` field, so per-Task spend is queryable.

### 3.4 Web UI

- **FR-17** The sidebar MUST gain a "Tasks" item below "Works" (above Agents per [architecture §12.1](../../architecture/agents-skills-tasks.md)).
- **FR-18** `/tasks` page MUST support three views — **Cards**, **Table**, **Kanban** — with a Cards/Table/Kanban toggle persisted in `localStorage` (key `tasks-view-mode`). Kanban defaults to columns by `status`.
- **FR-19** Filter chips: `All / Open (backlog+todo+in_progress) / Blocked / Done / Cancelled`.
- **FR-20** Quick-filter dropdowns: by Mission, by Work, by Idea, by Assignee (user or agent), by Label, by Priority.
- **FR-21** `/tasks/[id]` page MUST render the task with these sections (no tabs, single scrollable page):
    - Header: title (inline editable), status select, priority select, labels chip-input.
    - Sidebar: assignees, reviewers, approvers, parent task, blockers, related tasks.
    - Body: description editor (Tiptap, wikilinks + mentions).
    - Sub-tasks list.
    - Attachments list.
    - **Activity** ledger (reuses the existing activity-feed component, filtered to this task's events).
    - **Related** — list of tasks where this task was referenced and their statuses.
    - **Chat** — flat list of `task_chat_messages` with input box (mentions + file upload + Tiptap-lite).
- **FR-22** The Work detail page MUST gain a "Tasks" tab between Items and KB (or after Plugins — TBD in [Open Question Q1](#9-open-questions)). The tab lists tasks where `workId=<id>` with the same view toggle.
- **FR-23** The Mission detail page MUST gain a "Tasks" tab.
- **FR-24** The Idea detail page MUST gain a "Tasks" tab.
- **FR-25** Dashboard "Recent Tasks" block: 5 most recent tasks the user owns or is assigned to; "View all (N)" link to `/tasks`.
- **FR-26** Dashboard "Tasks in progress" tile per [architecture §12.3](../../architecture/agents-skills-tasks.md).

### 3.5 Permissions

- **FR-27** Cross-user reads MUST 404.
- **FR-28** Users may only assign Agents they own to tasks they own.
- **FR-29** An Agent may only assign tasks within its scope cascade (per [architecture §3](../../architecture/agents-skills-tasks.md)).
- **FR-30** A Work member with `role ∈ {OWNER, MANAGER, EDITOR}` MUST be able to read/create/update tasks on that Work; `VIEWER` reads only.

## 4. Non-Functional Requirements

### 4.1 Performance

- **NFR-1** `GET /tasks?limit=50` p95 < 200 ms with 1000 tasks per user.
- **NFR-2** Kanban view with 500 tasks renders within 500 ms (matches existing Works Kanban `KANBAN_LIMIT=500` per [`WorksKanbanView.tsx`](../../../apps/web/src/components/works/WorksKanbanView.tsx)).
- **NFR-3** Task chat poll interval 5000 ms (same as activity feed); exponential backoff on failure.

### 4.2 Reliability

- **NFR-4** Concurrent writes to `task_chat_messages` MUST be order-stable by `createdAt + id`; no row loss.
- **NFR-5** Status transitions enforced server-side; the UI is for ergonomics only.

### 4.3 Security & privacy

- **NFR-6** Secret-scan regex on Task description + chat message bodies on write (same regex as Agent/Skill bodies).
- **NFR-7** Attachments inherit the existing KB upload ACL.

### 4.4 Compatibility

- **NFR-8** Existing Works, Missions, Ideas pages MUST work unchanged when a project has zero tasks (no empty-tab rendering quirks).
- **NFR-9** The reserved `task-tracker` plugin capability MUST be declared in `packages/plugin/src/contracts/capabilities/` from day one (interface only, not consumed).

## 5. Key Entities & Domain Concepts

| Concept                | Definition                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Task**               | Row in `tasks`; one or zero scope ids; rich metadata.                                                                  |
| **TaskAssignee**       | Polymorphic link to a User or an Agent.                                                                                |
| **TaskBlocker**        | Row in `task_blocks`; cycle-checked.                                                                                   |
| **TaskRelation**       | Row in `task_relations` with `kind ∈ {related, duplicates, follow-up}`.                                                |
| **TaskChat**           | Flat list of `task_chat_messages`; no threading.                                                                       |
| **TaskAttachment**     | FK from `task_attachments` to `work_knowledge_upload`.                                                                  |
| **Task scope**         | At most one of {missionId, ideaId, workId}; null means tenant-only.                                                    |
| **External tracker**   | Future plugin path; v1 reserves `IExternalTaskTrackerPlugin` interface but doesn't consume.                            |

### 5.1 Kanban column mapping

| Column      | Status set covered                          |
| ----------- | ------------------------------------------- |
| Backlog     | `backlog`                                   |
| To do       | `todo`                                      |
| In progress | `in_progress`                               |
| In review   | `in_review`                                 |
| Blocked     | `blocked`                                   |
| Done        | `done`                                      |
| Cancelled   | `cancelled` (optionally hidden by default)  |

Columns reuse `WorksKanbanView.tsx`'s color-token shape.

## 6. Out of Scope (v1)

- Time tracking (estimate/spent hours). v2.
- Recurring tasks. v2.
- Calendar / Gantt view. v2.
- Email-to-task ingest. v2.
- Slack/Discord task notifications. v2.
- Per-Task `task-tracker` plugin proxying. Interface declared; not consumed.
- Bulk operations (multi-select status change). v2.
- Custom task statuses per Mission/Work. v1 status enum is global.
- Comments on individual chat messages (threading). v1 chat is flat.

## 7. Acceptance Criteria

- [ ] User creates a tenant Task → row in `tasks` with no scope ids; `TASK_CREATED` activity.
- [ ] User creates a Work-scoped Task → row with `workId`; appears on Work tab and global `/tasks`.
- [ ] User adds 2 humans + 1 Agent as assignees → 3 `task_assignees` rows.
- [ ] User moves Task to `in_progress` with Agent assignee → `agent-task-execute` Trigger.dev run dispatched within 5 s.
- [ ] User adds blocker → `task_blocks` row; blocked task moves to `blocked`; `→ in_progress` rejected with 409.
- [ ] Sub-tasks: parent badge shows `n/m` correctly.
- [ ] Approvers gate `done` transition.
- [ ] Chat: `@vp-engineering` mention triggers Agent reply within 30 s.
- [ ] Kanban view loads 500 tasks under 500 ms; drag-drop status update.
- [ ] Cycle detection: parent/child cycle rejected; blocker cycle rejected.
- [ ] Per-task spend visible: SELECT COUNT/SUM from `plugin_usage_events WHERE taskId=<id>` returns sane numbers.

## 8. Open Questions

- **[NEEDS CLARIFICATION: Q1]** Tab placement on Work detail page: between "Items" and "KB", or after "Plugins"? Default: **between Items and KB** so Tasks live alongside the things they often reference.
- **[NEEDS CLARIFICATION: Q2]** A Task with `workId` AND `missionId` set — disallowed (one scope max), or allow Mission + Work as orthogonal? Default: **at most one scope id**; if a user wants both they create a Mission-task and the Work's tab auto-shows Mission-scoped tasks for child Works.
- **[NEEDS CLARIFICATION: Q3]** v1 `task-tracker` plugin: declare interface only, or also ship a no-op reference plugin? Default: **interface only**. Reference plugin lands with the first real implementation (Linear or GitHub Issues).
- **[NEEDS CLARIFICATION: Q4]** Chat message edits/deletes — allowed? Default: **edits within 5 min, no deletes**. Mirrors Slack defaults; trivial to relax later.
- **[NEEDS CLARIFICATION: Q5]** Should we deduplicate Agent dispatch — i.e. don't dispatch a second `agent-task-execute` if one is already running for the same `(taskId, agentId)`? Default: **yes, dedupe**.

## 9. Constitution Gates

- [x] **I — Plugin-First**. Reserved `task-tracker` interface only; v1 native.
- [x] **II — Capability-Driven Resolution**. The future plugin path will route through a facade; not in v1.
- [x] **III — Source-of-Truth Repositories**. Task bodies live in DB (mutable, frequent updates — would thrash Git). Justified deviation; documented here.
- [x] **IV — Background Work via Trigger.dev**. Agent dispatches use Trigger.dev.
- [x] **V — Forward-Only Migrations**. All new tables additive.
- [x] **VI — Tests Prerequisite**. Service tests, blocker cycle test, status transition state-machine test, Playwright end-to-end for assign-Agent + reply.
- [x] **VII — Secret Hygiene**. Body secret-scan.
- [x] **VIII — Plugin Counts Single Source**. N/A (no new plugin).
- [x] **IX — Behaviour-First Specs**. This spec is behavior.
- [x] **X — Backwards Compatibility**. Pure addition.

## 10. References

- Plan: [`./plan.md`](./plan.md)
- Tasks: [`./tasks.md`](./tasks.md)
- Architecture: [`../../architecture/agents-skills-tasks.md`](../../architecture/agents-skills-tasks.md)
- Agents: [`../agents/spec.md`](../agents/spec.md)
- Existing Kanban: [`apps/web/src/components/works/WorksKanbanView.tsx`](../../../apps/web/src/components/works/WorksKanbanView.tsx)
- KB editor reused for descriptions/chat: [`apps/web/src/components/works/detail/kb/KbEditor.tsx`](../../../apps/web/src/components/works/detail/kb/KbEditor.tsx)
- Constitution: [`../../../.specify/memory/constitution.md`](../../../.specify/memory/constitution.md)
