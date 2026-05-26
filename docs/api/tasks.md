---
id: tasks
title: Tasks API
sidebar_label: Tasks
sidebar_position: 42
---

# Tasks API

Trackable work items assigned to users or Agents. Shipped as a
plugin capability per ADR-013; the first-party **Ever Works Task
Tracker** plugin is a thin shim over the platform's own DB-backed
implementation. Community plugins (Linear / Jira / GitHub Issues)
drop in by implementing the same `ITaskTrackerPlugin` contract.

All routes are `@CurrentUser()`-scoped. Cross-user reads return 404.

## CRUD

| Method | Path                | Description                                                                |
| ------ | ------------------- | -------------------------------------------------------------------------- |
| GET    | `/api/tasks`        | List with filters (status, priority, scope, label, search). Paginated.     |
| POST   | `/api/tasks`        | Create a Task. (60/min)                                                     |
| GET    | `/api/tasks/:id`    | Get one.                                                                    |
| PATCH  | `/api/tasks/:id`    | Update fields. (60/min)                                                     |
| DELETE | `/api/tasks/:id`    | Delete (cascades to side rows). (30/min)                                    |

## Transitions

State machine — see `TaskTransitionService`:

```
backlog   → todo / cancelled
todo      → in_progress / blocked / cancelled
in_progress → in_review / blocked / done / cancelled
in_review → in_progress / blocked / done / cancelled
blocked   → todo / in_progress / cancelled
done      → in_progress  (reopen)
cancelled → (terminal)
```

`→ done` requires:
1. No open blockers (integrity — `force=true` does NOT override).
2. When `requireAllApprovers=true`, all approvers must be approved
   (policy — `force=true` DOES override).

| Method | Path                        | Description                              |
| ------ | --------------------------- | ---------------------------------------- |
| POST   | `/api/tasks/:id/transition` | Body: `{to, force?}`. (60/min)            |

## Members

| Method | Path                                      | Description                              |
| ------ | ----------------------------------------- | ---------------------------------------- |
| POST   | `/api/tasks/:id/assignees`                | Add `{assigneeType, assigneeId}`. (60/min) |
| DELETE | `/api/tasks/:id/assignees/:assigneeId`    | Remove one.                              |
| POST   | `/api/tasks/:id/reviewers`                | Add a reviewer.                          |
| POST   | `/api/tasks/:id/approvers`                | Add an approver.                         |
| POST   | `/api/tasks/:id/blocks`                   | Add `{blockedByTaskId}`.                  |
| DELETE | `/api/tasks/:id/blocks/:blockId`          | Remove a blocker.                         |
| POST   | `/api/tasks/:id/relations`                | Add `{relatedTaskId, kind}` — `related` / `duplicates` / `follow-up`. |

## Chat

| Method | Path                                  | Description                                                                       |
| ------ | ------------------------------------- | --------------------------------------------------------------------------------- |
| GET    | `/api/tasks/:id/chat?limit=&offset=`  | Paginated chat thread (newest last).                                              |
| POST   | `/api/tasks/:id/chat`                 | Post a message. Body secret-scanned, 16 KB cap. Mention parser strips unknown @ tokens server-side (T6 mitigation). (60/min) |
| PATCH  | `/api/task-chat-messages/:id`         | Edit within 5 min of `createdAt`. Past the window returns 403. (60/min)            |

## Recurring tasks (Phase 17)

| Method | Path                          | Description                                                                                                            |
| ------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/tasks/:id/recurring`    | Body: `{recurrenceRule, recurrenceTimezone?, recurrenceEndsAt?, recurrenceMaxOccurrences?}`. RRULE per RFC 5545. (30/min) |
| DELETE | `/api/tasks/:id/recurring`    | Stop recurrence on a template. Existing spawned instances are kept.                                                    |

The `task-recurrence-dispatcher` Trigger.dev cron walks templates
where `nextOccurrenceAt <= now`, CAS-claims each one, clones a
fresh instance via `cloneRecurringTaskAsInstance`, and advances
`nextOccurrenceAt` to the next computed slot.

## Spend

| Method | Path                                                  | Description                          |
| ------ | ----------------------------------------------------- | ------------------------------------ |
| GET    | `/api/tasks/:id/spend?since=&until=&currency=`        | Per-Task spend rollup in cents.       |

Backed by `PluginUsageRepository.getTotalSpendCentsForTask()` over
the `plugin_usage_events.taskId` column (Phase 11.4 migration adds
the column + index).

## Notes

- Slugs are generated atomically per-user (`UserTaskCounter`) as
  `T-<n>`.
- Activity-log rows: `TASK_CREATED / UPDATED / DELETED /
  TRANSITIONED / ASSIGNEE_ADDED / ASSIGNEE_REMOVED / BLOCKER_ADDED /
  BLOCKER_REMOVED / ASSIGNED / COMMENTED / COMPLETED /
  RECURRENCE_FIRED`.
- `→ in_progress` with any Agent assignee fan-outs to the
  `agent-task-execute` Trigger.dev runs (Phase 15.3). `@<agent-slug>`
  mentions in chat fan-out to `agent-chat-reply` (Phase 15.4). Both
  dispatch hooks are failure-tolerant — the platform write succeeds
  even if the Trigger.dev runtime is unavailable.
