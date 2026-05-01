---
id: notifications
title: Notifications API
sidebar_label: Notifications
sidebar_position: 8
---

# Notifications API

The notifications module provides in-app notifications for users, supporting categories, persistence levels, deduplication, and automatic cleanup. The API layer (`apps/api/src/notifications/`) exposes REST endpoints, while the agent package (`packages/agent/src/notifications/`) contains the core `NotificationService`.

## Architecture

```
apps/api/src/notifications/
  notifications.controller.ts       # REST endpoints
  notification-cleanup.service.ts   # Cron-based cleanup
  notifications.module.ts           # NestJS module

packages/agent/src/notifications/
  notification.service.ts           # Core notification logic
  notifications.module.ts           # Agent module
```

## Notification Types and Categories

**Types:** `ERROR`, `WARNING`, `INFO`, `SUCCESS`

**Categories:**

| Category       | Use Case                                    |
| -------------- | ------------------------------------------- |
| `ai_credits`   | AI provider credit depletion and errors     |
| `subscription` | Subscription and billing notifications      |
| `generation`   | Directory generation successes and failures |
| `system`       | Platform-level system notifications         |
| `security`     | Authentication and access-related alerts    |

## REST Endpoints

All endpoints require JWT authentication.

### GET `/api/notifications`

Retrieve notifications for the current user with optional filters.

| Query Parameter | Type    | Default | Description                                                                          |
| --------------- | ------- | ------- | ------------------------------------------------------------------------------------ |
| `unreadOnly`    | boolean | `false` | Return only unread notifications                                                     |
| `limit`         | number  | `50`    | Maximum results (capped at 100)                                                      |
| `offset`        | number  | `0`     | Pagination offset                                                                    |
| `category`      | string  | --      | Filter by category: `ai_credits`, `subscription`, `generation`, `system`, `security` |

### GET `/api/notifications/unread-count`

Returns the count of unread notifications.

```json
{ "count": 5 }
```

### GET `/api/notifications/persistent`

Returns persistent (critical) notifications displayed as global banners. Persistent notifications cannot be dismissed until the underlying issue is resolved.

### POST `/api/notifications/:id/read`

Mark a single notification as read.

### POST `/api/notifications/read-all`

Mark all notifications as read for the current user.

### POST `/api/notifications/:id/dismiss`

Dismiss a notification (hides it from view). Returns `400 Bad Request` if the notification is persistent.

## NotificationService

The core service provides both CRUD operations and domain-specific notification helpers.

### Creating Notifications

```typescript
await notificationService.create({
	userId: 'user-123',
	type: NotificationType.ERROR,
	category: NotificationCategory.AI_CREDITS,
	title: 'AI Credits Depleted',
	message: 'Your OpenAI credits have been exhausted.',
	actionUrl: '/settings',
	actionLabel: 'Add Credits',
	isPersistent: true,
	deduplicationKey: 'ai_credits_depleted_openai'
});
```

### Deduplication

Notifications support a `deduplicationKey` field. When set, the service checks for an existing non-dismissed notification with the same key before creating a new one. This prevents duplicate alerts (e.g., repeated credit depletion warnings). Race conditions are handled via unique constraint error detection across PostgreSQL, MySQL, and SQLite.

### Built-in Notification Helpers

| Method                           | Category     | Persistent | Description                             |
| -------------------------------- | ------------ | ---------- | --------------------------------------- |
| `notifyAiCreditsDepleted()`      | `ai_credits` | Yes        | AI provider credits exhausted           |
| `notifyAiProviderError()`        | `ai_credits` | No         | AI provider returned an error           |
| `notifyGenerationAccountError()` | `generation` | No         | Directory generation failed             |
| `notifySchedulePaused()`         | `generation` | No         | Scheduled updates paused                |
| `notifyGitAuthExpired()`         | `security`   | Yes        | Git provider token expired              |
| `clearByDeduplicationKey()`      | --           | --         | Remove notification when issue resolves |

## Cleanup Service

`NotificationCleanupService` runs daily at 3:00 AM via `@Cron(CronExpression.EVERY_DAY_AT_3AM)` and removes:

| Rule                                     | Retention |
| ---------------------------------------- | --------- |
| Expired notifications (past `expiresAt`) | Immediate |
| Dismissed notifications                  | 7 days    |
| All notifications                        | 30 days   |

The cleanup returns counts: `{ expired: number, dismissed: number, old: number }`.

## Module Registration

```typescript
@Module({
	imports: [AgentNotificationsModule, DatabaseModule],
	controllers: [NotificationsController],
	providers: [NotificationCleanupService],
	exports: [AgentNotificationsModule]
})
export class NotificationsModule {}
```
