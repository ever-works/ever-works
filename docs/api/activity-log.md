---
id: activity-log
title: Activity Log API
sidebar_label: Activity Log
sidebar_position: 24
---

# Activity Log API

The activity log is a per-user audit trail of every significant action taken
on the platform — work creation, generation runs, deployments, plugin and
schedule changes, member invitations, account events, and more. The module
exposes both the read-side REST API (`apps/api/src/activity-log/`) and an
in-process event-driven write path that persists rows from cross-cutting
domain events.

The user-facing read surface lives in the **Activity Log** UI in the platform
dashboard. The same data also feeds the **running operations** sidebar badge
and the CSV export button.

## Architecture

```
apps/api/src/activity-log/
  activity-log.controller.ts   # 6 REST endpoints (list/running-count/summary/export/:id)
  activity-log.listener.ts     # 9 @OnEvent listeners that persist rows
  activity-log.module.ts       # Wires controller, listener, agent module, Jitsu
  jitsu.module.ts              # Forwards persisted rows to Jitsu (optional)
  jitsu.service.ts             # Env-gated jitsu/js client, no-op if unset

packages/agent/src/activity-log/
  activity-log.service.ts      # Persistence, querying, reconcile, summarize, CSV
  activity-log.module.ts       # Provides the service + repository
  ...
```

The `ActivityLogService` is the single writer. Domain code MUST NOT instantiate
its own `ActivityLog` entities — instead it either:

1. Calls `activityLogService.log(...)` directly (controllers do this for
   user-driven actions like `submit-item`, `regenerate-markdown`, etc.), or
2. Emits a domain event from `apps/api/src/events/` or
   `@ever-works/agent/events`, which the `ActivityLogListener` translates into
   the right `actionType` / `action` / `status` shape.

## Controller endpoints

All endpoints sit behind the global `AuthSessionGuard` and resolve the user
exclusively from `auth.userId` — there is no `userId` query parameter, and
cross-user access returns `404` via the `findByIdAndUserId` repository check.

Every endpoint runs `reconcileActivities(userId)` first (debounced via a
per-user in-flight `Promise` map plus a 5-second recently-completed cache).
That pass uses
`activityLogService.reconcileStaleGenerationActivities(userId)` to flip any
abandoned `IN_PROGRESS` rows to a terminal status by re-reading the work's
current `generateStatus`. Failures in that pass are swallowed so listing stays
available even if reconcile errors out.

### `GET /api/activity-log`

List paginated activity-log entries for the current user.

**Query parameters:**

| Param        | Type                                                     | Default | Description                                                                               |
| ------------ | -------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `actionType` | `ActivityActionType`                                     | —       | Filter by action type (e.g. `generation`, `deployment`, `work_created`). Full enum below. |
| `workId`     | `string`                                                 | —       | Restrict to one work.                                                                     |
| `status`     | `pending`/`in_progress`/`completed`/`failed`/`cancelled` | —       | Filter by status.                                                                         |
| `dateFrom`   | ISO 8601 date                                            | —       | Lower bound on `createdAt`.                                                               |
| `dateTo`     | ISO 8601 date                                            | —       | Upper bound on `createdAt`.                                                               |
| `search`     | `string`                                                 | —       | Substring match against `summary` and joined work name.                                   |
| `limit`      | `number`                                                 | `25`    | Page size, hard-capped at `100` (`Math.min(limit, 100)`).                                 |
| `offset`     | `number`                                                 | `0`     | Pagination offset.                                                                        |

**Response 200:**

```json
{
	"activities": [
		{
			"id": "01HXAB...",
			"userId": "user-123",
			"workId": "work-abc",
			"actionType": "generation",
			"action": "generation.completed",
			"status": "completed",
			"summary": "Generated 42 items for My Directory",
			"details": { "itemsCount": 42, "newItemsCount": 12, "updatedItemsCount": 30 },
			"metadata": null,
			"ipAddress": null,
			"userAgent": null,
			"createdAt": "2026-05-08T12:34:56.789Z",
			"updatedAt": "2026-05-08T12:35:01.123Z"
		}
	],
	"total": 1
}
```

### `GET /api/activity-log/running-count`

Returns the count of `IN_PROGRESS` rows for the user. Used by the sidebar
badge.

**Response 200:** `{ "count": 3 }`

### `GET /api/activity-log/summary`

Returns counts grouped by `ActivityStatus`. Used by the activity-log filters
panel.

**Response 200:** `{ "counts": { "pending": 0, "in_progress": 3, "completed": 142, "failed": 1, "cancelled": 0 } }`

### `GET /api/activity-log/export`

Streams a CSV download of all matching rows. Accepts the same `actionType` /
`workId` / `status` / `dateFrom` / `dateTo` filters as the list endpoint
(no pagination — the export hard-caps at 10 000 rows on the service side).

**Response 200:** `text/csv` with
`Content-Disposition: attachment; filename=activity-log.csv`. Header row is
`id,createdAt,actionType,action,status,summary` plus per-cell escaping of `"`,
`,`, and newlines.

### `GET /api/activity-log/:id`

Fetch a single entry by id. Returns `404` for cross-user ids.

If the entry is `status: in_progress` AND has a `workId`, the endpoint
enriches `details.liveLogs` from the work's `generateStatus.recentLogs` so the
UI can stream the running operation's most recent output without polling
another endpoint.

## Listener (write path)

The `ActivityLogListener` subscribes to nine `@OnEvent` events. Every handler
is wrapped in `try/catch + logger.error` so a write failure NEVER propagates
back to the originating domain event.

| Event                          | `actionType`        | `action`                                      | `status`                            | Notes                                                                                                                               |
| ------------------------------ | ------------------- | --------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `WorkCreatedEvent`             | `work_created`      | `work.created`                                | `completed`                         | Records the work's id and name.                                                                                                     |
| `WorkGenerationCompletedEvent` | `generation`        | `generation.completed`                        | resolved from `work.generateStatus` | Updates the existing `IN_PROGRESS` row in place (via `findLatestByUserWorkActionStatus`) so a single run produces one row, not two. |
| `WorksConfigSyncFailedEvent`   | `works_config_sync` | `works_config.sync_failed`                    | `failed`                            | `details.reason` + `details.repository` + `details.error`.                                                                          |
| `UserCreatedEvent`             | `user_signup`       | `user.signup`                                 | `completed`                         | Fired on first registration.                                                                                                        |
| `UserConfirmedEvent`           | `user_login`        | `user.confirmed`                              | `completed`                         | Fired on each session confirm; summary records the login provider.                                                                  |
| `UserPasswordChangedEvent`     | `password_changed`  | `user.password_changed`                       | `completed`                         | Captures `event.ipAddress` for security review.                                                                                     |
| `MemberInvitedEvent`           | `member_invited`    | `member.invited`                              | `completed`                         | `details.inviteeEmail` + `details.role`.                                                                                            |
| `DeploymentDispatchedEvent`    | `deployment`        | `deployment.dispatched`                       | `in_progress`                       | The verifier's later `Completed`/`Failed` event flips the same row to a terminal status.                                            |
| `DeploymentCompletedEvent`     | `deployment`        | `deployment.succeeded`                        | `completed`                         | Includes the deployment URL when present.                                                                                           |
| `DeploymentFailedEvent`        | `deployment`        | `deployment.failed` or `deployment.cancelled` | `failed` or `cancelled`             | The terminal state coerces both `action` and `status` (`CANCELED` → `cancelled`).                                                   |

Direct calls to `activityLogService.log(...)` from controllers are also
wrapped fire-and-forget via `.catch(() => {})` so an audit-write failure does
not break the user-facing endpoint. Examples in `works.controller.ts`:
`work.updated`, `work.deleted`, `work.markdown_regenerated`,
`work.readme_updated`, `work.website_updated`, `item_added`, `item_removed`,
`work.plugin_enabled`, `work.plugin_disabled`, `taxonomy.<entity>_<verb>`,
and `community_pr.processed`.

## Action-type taxonomy

`ActivityActionType` (declared in
`packages/agent/src/entities/activity-log.types.ts`) groups every persisted
row. The full enum is the read-side filter source-of-truth:

- **Generation** — `generation`, `comparison_generation`
- **Deployment** — `deployment`
- **Work lifecycle** — `work_created`, `work_updated`, `work_deleted`
- **Items** — `item_added`, `item_updated`, `item_removed`
- **Plugins** — `plugin_enabled`, `plugin_disabled`, `plugin_configured`
- **Templates** — `template_added`, `template_updated`, `template_archived`,
  `template_forked`, `template_default_set`
- **Members** — `member_invited`, `member_role_changed`, `member_removed`
- **Schedule** — `schedule_created`, `schedule_updated`, `schedule_deleted`,
  `schedule_executed`
- **Import / Export** — `import`, `export`
- **Settings** — `settings_updated`, `website_settings_updated`,
  `prompts_updated`, `works_config_sync`
- **Auth / Account** — `user_login`, `user_signup`, `provider_connected`,
  `password_changed`
- **Chat / AI** — `chat_conversation`
- **Community** — `community_pr_merged`

`ActivityStatus` is `pending` / `in_progress` / `completed` / `failed` /
`cancelled`.

## Optional analytics dispatcher (Jitsu)

`JitsuService` is an `ActivityLogAnalyticsDispatcher` implementation provided
in `JitsuModule`. It's enabled only when **both** `JITSU_HOST` and
`JITSU_WRITE_KEY` are set; otherwise the constructor logs `Jitsu analytics
disabled: missing JITSU_HOST or JITSU_WRITE_KEY` and the `track()` method
becomes a no-op.

When enabled, the service forwards every persisted row to Jitsu via
`@jitsu/js`. The dispatcher contract requires:

- The metadata gate is plain-object-only — arrays and primitives are dropped
  (`activity.metadata && typeof === 'object' && !Array.isArray`).
- The dispatcher MUST NOT throw out of `log()` / `updateStatus()` — the
  agent-side `ActivityLogService` rejects any dispatcher error so audit writes
  remain authoritative when downstream analytics is unavailable.

The forwarded payload merges the row's `metadata` with the canonical fields:

```json
{
	"...metadata": "...",
	"activityId": "01HX...",
	"userId": "user-123",
	"workId": "work-abc",
	"actionType": "generation",
	"action": "generation.completed",
	"status": "completed",
	"summary": "...",
	"details": { "...": "..." },
	"createdAt": "2026-05-08T12:34:56.789Z"
}
```

To plug a different sink (Segment, Mixpanel, custom warehouse), implement
`ActivityLogAnalyticsDispatcher` and provide it under the same DI token as
`JitsuService`.

## Reconciliation pass

Long-running generation rows can be left as `IN_PROGRESS` if the worker
process exits before the `WorkGenerationCompletedEvent` fires (crash, OOM,
SIGTERM during deploy). The controller-side `reconcileActivities(userId)`
front-step calls
`activityLogService.reconcileStaleGenerationActivities(userId)`, which:

1. Loads every `IN_PROGRESS` row for the user with `actionType: GENERATION`.
2. For each, re-reads the work and inspects `work.generateStatus`.
3. Skips rows whose work is still actively generating
   (`generateStatus.status` is itself `'GENERATING'` / `'PENDING'`).
4. Otherwise maps `CANCELLED` → `cancelled`, `ERROR`/anything-failed → `failed`,
   everything else → `completed`, and calls `updateStatus(...)`.

The pass is deliberately lazy (per-request, not a cron) and debounced
(in-flight Promise + 5-second recently-completed cache) to avoid stampedes
when the activity-log UI polls.

## Security

- **Per-user isolation**: every read uses `userId` from the resolved session;
  the `findByIdAndUserId` repository helper makes cross-user `:id` lookups
  return `null` (which the controller maps to `404`).
- **No secrets in metadata or details**: callers MUST NOT put credentials,
  tokens, or API keys in `details` / `metadata`. The Jitsu dispatcher
  forwards both fields verbatim, and the CSV export includes `summary`
  (which therefore must also be safe to display in the UI and email).
- **Cascade**: `userId` cascades on user deletion; `workId` is `ON DELETE
SET NULL` so historical rows survive a deleted work.

## Configuration

| Env var           | Purpose                                             |
| ----------------- | --------------------------------------------------- |
| `JITSU_HOST`      | Jitsu collector host. Required to enable analytics. |
| `JITSU_WRITE_KEY` | Jitsu write key. Required to enable analytics.      |

No other env vars are required — the module degrades gracefully if Jitsu is
disabled.

## Module registration

```typescript
@Module({
	imports: [JitsuModule, AgentActivityLogModule, DatabaseModule],
	controllers: [ActivityLogController],
	providers: [ActivityLogListener],
	exports: [AgentActivityLogModule]
})
export class ActivityLogModule {}
```

`AgentActivityLogModule` is re-exported so any consumer that imports
`ActivityLogModule` automatically gains access to `ActivityLogService` for
direct `log()` calls.

## Related

- Spec Kit feature: `docs/specs/features/activity-log/{spec,plan,tasks}.md`
  — the canonical source of truth for behaviour and edge cases.
- See [Authentication](/api/authentication) for `AuthSessionGuard` semantics.
- See [Notifications](/api/notifications) for the user-facing dispatch
  surface (the activity log is NOT sent to the user as a notification — it's
  read-only).
