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

## 0. Implementation packaging (per ADR-013)

**Task tracking is a plugin capability** — see [ADR-013](../../decisions/013-task-tracking-as-plugin.md). The product behavior described in this spec is unchanged for end users running the default first-party plugin; what changes from the round-1 design:

- The Task CONCEPT (entity model, state machine, Agent integration, scope rules) is core.
- Task TRACKING (storage, CRUD, list, transition, chat) is plugin-mediated via the new `task-tracker` capability.
- The default first-party plugin: **`"Ever Works Task Tracker"`** at `packages/plugins/everworks-task-tracker/`. Stores tasks in the platform DB schema this spec defines.
- Future community plugins: Linear Task Tracker, JIRA Task Tracker, GitHub Issues Task Tracker — replace storage backend per tenant.
- Plugin contract: `ITaskTrackerPlugin` in `packages/plugin/src/contracts/capabilities/task-tracker.interface.ts`.
- Facade: `TasksFacadeService` — UI and Agents talk only to the facade.
- **One active `task-tracker` per tenant.** Unlike `skills-provider` which allows union, only one tracker owns task storage at a time.

Throughout this spec, references to "the platform stores tasks" / "Task service" should be read as the **first-party `"Ever Works Task Tracker"` plugin storing tasks in the platform DB**. Task templates (`bug-report`, `pr-review`, `weekly-status`) live in **[`ever-works/tasks`](https://github.com/ever-works/tasks)** repo per [ADR-014](../../decisions/014-no-hardcoded-catalogs.md), bundled by the first-party plugin.

## 1.1 Tasks vs Ideas — they are NOT the same thing [F3 operator clarification]

Common point of confusion: Tasks and Ideas are **both** unit-of-work abstractions in the Mission → Idea → Work hierarchy, but they live at different levels and serve different purposes. Conflating them will lead users + AI agents astray when they're deciding "should this be an Idea or a Task?"

| Aspect               | Idea                                                                                                                              | Task                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **What it is**       | A proposal to build something (a Work). Higher-level. PM-flavored.                                                                | A unit of work to be done. Lower-level. Engineering-flavored.                                           |
| **Closest PM term**  | "Epic" — but even that is not a true match. An Idea is an _exploratory proposal_, not a planned tranche of work.                  | "Story" / "Issue" / "Ticket" / "Action item" — pick your tool's word.                                   |
| **Origin**           | **Auto-generated** by the Work Agent from a Goal, or proposed by a Mission tick, or typed by the user via "+ Add Idea".           | Created by a human, an Agent, or a Generator. Always intentional and specific.                          |
| **Lifecycle**        | One-shot. Pending → Queued → Building → Done (or Dismissed / Failed). After Done, the Idea is archived.                           | Mutable. Status flows backlog → todo → in_progress → done / blocked / cancelled with reversals allowed. |
| **Bug-ish content**  | **Never**. Ideas are about NEW things — new Works to build, new directions to explore.                                            | Frequently. Bugs, refactors, audits, follow-ups — anything you'd put in a tracker.                      |
| **Droppability**     | **High** — operator quote: _"We can create 'idea' and drop it very easy."_ No commitment.                                         | Lower — once created, Tasks usually flow to a terminal state (done / cancelled).                        |
| **Cardinality up**   | 1 Mission → many Ideas.                                                                                                           | 1 Idea OR 1 Work OR 1 Mission → many Tasks. Tasks can also live at tenant scope (no parent).            |
| **Cardinality down** | 1 Idea → 0..N Works. _(One Idea can spawn a mobile-app Work AND a website Work AND a landing-page Work, all from the same Idea.)_ | 1 Task → 0..N sub-Tasks.                                                                                |
| **Storage**          | `work_proposals` DB table (existing).                                                                                             | `tasks` DB table (new; via the "Ever Works Task Tracker" plugin per ADR-013).                           |
| **AI behavior**      | Generators propose Ideas. Approval gates exist (`autoBuildWorks`).                                                                | Agents execute Tasks. No approval gates by default.                                                     |

### Concrete rules

- **Don't create a Task for "build a new mobile app for cats business"** — that's an Idea. The right flow: Idea ("Mobile app for cats business") → user accepts → Mobile App Work created → Tasks created on that Work for implementation.
- **Don't create an Idea for "fix the typo in the landing page hero"** — that's a Task on the landing-page Work.
- **An Idea may have its OWN tasks** for validity-check / cost-estimate / market-research / prototyping work. These tasks live at Idea scope (`tasks.ideaId = <idea.id>`). They do NOT auto-forward to derived Works — see [§5.7](#57-idea--work-transition-tasks-do-not-follow-operator-decision-f4-b).
- **Marketing efforts to test whether an Idea is worth pursuing** are Idea-level tasks (and may be assigned to an Agent). Once a Work is created from the Idea, those efforts continue on the Idea, in parallel with new Work-level tasks for implementation.

This distinction is also cross-referenced from [ADR-009 §2 "What to do when a contributor is tempted to blur the lines"](../../decisions/009-tasks-vs-items-vs-kb-distinction.md).

## 1. Overview

A **Task** is a unit of work with rich metadata: status, priority, labels, multiple assignees (humans + Agents), reviewers, approvers, a parent task (for sub-tasks), blockers, related tasks, a description (markdown), attachments, KB-document mentions, and a flat chat thread. Tasks can be scoped to a Work, a Mission, an Idea, or stand free (tenant-scoped). They drive Agent execution (when an Agent is an assignee on a Task moving to `in_progress`, the platform dispatches an `agent-task-execute` Trigger.dev run — see [agents/spec.md S4](../agents/spec.md)).

The default v1 backend stores everything in the platform's own tables. A future `task-tracker` plugin capability (reserved, not consumed in v1) will let a Mission/Idea/Work proxy tasks into an external tracker. The platform-native rows and the future plugin path share the same DTO shape so UI code doesn't fork.

## 2. User Scenarios

### 2.1 Primary scenarios

**S1 — Create a tenant-scoped task.**
_Given_ a signed-in user on the new `/tasks` sidebar page,
_When_ they click "+ New Task", fill `title`, set `priority='p1'`, add label `"investor"`, and save,
_Then_ a `tasks` row is created (no missionId/workId/ideaId), `TASK_CREATED` activity row emitted.

**S2 — Create a task scoped to a Work.**
_Given_ the user on `/works/<id>` Tasks tab clicking "+ New Task",
_When_ they save,
_Then_ the task is created with `workId=<id>` and appears on the Work's Tasks tab AND on the global `/tasks` page filtered by Work.

**S3 — Assign humans + Agents.**
_Given_ a Task being edited,
_When_ the user adds `@self` (a User) and `@ceo` (an Agent) to assignees,
_Then_ two `task_assignees` rows are created (assigneeType=user vs agent). Both names render with distinct icons.

**S4 — Status flow.**
_Given_ a Task in `todo` with the CEO Agent as assignee,
_When_ the user moves it to `in_progress` (either by drag-drop on the kanban or status select),
_Then_ `TASK_UPDATED` activity row emitted, AND because an Agent is assigned, the platform dispatches an `agent-task-execute` Trigger.dev run. Agent posts progress messages into the Task's chat.

**S5 — Parent + sub-tasks.**
_Given_ a Task "Launch v1",
_When_ the user clicks "+ Subtask" and adds 3 sub-tasks,
_Then_ three new `tasks` rows are created with `parentTaskId=<parent>`. The parent's progress badge shows `2/3` when 2 sub-tasks are done.

**S6 — Blockers.**
_Given_ a Task being edited,
_When_ the user adds "Blocked by: Task #42",
_Then_ a `task_blocks(taskId=<this>, blockedByTaskId=42)` row is created. The Task gets status `blocked` (auto-cascaded) until #42 is `done`.

**S7 — Chat with attachment + mention.**
_Given_ a Task open on its detail page,
_When_ a user types `@vp-engineering can you review docs/spec.md?` and uploads `screenshot.png`,
_Then_ a `task_chat_messages` row is inserted with `mentions=[{type:'agent',slug:'vp-engineering'}]` and `attachments=[{uploadId:<id>}]`. An `agent-chat-reply` run is dispatched. Activity row `TASK_COMMENTED` emitted.

**S8 — Reviewers + Approvers.**
_Given_ a Task moving from `in_progress` to `in_review`,
_When_ a reviewer marks "Reviewed" or an approver marks "Approved",
_Then_ the row is annotated; the parent Task transitions to `done` only when ALL approvers have approved (configurable via `requireAllApprovers` setting on the task — default true).

**S9 — Kanban view.**
_Given_ the user opens `/tasks` and switches to Kanban,
_When_ the data loads,
_Then_ tasks render in columns by status (backlog, todo, in_progress, in_review, blocked, done). The component reuses `WorksKanbanView.tsx`'s column-config + card pattern (see Spec §5).

**S10 — Tasks scoped to a Mission shown on Mission Tasks tab.**
_Given_ a Mission with 5 attached tasks,
_When_ the user opens `/missions/<id>` Tasks tab,
_Then_ the tab shows those 5 tasks with the same Cards/Table/Kanban toggle as the global page.

**S11 — Dashboard "Recent Tasks".**
_Given_ the user on `/` dashboard,
_When_ the page loads,
_Then_ below the existing "Recent Works" preview block, a "Recent Tasks" block shows the latest 5 tasks the user owns or is assigned to, with "View all (N)" link.

**S12 — KB document mention inside Task description.**
_Given_ the user typing the Task description in Tiptap,
_When_ they type `[[Investor brief]]` (matched against the KB),
_Then_ it renders as a wikilink — same WikiLinkExtension reused from `KbEditor.tsx`.

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
- **FR-8** Status transitions: `backlog → todo → in_progress → in_review → done`. `* → blocked` and `blocked → previous` allowed. `* → cancelled` allowed. `done → *` is rejected **except** `done → in_progress`, which is permitted as a soft re-open path for cases where a Task was closed by mistake or new information surfaced after completion. The soft re-open is the only post-`done` transition; everything else (`done → todo`, `done → in_review`, `done → blocked`, etc.) stays rejected. Users should prefer filing a new Task when the re-opened work is genuinely separate scope. (Carve-out resolved 2026-05-26 in [PR #1021](https://github.com/ever-works/ever-works/pull/1021) as FU-12 — implementation in `TaskTransitionService.ALLOWED[done] = ['in_progress']` matches this spec.)
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

| Concept              | Definition                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Task**             | Row in `tasks`; one or zero scope ids; rich metadata.                                       |
| **TaskAssignee**     | Polymorphic link to a User or an Agent.                                                     |
| **TaskBlocker**      | Row in `task_blocks`; cycle-checked.                                                        |
| **TaskRelation**     | Row in `task_relations` with `kind ∈ {related, duplicates, follow-up}`.                     |
| **TaskChat**         | Flat list of `task_chat_messages`; no threading.                                            |
| **TaskAttachment**   | FK from `task_attachments` to `work_knowledge_upload`.                                      |
| **Task scope**       | At most one of {missionId, ideaId, workId}; null means tenant-only.                         |
| **External tracker** | Future plugin path; v1 reserves `IExternalTaskTrackerPlugin` interface but doesn't consume. |

### 5.1 Kanban column mapping

| Column      | Status set covered                         |
| ----------- | ------------------------------------------ |
| Backlog     | `backlog`                                  |
| To do       | `todo`                                     |
| In progress | `in_progress`                              |
| In review   | `in_review`                                |
| Blocked     | `blocked`                                  |
| Done        | `done`                                     |
| Cancelled   | `cancelled` (optionally hidden by default) |

Columns reuse `WorksKanbanView.tsx`'s color-token shape.

## 5.2 Slug numbering scheme

Each Task carries a human-readable `slug: T-<N>` where N is a **per-user** monotonic counter (e.g. user-A's first Task is `T-1`; user-B's first Task is also `T-1`). Per-user instead of platform-wide so numbers stay small and don't leak cross-tenant volume. See [QUESTIONS F2](../../QUESTIONS-agents-skills-tasks.md#f2--slug-scheme-per-user-counter-or-platform-wide).

Implementation: an atomic counter row per user (`user_task_counter (userId, lastSlugNumber)`) updated transactionally on every insert. Concurrent inserts race-safe via row-level lock.

## 5.3 Watchers / subscriptions

A `task_watchers (taskId, userId)` join table lets a user "watch" a task they don't own/aren't assigned to. Watchers receive notifications on the events listed in §5.5. The Task's assignees, reviewers, and approvers are implicitly watchers.

UI: a "Watch" button on the Task detail page (becomes "Unwatch" when set). The watcher count is shown next to the button.

## 5.4 Task templates

Optional v1 polish (can land in Phase 2 if time):

A `task_templates` table holds reusable Task body shapes scoped to the tenant. From "+ New Task", the user can pick a template; the title, description, default labels, and default assignee Agents pre-populate. Editable before save.

Catalog of starter templates (3 in v1): `bug-report`, `pr-review`, `weekly-status`.

Defer if scope tight; v2 is fine.

## 5.5 Notifications: which events trigger what

Default-on (per-user, configurable in Settings):

| Event                                                       | Channel        | Recipient                         |
| ----------------------------------------------------------- | -------------- | --------------------------------- |
| Task assigned to you (human assignee added)                 | in-app + email | The newly-added user assignee     |
| Agent posted a chat message mentioning you                  | in-app + email | The mentioned human               |
| Task you're an approver on moves to `in_review`             | in-app + email | All approvers                     |
| Task you watch transitions to `done` or `cancelled`         | in-app         | Watchers (+ assignees implicitly) |
| Approval timeout (Task in `in_review` >7d with no approval) | in-app + email | Approvers                         |
| Sub-task you own moves to `done` and parent is now ready    | in-app         | Parent assignees                  |

Default-off (configurable):

- Label changes
- Priority changes
- Status transitions between `backlog/todo/in_progress`

Implementation: reuse the existing `Notification` entity ([`packages/agent/src/entities/notification.entity.ts`](../../../packages/agent/src/entities/notification.entity.ts)) with new `NotificationCategory.TASK` enum value (or `NotificationCategory.SYSTEM` if we don't want to extend the enum yet). Deduplication key `task-${taskId}-${eventType}-${day}` keeps notification floods in check.

See [QUESTIONS F8](../../QUESTIONS-agents-skills-tasks.md#f8--email--push-notifications-which-events).

## 5.6 Task → Idea promotion (v2)

Out of scope in v1, but the `tasks` table reserves `promotedToIdeaId: uuid | null` column from day one to keep the v2 migration small. See [QUESTIONS F3](../../QUESTIONS-agents-skills-tasks.md#f3--task--idea-promotion).

## 5.7 Idea → Work transition: tasks DO NOT follow [operator decision F4-b]

When a `WorkProposal` (Idea) transitions to `ACCEPTED` and its `acceptedWorkId` is set, **Idea-level tasks STAY on the Idea**. They do NOT auto-forward to the new Work.

The reason (operator clarification in [QUESTIONS F4](../../QUESTIONS-agents-skills-tasks.md#f4--idea--work-transition-forward-idea-scoped-tasks)):

> "The tasks that created for idea are usually tasks that just verify validity of idea, does it makes sense, how much it would cost and so on. Yes, some tasks can even do some implementations of idea, but probably unrelated to created Work. Basically from one Idea we can generate many Works, e.g. Mobile App work, Website Work, Landing Page Work etc from single idea and each of those Works can have own tasks / agents etc. While on Idea level, we can have separate tasks / agents that process such idea, unrelated to those Works (e.g. say we can have agent and tasks that will do marketing efforts for idea itself to see if it's valuable idea and measure interest etc)"

So the model is:

- **Idea-level tasks**: validity checks, cost estimation, market research, prototyping, anything that helps decide whether the Idea is worth pursuing. These live on the Idea forever — even after the Idea spawns Works.
- **Work-level tasks**: implementation, refinement, deployment, anything specific to one of the Works that came out of the Idea.

When an Idea is accepted and a Work is created, the platform:

1. Sets `acceptedWorkId` on the WorkProposal (existing behavior).
2. **Does NOT touch any `tasks` rows.** Idea-level tasks remain on the Idea.
3. The new Work starts with zero tasks; users / Agents create Work-level tasks fresh.

Cross-pollination is manual: a user (or Agent) can copy or reference an Idea-level task into a Work-level task via the existing `task_relations` table (`kind: 'follow-up'`) — but the platform never does it automatically.

## 5.8 Recurring tasks — ship in v1 [operator override F5]

Originally deferred; operator promoted to v1 explicitly:

> "We MUST have recurring tasks 100% in v1. I.e. some tasks will be recurring with own schedule of run etc. (using same infra we already have with Trigger.dev etc)"

### Behavior

A recurring task is a **template** that the platform regenerates on a schedule. The template carries:

- `isRecurring: true` (flag column on `tasks`).
- `recurrenceRule: string` — RFC 5545 RRULE format (e.g. `FREQ=WEEKLY;BYDAY=MO`, `FREQ=DAILY`, `FREQ=MONTHLY;BYMONTHDAY=1`). Parsed via the `rrule` npm package (well-supported library; no DIY parsing).
- `recurrenceTimezone: string` — defaults to `'UTC'`. Cron-like recurrences honor this for "every Monday at 9am MY local time" use cases.
- `nextOccurrenceAt: timestamp` — pre-computed for dispatcher efficiency.
- `recurrenceEndsAt: timestamp | null` — optional end date.
- `recurrenceMaxOccurrences: int | null` — optional max count.
- `recurrenceOccurredCount: int` — running counter.

On each tick of the new dispatcher, when `nextOccurrenceAt <= now`:

1. The platform **clones** the recurring task into a fresh instance with `parentRecurringTaskId = <template.id>`, `isRecurring = false`, status `todo`.
2. Carries over: title, description, priority, labels, assignees, reviewers, approvers, scope. Drops: chat history, attachments-from-prior-instance, watcher state.
3. Increments `recurrenceOccurredCount`.
4. Recomputes `nextOccurrenceAt`.
5. If `recurrenceEndsAt` or `recurrenceMaxOccurrences` reached, sets `isRecurring = false` on the template (effectively ended).
6. Emits `TASK_RECURRENCE_FIRED` activity row with `details: {templateId, instanceId, occurrenceNumber}`.

### Dispatcher

New Trigger.dev cron task `task-recurrence-dispatcher`:

- Cadence: `* * * * *` (every minute UTC) — matches Mission tick precedent.
- CAS-claim per template via `tasks.casClaimRecurrence(taskId, expectedNextOccurrenceAt)` (atomic UPDATE WHERE).
- Each fire batches up to 200 due templates.

### UI

- The "+ New Task" dialog gets a "Make this recurring" toggle. When on, surfaces:
    - Frequency picker (Daily / Weekly / Monthly / Custom RRULE).
    - Day-of-week / time-of-day pickers contextual to the frequency.
    - Optional end date and max-count.
- Task detail page shows a "Recurring" badge on the template and instances.
- Each instance has a "View template" link in the sidebar.
- Editing the template: a confirmation modal asks "Apply to future instances only, or update template (no retroactive changes)?" — v1 = template edits affect future instances only.

### Constraints

- Sub-tasks of a recurring template are themselves cloned on each fire. Sub-task chains aren't recursive (max depth 1).
- Recurring tasks **cannot** have parent tasks (the template is a root). A child of a recurring template instance can have its own parent set normally.
- Per-Agent budget enforcement applies normally — a recurring task whose assignee Agent runs out of budget will fail the same way a manually-created task does.

Full implementation tasks in [task-tracking/plan.md §3.1 Recurring tasks](./plan.md) and [task-tracking/tasks.md Phase 8 — Recurring tasks](./tasks.md).

## 5.9 "Related" auto-detection

When a user types a Task description that mentions `[[kb-doc-slug]]`, the platform records the link in `task_kb_mentions(taskId, kbDocumentId)`. The KB Document's "Related tasks" panel reads this join.

Tasks that mention the SAME KB doc become candidate "related" tasks — but v1 does NOT auto-create `task_relations` rows. Instead, the Task detail page's Related section shows a "Suggested" subsection populated by querying the join. The user can promote a suggestion to a real `task_relations` row.

## 5.10 Description edit history

v1 doesn't keep a revision history of Task descriptions. The current body is overwritten on every save. Activity log records `who + when` of each edit. See [QUESTIONS F7](../../QUESTIONS-agents-skills-tasks.md#f7--task-description-edit-history).

## 5.11 Cascade on delete

| Event                        | Cascade                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete Task                  | `task_assignees`, `task_reviewers`, `task_approvers`, `task_blocks`, `task_relations`, `task_chat_messages`, `task_attachments`, `task_watchers`, `task_kb_mentions` all CASCADE. |
| Delete User                  | User's tasks CASCADE. `task_assignees(assigneeType='user', assigneeId=<id>)` rows drop; tasks they were sole assignee on stay (the task author / scope owner can re-assign).      |
| Delete Agent                 | `task_assignees(assigneeType='agent', assigneeId=<id>)` rows drop. Task chat messages authored by deleted Agent: `authorId` becomes a dangling UUID — UI renders "Deleted Agent". |
| Delete Mission / Idea / Work | Tasks scoped to the deleted entity CASCADE. Tasks with `ideaId` AND `workId` set (after Idea→Work promotion) survive when Idea is deleted (still belong to the Work).             |

## 5.12 `@all` / `@here` semantics

Mentions like `@all` and `@here` in a `task_chat_messages.body`:

- Render visually like a mention (highlighted text).
- Do NOT trigger `agent-chat-reply` runs.
- Do NOT generate per-user notifications (avoid spam).

Only explicit `@<user-slug>` or `@<agent-slug>` mentions trigger dispatches/notifications. See [QUESTIONS — round 3 follow-up not yet promoted].

## 6. Out of Scope (v1)

- Time tracking (estimate/spent hours). v2.
- Recurring tasks. **MOVED TO v1 per operator F5 override** — see §5.8.
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
- UX spec: [`../UX-DESIGN-agents-skills-tasks.md`](../UX-DESIGN-agents-skills-tasks.md)
- Reuse map: [`../../architecture/implementation-reuse-map.md`](../../architecture/implementation-reuse-map.md)
- Architecture: [`../../architecture/agents-skills-tasks.md`](../../architecture/agents-skills-tasks.md)
- Agents: [`../agents/spec.md`](../agents/spec.md)
- Existing Kanban: [`apps/web/src/components/works/WorksKanbanView.tsx`](../../../apps/web/src/components/works/WorksKanbanView.tsx)
- KB editor reused for descriptions/chat: [`apps/web/src/components/works/detail/kb/KbEditor.tsx`](../../../apps/web/src/components/works/detail/kb/KbEditor.tsx)
- Constitution: [`../../../.specify/memory/constitution.md`](../../../.specify/memory/constitution.md)
