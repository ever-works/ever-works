---
id: generation-cancellation
title: Generation Cancellation
sidebar_label: Generation Cancellation
sidebar_position: 7
---

# Generation Cancellation

Long-running work generations can be cancelled mid-flight from the Web Dashboard or via the API. The platform routes the cancel request to wherever the run is actually executing — Trigger.dev, an in-process pipeline worker, or a stale "stuck" run that never started — and reports back what it did.

:::tip When to use this
Cancel a run when the prompt or providers were wrong and you don't want to wait it out, when a run is genuinely stuck on a flaky third-party API, or when iterating on a new pipeline plugin and you want to abort quickly.
:::

## How It Works

When you cancel a generation, the platform:

1. **Verifies ownership** — only work owners and members with edit rights can cancel.
2. **Checks status** — only works currently in the `generating` state can be cancelled. Otherwise the API responds with `409 Conflict`.
3. **Routes the cancel** — the actual cancellation strategy depends on where the run is executing:

    | Mode               | What it means                                                                                        |
    | ------------------ | ---------------------------------------------------------------------------------------------------- |
    | `trigger`          | An active Trigger.dev run was found and a cancellation was requested through the Trigger.dev SDK.    |
    | `in_process`       | The run is executing in the API process; an in-memory cancellation token is signalled.               |
    | `stale`            | No active run was found, but the work was still flagged as `generating`. Status was forced to ERROR. |
    | `already_finished` | Between the check and the cancel call, the run completed (success or failure). Nothing more to do.   |

4. **Updates state** — the work's `generateStatus` transitions to `cancelled`, the in-progress generation history record is closed, and an activity-log entry is written ("Generation cancelled for `<work>`").
5. **Returns immediately** — the endpoint returns `202 Accepted` while the worker tears down. Final state may take a few seconds to settle.

## API

| Method | Endpoint                           | Description                                       |
| ------ | ---------------------------------- | ------------------------------------------------- |
| `POST` | `/api/works/:id/cancel-generation` | Request cancellation of the active generation run |

```bash
curl -X POST http://localhost:3100/api/works/<work-id>/cancel-generation \
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

| Status | Reason                                                                          |
| ------ | ------------------------------------------------------------------------------- |
| `403`  | Caller does not have edit rights on the work                                    |
| `404`  | Work not found                                                                  |
| `409`  | Work is not currently generating (`generateStatus.status !== 'generating'`)     |
| `400`  | Cancellation requested but the deployment does not have a generation dispatcher |

## Statuses After Cancel

The work's `generateStatus.status` becomes `cancelled` (one of `generating`, `generated`, `error`, `cancelled`). In the activity log the run is marked **completed** with a "cancelled" summary message rather than failed — cancellation is a normal, user-driven outcome, not a fault.

A cancelled work is in a clean state: you can immediately start a new generation, edit settings, or rerun on the schedule.

## Web Dashboard

In the work page, while a generation is in progress, a **Cancel** control appears next to the live generation status. Clicking it confirms the action and then calls the API endpoint above. The same control is available from the activity views for works with active runs.

## Related

- [Works API](/api/works) — full endpoint reference
- [Work Lifecycle](/agent-services/work-lifecycle) — the states a work passes through
- [Scheduled Updates](./scheduled-updates) — cancelling a _schedule_ (the recurring config) is a separate operation
