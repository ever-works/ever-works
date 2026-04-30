---
id: generation-cancellation
title: Generation Cancellation
sidebar_label: Generation Cancellation
sidebar_position: 7
---

# Generation Cancellation

Long-running directory generations can be cancelled mid-flight from the Web Dashboard or via the API. The platform routes the cancel request to wherever the run is actually executing — Trigger.dev, an in-process pipeline worker, or a stale "stuck" run that never started — and reports back what it did.

:::tip When to use this
Cancel a run when the prompt or providers were wrong and you don't want to wait it out, when a run is genuinely stuck on a flaky third-party API, or when iterating on a new pipeline plugin and you want to abort quickly.
:::

## How It Works

When you cancel a generation, the platform:

1. **Verifies ownership** — only directory owners and members with edit rights can cancel.
2. **Checks status** — only directories currently in the `generating` state can be cancelled. Otherwise the API responds with `409 Conflict`.
3. **Routes the cancel** — the actual cancellation strategy depends on where the run is executing:

    | Mode               | What it means                                                                                             |
    | ------------------ | --------------------------------------------------------------------------------------------------------- |
    | `trigger`          | An active Trigger.dev run was found and a cancellation was requested through the Trigger.dev SDK.         |
    | `in_process`       | The run is executing in the API process; an in-memory cancellation token is signalled.                    |
    | `stale`            | No active run was found, but the directory was still flagged as `generating`. Status was forced to ERROR. |
    | `already_finished` | Between the check and the cancel call, the run completed (success or failure). Nothing more to do.        |

4. **Updates state** — the directory's `generateStatus` transitions to `cancelled`, the in-progress generation history record is closed, and an activity-log entry is written ("Generation cancelled for `<directory>`").
5. **Returns immediately** — the endpoint returns `202 Accepted` while the worker tears down. Final state may take a few seconds to settle.

## API

| Method | Endpoint                                 | Description                                       |
| ------ | ---------------------------------------- | ------------------------------------------------- |
| `POST` | `/api/directories/:id/cancel-generation` | Request cancellation of the active generation run |

```bash
curl -X POST http://localhost:3100/api/directories/<directory-id>/cancel-generation \
  -H "Authorization: Bearer <token>"
```

**Response (`202 Accepted`):**

```json
{
	"status": "success",
	"message": "Cancellation requested. The generation will stop shortly.",
	"mode": "trigger"
}
```

The `mode` field tells you which path the cancel took (see the table above) — useful when debugging stuck runs or verifying that Trigger.dev integration is wired up correctly.

**Errors:**

| Status | Reason                                                                           |
| ------ | -------------------------------------------------------------------------------- |
| `403`  | Caller does not have edit rights on the directory                                |
| `404`  | Directory not found                                                              |
| `409`  | Directory is not currently generating (`generateStatus.status !== 'generating'`) |
| `400`  | Cancellation requested but the deployment does not have a generation dispatcher  |

## Statuses After Cancel

The directory's `generateStatus.status` becomes `cancelled` (one of `generating`, `generated`, `error`, `cancelled`). In the activity log the run is marked **completed** with a "cancelled" summary message rather than failed — cancellation is a normal, user-driven outcome, not a fault.

A cancelled directory is in a clean state: you can immediately start a new generation, edit settings, or rerun on the schedule.

## Web Dashboard

In the directory page, while a generation is in progress, a **Cancel** control appears next to the live generation status. Clicking it confirms the action and then calls the API endpoint above. The same control is available from the activity views for directories with active runs.

## Related

- [Directories API](/api/directories) — full endpoint reference
- [Directory Lifecycle](/agent-services/directory-lifecycle) — the states a directory passes through
- [Scheduled Updates](./scheduled-updates) — cancelling a _schedule_ (the recurring config) is a separate operation
