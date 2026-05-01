---
id: scheduled-updates
title: Scheduled Updates
sidebar_label: Scheduled Updates
sidebar_position: 4
---

# Scheduled Updates

Scheduled Updates let you keep a directory's content fresh by re-running the AI generation pipeline on a recurring basis. You can choose from seven cadences ranging from hourly to monthly, and the platform handles retries, failure tracking, and billing automatically.

:::tip When to use this
Enable scheduled updates on directories where the underlying data changes frequently — for example, a directory of trending open-source projects that should reflect new entries every week.
:::

## Prerequisites

- The directory must have completed at least one generation (initial setup must be done first).
- At least one AI provider plugin must be active.
- Scheduled updates must be enabled globally (`SCHEDULED_UPDATES_ENABLED` environment variable, defaults to `true`).

## How It Works

1. **Schedule creation** — You set a cadence (hourly, daily, weekly, monthly) via the API or the Web Dashboard. The platform calculates the next run time.
2. **Automatic execution** — When `nextRunAt` arrives, the platform triggers a generation run using the directory's existing config.
3. **Success** — On completion, `nextRunAt` advances to the next cadence interval and the failure counter resets.
4. **Failure handling** — On error, the run is retried after 15 minutes. If failures exceed the `maxFailureBeforePause` threshold (default 3), the schedule is automatically paused and you receive a notification.
5. **Stuck run recovery** — Runs stuck in a "generating" state for over 1 hour are automatically marked as failed.

## Configuration

### Cadences

| Cadence          | Interval       |
| ---------------- | -------------- |
| `hourly`         | Every hour     |
| `every_3_hours`  | Every 3 hours  |
| `every_8_hours`  | Every 8 hours  |
| `every_12_hours` | Every 12 hours |
| `daily`          | Every 24 hours |
| `weekly`         | Every 7 days   |
| `monthly`        | Every 30 days  |

Available cadences may depend on your subscription plan. Cadences not included in your plan can still be used with pay-per-use billing.

### Billing Modes

| Mode           | Description                                               |
| -------------- | --------------------------------------------------------- |
| `subscription` | Counts against your plan's included scheduled directories |
| `usage`        | Pay-per-use — bypasses plan limits, any cadence available |

### Settings

| Field                     | Type    | Default        | Description                                                                                                          |
| ------------------------- | ------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `cadence`                 | string  | —              | `hourly`, `every_3_hours`, `every_8_hours`, `every_12_hours`, `daily`, `weekly`, or `monthly` (required on creation) |
| `billingMode`             | string  | `subscription` | `subscription` or `usage`                                                                                            |
| `maxFailureBeforePause`   | number  | `3`            | Consecutive failures before auto-pause (1–10)                                                                        |
| `alwaysCreatePullRequest` | boolean | `false`        | Force a PR for every scheduled run                                                                                   |
| `providerOverrides`       | object  | `null`         | Override AI, search, screenshot, content extractor, or pipeline plugins for this schedule                            |

### Provider Overrides

You can override which plugins the scheduled run uses, independent of the directory's default settings:

| Field              | Description                   |
| ------------------ | ----------------------------- |
| `ai`               | AI provider plugin ID         |
| `search`           | Search provider plugin ID     |
| `screenshot`       | Screenshot provider plugin ID |
| `contentExtractor` | Content extractor plugin ID   |
| `pipeline`         | Pipeline plugin ID            |

Each override must reference an installed and enabled plugin. Set `providerOverrides` to `null` to clear all overrides.

## API

All endpoints require JWT authentication.

### Get Schedule

| Method | Endpoint                        | Description                         |
| ------ | ------------------------------- | ----------------------------------- |
| `GET`  | `/api/directories/:id/schedule` | Get the current schedule and status |

```bash
curl http://localhost:3100/api/directories/<directory-id>/schedule \
  -H "Authorization: Bearer <token>"
```

**Response:**

```json
{
	"status": "success",
	"directoryId": "<uuid>",
	"schedule": {
		"status": "active",
		"cadence": "weekly",
		"billingMode": "subscription",
		"nextRunAt": "2026-02-26T10:00:00.000Z",
		"lastRunAt": "2026-02-19T10:00:00.000Z",
		"lastRunStatus": "generated",
		"failureCount": 0,
		"maxFailureBeforePause": 3,
		"alwaysCreatePullRequest": false,
		"allowedCadences": [
			{ "cadence": "weekly", "allowed": true },
			{ "cadence": "daily", "allowed": true },
			{ "cadence": "hourly", "allowed": false, "payPerUse": true, "reason": "Upgrade to Pro for this cadence" }
		],
		"subscriptionsEnabled": true,
		"providerOverrides": null
	}
}
```

### Create or Update Schedule

| Method | Endpoint                        | Description                 |
| ------ | ------------------------------- | --------------------------- |
| `PUT`  | `/api/directories/:id/schedule` | Create or update a schedule |

```bash
curl -X PUT http://localhost:3100/api/directories/<directory-id>/schedule \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "enable": true,
    "cadence": "weekly",
    "billingMode": "subscription",
    "maxFailureBeforePause": 5
  }'
```

**Request body — all fields optional:**

| Field                     | Type           | Description                                                                                   |
| ------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `enable`                  | boolean        | `true` to activate, `false` to pause                                                          |
| `cadence`                 | string         | `hourly`, `every_3_hours`, `every_8_hours`, `every_12_hours`, `daily`, `weekly`, or `monthly` |
| `billingMode`             | string         | `subscription` or `usage`                                                                     |
| `maxFailureBeforePause`   | number         | 1–10                                                                                          |
| `alwaysCreatePullRequest` | boolean        | Force PR on every run                                                                         |
| `providerOverrides`       | object or null | Plugin overrides (set to `null` to clear)                                                     |

**Errors:**

| Status | Reason                                                           |
| ------ | ---------------------------------------------------------------- |
| `400`  | Cadence not provided and no existing schedule                    |
| `400`  | Cadence not available on plan and billing mode is `subscription` |
| `400`  | `maxFailureBeforePause` outside 1–10                             |
| `400`  | Provider override references an uninstalled or disabled plugin   |
| `400`  | Activating would exceed plan's directory limit                   |
| `400`  | Directory has not completed initial generation                   |

### Cancel Schedule

| Method   | Endpoint                        | Description         |
| -------- | ------------------------------- | ------------------- |
| `DELETE` | `/api/directories/:id/schedule` | Cancel the schedule |

```bash
curl -X DELETE http://localhost:3100/api/directories/<directory-id>/schedule \
  -H "Authorization: Bearer <token>"
```

Canceling resets the schedule to its default state (cadence cleared, billing mode reset to `subscription`, provider overrides cleared).

### Run Immediately

| Method | Endpoint                            | Description                 |
| ------ | ----------------------------------- | --------------------------- |
| `POST` | `/api/directories/:id/schedule/run` | Trigger a scheduled run now |

```bash
curl -X POST http://localhost:3100/api/directories/<directory-id>/schedule/run \
  -H "Authorization: Bearer <token>"
```

Returns `202 Accepted`. The schedule must be in `active` status — returns `400` otherwise.

## Schedule Statuses

| Status     | Description                                                          |
| ---------- | -------------------------------------------------------------------- |
| `disabled` | Default state — schedule exists but was never activated              |
| `active`   | Running on the configured cadence                                    |
| `paused`   | Temporarily stopped (manually or due to exceeding failure threshold) |
| `canceled` | Schedule was deleted and reset                                       |

## Related

- [Directories API](/api/directories) — Full endpoint reference including schedule endpoints
- [AI & Generation](/ai-agents) — The generation pipeline that runs on each scheduled update
- [Collections](./collections) — Items generated by scheduled updates can be assigned to collections
