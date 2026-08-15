# Tasks upgrades — schedule modes, workflow templates, subtasks UI

Branch: `session/feat-tasks-upgrades`. Feature brief: schedule modes (Run once |
Scheduled | Recurring incl. cron), recurring instances that actually execute,
Task Templates as workflows, and the Task-detail Subtasks / Schedule / Activity
sections plus attachment roles.

## What shipped

### 1. Schedule modes

- **Scheduled (one-shot)** — new `tasks.scheduledAt` + `tasks.scheduleClaimedAt`
  (`PortableDateColumn`, both nullable) with the composite index
  `idx_tasks_scheduled_due (scheduledAt, scheduleClaimedAt)`. The dispatcher
  CAS-claims a due row via `scheduleClaimedAt` and dispatches **the Task itself**
  (no clone — a one-shot IS the task).
- **Cron cadence for recurring** — new `tasks.recurrenceCron varchar(120)`, XOR
  with `recurrenceRule` (service validation in `TasksService.setRecurring`).
  `recurrence.ts#computeNextTemplateOccurrence` picks the dialect: RRULE through
  the `rrule` package, cron through `schedules/cadence.ts#computeNextCronFire`
  (evaluated in **UTC**, which is why the cron branch of the UI stamps
  `recurrenceTimezone: 'UTC'` and hides the timezone field).
- **Recurring instances execute** — `cloneRecurringTaskAsInstance` now keeps the
  full owner tuple (`teamId`/`agentId`/`goalId`), the dispatcher copies the
  template's `task_assignees` rows onto the spawned instance, and then dispatches
  through `TaskTransitionService.dispatchAgentRun` (THE single dispatch path, so
  the concurrency gate/credits precheck/denorm all apply). With no resolvable
  agent it emits the new `task_run_no_agent` notification instead of skipping
  silently.

### 2. Workflow Task Templates

- Entities `task_templates` (userId, name, slug unique per user, description,
  labels, tenant/org scope columns) and `task_template_steps` (templateId,
  position, title, prompt, agentId?, agentTemplateSlug?, requiresApproval,
  dependsOn int[]). Registered in `_entities-inventory.ts` + `_entity-names.ts` +
  `TasksDomainModule`.
- `TaskTemplatesService`: CRUD (owner-scoped, cross-user id ⇒ 404), Kahn-based
  cycle rejection on `dependsOn`, and `instantiateTemplate` — parent Task + one
  sub-task per step, `dependsOn` ⇒ `task_blocks` edges, per-step `agentId` ⇒
  `task_assignees`, `requiresApproval` ⇒ `task_approvers` for the owner, the
  per-step prompt appended to the sub-task description under a `## Agent prompt`
  heading — **all in one transaction**.
- Seeding: the default **Compound Engineering Workflow** (9 steps, starter-agent
  slugs as hints, no hard `agentId`) is created on a user's FIRST list call —
  a migration insert cannot know about future users. A lost seed race (unique
  violation) is swallowed.

### 3. Sub-tasks, activity, attachment roles

- `TasksService.listSubtasks` — the checklist projection: children of a Task plus
  `agentAssigneeIds` / `userAssigneeIds` / `approverCount` / `approvedCount` /
  `requiresApproval` / `approvalCleared` (the last derived under the row's own
  `requireAllApprovers` policy). Both side tables are fetched with ONE batched
  `IN` query each (`findByTaskIds`) — no N+1 on a 9-step workflow tree.
- `task_attachments.role varchar(16) default 'initial'` (`initial` | `result`),
  threaded through the DTO → controller → service → repository, and rendered as
  a corner chip on the attachment tile (only `result` is chipped; `initial` is
  the unmarked common case).
- Per-Task activity feed: `ActivityLogRepository.findResourceEvents` filters the
  activity log on the `details.resourceType`/`resourceId` fragments the
  task-domain writers already stamp (same portable-LIKE technique as
  `findAgentEvents`), user-scoped.

## Data model / migrations

| Migration                                 | Change                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `1785010000000-AddTaskScheduleColumns.ts` | `tasks.scheduledAt`, `tasks.scheduleClaimedAt`, `tasks.recurrenceCron`, `idx_tasks_scheduled_due`, `task_attachments.role` |
| `1785020000000-CreateTaskTemplates.ts`    | `task_templates` + `task_template_steps` (+ indexes + FKs, portable Table API)                                             |

Both are forward-only with per-step idempotent guards, and deliberately carry NO
scope XOR CHECK (`ScopeStampingSubscriber` stamps `organizationId` on insert, so
ordinary rows carry both columns — same reasoning as `CreateWorkflows`).

## Endpoints

| Method + path                              | Purpose                                                       |
| ------------------------------------------ | ------------------------------------------------------------- |
| `POST /api/tasks/:id/schedule`             | Arm/move a one-shot (`{runAt}`, future-only)                  |
| `DELETE /api/tasks/:id/schedule`           | Remove the one-shot (back to Run once)                        |
| `POST /api/tasks/:id/recurring`            | Now accepts EITHER `recurrenceRule` OR `recurrenceCron` (XOR) |
| `GET /api/tasks/:id/subtasks`              | Checklist projection (`{data, meta:{total,doneCount}}`)       |
| `GET /api/tasks/:id/activity`              | Per-Task activity rows (`?limit`/`?offset`, owner-scoped)     |
| `POST /api/tasks` / `PATCH /api/tasks/:id` | `scheduledAt` (ISO; `null` on PATCH clears the schedule)      |
| `POST /api/tasks/:id/attachments`          | `role: 'initial' \| 'result'`                                 |
| `api/task-templates` CRUD                  | Workflow templates (list seeds the default on first call)     |
| `POST /api/task-templates/:id/instantiate` | Expand into parent + sub-tasks (one transaction)              |

Every new DTO field was traced end to end (the "wired-but-dead" bug class): the
PATCH path needed an explicit `scheduledAt` string→`Date` mapping in the
controller, because the service works in `Date` and `body` is spread wholesale.

## UI

- `/tasks/[id]` — new **Subtasks** section (n/m checklist, per-row agent chip +
  approval badge + status, add-subtask input that inherits the parent's owner
  tuple), new **Schedule** section (mode radio Run once | Scheduled | Recurring;
  the recurring mode still renders the pre-existing `TaskRecurringSection`, which
  gained the cron option + examples helper text), new **Activity** section
  (server-hydrated audit trail with a link to the runs surface).
- `/tasks/new` — "Blank task | From template" toggle, workflow picker (name +
  step count), branch-name field, and a "Will create" preview listing the steps.
- `/tasks/templates` — the user's real workflow templates above the existing
  catalog cards (delete + step list + approval/agent-hint chips).
- i18n: new keys added to **all 21** locale files (English values copied, per the
  repo's no-machine-translation rule): `dashboard.tasksPage.{schedule,subtasks,
activity,templates}` plus additions to `newDialog`, `recurring`, `detail`.

## Test commands

```bash
# Agent domain (Jest)
cd packages/agent && npx jest --testPathPattern='(task-templates.service|tasks.service.schedule|tasks.service.subtasks|task-recurrence-dispatcher|recurrence)'
cd packages/agent && npx jest --testPathPattern='(tasks-domain|activity-log)'   # 33 suites / 518 tests green

# Web unit (Vitest)
cd apps/web && npx vitest run src/components/tasks/TaskScheduleSection.unit.spec.tsx src/components/tasks/TaskSubtasksSection.unit.spec.tsx

# Types
cd packages/agent && pnpm type-check
cd apps/web && npx tsc -p tsconfig.json --noEmit
cd apps/api && npx tsc -p tsconfig.json --noEmit      # see "known issues" below
```

E2E specs updated in the same change (contract drift, not new specs):
`flow-tasks-recurring-reviewers.spec.ts` and `flow-task-full-multistep.spec.ts`
pinned "missing `recurrenceRule` → class-validator array". `recurrenceRule` is
now `@IsOptional()` (because `recurrenceCron` is an alternative), so an empty
body is rejected by the controller's XOR guard with a STRING message; both specs
now assert that message, and the first also pins the both-dialects rejection.

## Known issues / follow-ups

- A bare `cd apps/api && npx tsc -p tsconfig.json --noEmit` reports 4
  pre-existing, environment-level module-resolution errors unrelated to this
  branch (`@ever-works/k8s-plugin` in `deploy.e2e.spec.ts`; `@src/*` aliases
  resolved from `packages/agent` sources). The packaged build is clean —
  `npx turbo build --filter=@ever-works/agent --filter=ever-works-api` is green
  end to end (`TSC Found 0 issues`), which is what CI runs.
- `apps/api`'s Jest suite was not run to completion here: it takes >10 min per
  invocation on this machine. The one spec that constructs `TasksController`
  positionally (`tasks.controller.pr-insights.spec.ts`) was run on its own and
  exits 0 — the new `@Optional()` constructor parameter is appended last, so
  positional fixtures keep compiling.
- No new Playwright specs for the new endpoints (`:id/schedule`,
  `:id/subtasks`, `:id/activity`, `api/task-templates`): they need a live
  API + DB, which this session had no stack for. A
  `flow-task-templates-validation-authz-matrix.spec.ts` mirroring the
  existing matrices (unknown body prop → 400, cross-user id → 404, bad
  uuid → 400, no auth → 401) is the natural next spec.
- Attachment `role` is settable through the API but the web uploader always
  sends `initial`; the `result` path is for agent-authored outputs (the chip
  already renders them).
- `GET /api/tasks/:id/subtasks` caps at `SUBTASKS_PAGE_SIZE` (200) with no
  paging — deeper trees are worked from the Tasks list. Add paging if a
  real tree ever exceeds it.
- Template steps carry `agentTemplateSlug` as a hint only; mapping a starter
  slug onto one of the user's Agents automatically (so the seeded workflow
  dispatches without manual assignment) is the obvious next step.
- The one-shot dispatcher shares the recurrence dispatcher's Trigger.dev cron
  task (two due-scans per tick). If one-shot volume ever dwarfs recurrences,
  split them into separate schedules so a slow scan cannot starve the other.
