---
id: websocket-events
title: Events & Notifications
sidebar_label: Events & Notifications
sidebar_position: 21
---

# Events & Notifications

The Ever Works API uses the NestJS `EventEmitterModule` for internal event-driven communication and a REST-based notification system for delivering messages to users. There is no WebSocket gateway; all real-time-like behavior is achieved through event-driven processing on the server and client-side polling via the notification REST API.

## Architecture Overview

```
Event Producers (Services)
  ├── AuthService                  -- User lifecycle events
  ├── WorkOperationsService   -- Work generation events
  ├── WorkImportService       -- Import completion events
  ├── WorkGenerationService   -- Generation completion events
  ├── PluginRegistryService        -- Plugin lifecycle events
  ├── PluginLifecycleManager       -- Plugin load/unload events
  └── PluginSettingsService        -- Plugin settings change events

EventEmitterModule (in-process event bus)

Event Consumers (Listeners)
  ├── MailService                  -- Sends transactional emails
  ├── WorkCleanupService      -- Clears cache on generation complete
  └── NotificationService          -- Creates persistent notifications

Notification Delivery
  └── NotificationsController      -- REST API for client polling
```

## Event System Configuration

The event emitter is registered globally in `ApiModule`:

```typescript
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
	imports: [
		EventEmitterModule.forRoot()
		// ... other modules
	]
})
export class ApiModule {}
```

This enables any service to emit events via the injected `EventEmitter2` instance and any service to listen via `@OnEvent()` decorators.

## Event Classes

### Base Classes

Two base classes define the event hierarchy:

**API Events (`apps/api/src/events/index.ts`):**

```typescript
export abstract class BaseUserEvent {
	public abstract user: User;
}
```

**Agent Events (`packages/agent/src/events/base.ts`):**

```typescript
export abstract class BaseEvent {
	static EVENT_NAME: string;
}
```

### User Lifecycle Events

All user events extend `BaseUserEvent` and are defined in `apps/api/src/events/index.ts`. They are emitted by `AuthService` and consumed by `MailService`.

| Event Class                | Event Name              | Trigger                            | Consumer                          |
| -------------------------- | ----------------------- | ---------------------------------- | --------------------------------- |
| `UserCreatedEvent`         | `user.created`          | User registration                  | Sends signup confirmation email   |
| `UserConfirmedEvent`       | `user.confirmed`        | Email verification or OAuth signup | Sends welcome email               |
| `UserForgotPasswordEvent`  | `user.forgot_password`  | Password reset request             | Sends forgot-password email       |
| `UserPasswordChangedEvent` | `user.password_changed` | Password change                    | Sends password-changed alert      |
| `UserNewDeviceLoginEvent`  | `user.new_device_login` | Login from unrecognized device     | Sends new-device alert            |
| `UserAccountDeletionEvent` | `user.delete_account`   | Account deletion request           | Sends deletion confirmation email |
| `MemberInvitedEvent`       | `work.member_invited`   | User invited to a work             | Sends invitation email            |

### Work Events

Work events extend `BaseEvent` and are defined in `packages/agent/src/events/`.

| Event Class                    | Event Name                  | Trigger                | Consumer            |
| ------------------------------ | --------------------------- | ---------------------- | ------------------- |
| `WorkCreatedEvent`             | `work.created`              | New work created       | Internal processing |
| `WorkGenerationCompletedEvent` | `work.generation.completed` | AI generation finishes | Cache cleanup       |

### Plugin Lifecycle Events

Plugin events use string constants from `PluginEvents` in `packages/agent/src/plugins/plugins.constants.ts`:

```typescript
export const PluginEvents = {
	LOADED: 'plugin:loaded',
	UNLOADED: 'plugin:unloaded',
	ERROR: 'plugin:error',
	SETTINGS_CHANGED: 'plugin:settings-changed',
	STATE_CHANGED: 'plugin:state-changed',
	REGISTERED: 'plugin:registered',
	UNREGISTERED: 'plugin:unregistered'
} as const;
```

| Event                     | Emitted By               | Payload                            |
| ------------------------- | ------------------------ | ---------------------------------- |
| `plugin:loaded`           | `PluginLifecycleManager` | `{ pluginId, metadata }`           |
| `plugin:unloaded`         | `PluginLifecycleManager` | `{ pluginId }`                     |
| `plugin:error`            | `PluginLifecycleManager` | `{ pluginId, error }`              |
| `plugin:settings-changed` | `PluginSettingsService`  | `{ pluginId, userId, changes }`    |
| `plugin:state-changed`    | `PluginRegistryService`  | `{ pluginId, oldState, newState }` |
| `plugin:registered`       | `PluginRegistryService`  | `{ pluginId, metadata }`           |
| `plugin:unregistered`     | `PluginRegistryService`  | `{ pluginId }`                     |

## Event Producers

### AuthService

The `AuthService` emits user lifecycle events during authentication flows:

```typescript
// User registration
this.eventEmitter.emit(UserCreatedEvent.EVENT_NAME, new UserCreatedEvent(user, verificationToken, callbackUrl));

// Email verification
this.eventEmitter.emit(
	UserConfirmedEvent.EVENT_NAME,
	new UserConfirmedEvent(updatedUser, `${this.webAppUrl}/works/new`)
);

// Password reset request
this.eventEmitter.emit(
	UserForgotPasswordEvent.EVENT_NAME,
	new UserForgotPasswordEvent(user, resetToken, callbackUrl, '1 hour')
);
```

OAuth sign-ups (GitHub, Google) also emit `UserConfirmedEvent` after creating a new user, bypassing the email verification step.

### WorkOperationsService

Emits `WorkGenerationCompletedEvent` when AI content generation finishes for a work. This triggers cache invalidation in `WorkCleanupService`.

### WorkImportService

Emits `WorkGenerationCompletedEvent` after importing work content from external sources. Also emits `WorkCreatedEvent` when a new work is created during import.

## Event Consumers

### MailService (Email Sender)

**Source:** `apps/api/src/mail/mail.service.ts`

The primary event consumer. Listens to all 7 user lifecycle events and sends the corresponding transactional email using Handlebars templates.

```typescript
@OnEvent(UserCreatedEvent.EVENT_NAME)
async sendSignupConfirmation(data: UserCreatedEvent): Promise<void> { ... }

@OnEvent(UserForgotPasswordEvent.EVENT_NAME)
async sendForgotPassword(data: UserForgotPasswordEvent): Promise<void> { ... }

@OnEvent(UserPasswordChangedEvent.EVENT_NAME)
async sendPasswordChanged(data: UserPasswordChangedEvent): Promise<void> { ... }

@OnEvent(UserConfirmedEvent.EVENT_NAME)
async sendWelcomeEmail(data: UserConfirmedEvent): Promise<void> { ... }

@OnEvent(UserNewDeviceLoginEvent.EVENT_NAME)
async sendNewDeviceAlert(data: UserNewDeviceLoginEvent): Promise<void> { ... }

@OnEvent(UserAccountDeletionEvent.EVENT_NAME)
async sendAccountDeletionConfirmation(data: UserAccountDeletionEvent): Promise<void> { ... }

@OnEvent(MemberInvitedEvent.EVENT_NAME)
async sendMemberInvitation(data: MemberInvitedEvent): Promise<void> { ... }
```

Each handler wraps the email send in a try-catch and logs failures without throwing, ensuring a failed email does not disrupt the originating operation.

### WorkCleanupService (Cache Invalidation)

**Source:** `apps/api/src/works/tasks/work-cleanup.service.ts`

Listens for generation completion to clear cached data:

```typescript
@OnEvent(WorkGenerationCompletedEvent.EVENT_NAME)
clearWorkCache(data: WorkGenerationCompletedEvent) {
    this.cacheRepository.typeormAdapter
        .deleteUnscopedEntriesLike(data.work.id)
        .then(() => this.logger.log(`Cache cleared for work ${data.work.id}`))
        .catch((err) => this.logger.error('Failed to clear cache:', err));
}
```

This service also runs a scheduled job every 10 minutes to detect stalled generations and mark them as errors.

## Notification System

Instead of WebSockets, the platform uses a database-backed notification system with REST polling.

### Notification Entity

**Source:** `packages/agent/src/entities/notification.entity.ts`

```typescript
@Entity({ name: 'notifications' })
@Index(['userId', 'isRead'])
@Index(['userId', 'deduplicationKey'], { unique: true, where: '"deduplicationKey" IS NOT NULL' })
export class Notification {
	id: string; // UUID primary key
	userId: string; // Owner
	type: NotificationType; // info, warning, error, success
	category: NotificationCategory;
	title: string; // Up to 200 chars
	message: string; // Full text
	actionUrl?: string; // Deep link
	actionLabel?: string; // Button label
	metadata?: Record<string, any>;
	isRead: boolean;
	isDismissed: boolean;
	isPersistent: boolean; // Cannot be dismissed
	createdAt: Date;
	expiresAt?: Date;
	deduplicationKey?: string;
}
```

### Notification Types and Categories

| Type      | Description                  |
| --------- | ---------------------------- |
| `info`    | Informational messages       |
| `warning` | Warnings requiring attention |
| `error`   | Errors requiring action      |
| `success` | Success confirmations        |

| Category       | Description                             |
| -------------- | --------------------------------------- |
| `ai_credits`   | AI credit depletion and provider errors |
| `subscription` | Subscription-related notifications      |
| `generation`   | Work generation status                  |
| `system`       | System-level messages                   |
| `security`     | Security alerts (auth expiration)       |

### NotificationService

**Source:** `packages/agent/src/notifications/notification.service.ts`

Provides CRUD operations with deduplication and lifecycle management:

| Method                                 | Description                            |
| -------------------------------------- | -------------------------------------- |
| `create(dto)`                          | Create notification with deduplication |
| `getNotifications(userId, options)`    | Query with filters                     |
| `getUnreadCount(userId)`               | Count unread                           |
| `markAsRead(userId, id)`               | Mark single as read                    |
| `markAllAsRead(userId)`                | Mark all as read                       |
| `dismiss(userId, id)`                  | Hide from view (not persistent)        |
| `getPersistentNotifications(userId)`   | Get critical alerts                    |
| `clearByDeduplicationKey(userId, key)` | Clear resolved issues                  |
| `cleanup()`                            | Delete expired/old notifications       |

**Convenience methods** for common notification scenarios:

| Method                                                        | Category     | Persistent |
| ------------------------------------------------------------- | ------------ | ---------- |
| `notifyAiCreditsDepleted(userId, provider)`                   | `ai_credits` | Yes        |
| `notifyAiProviderError(userId, provider, message)`            | `ai_credits` | No         |
| `notifyGenerationAccountError(userId, workId, name, message)` | `generation` | No         |
| `notifySchedulePaused(userId, workId, name, reason)`          | `generation` | No         |
| `notifyGitAuthExpired(userId, provider)`                      | `security`   | Yes        |

### Deduplication

Notifications support deduplication via an optional `deduplicationKey`. When a key is provided, the service checks for an existing non-dismissed notification with the same key before creating a new one. Race conditions are handled by catching unique constraint violations:

```typescript
async create(dto: CreateNotificationDto): Promise<Notification> {
    if (dto.deduplicationKey) {
        const existing = await this.repository.findByDeduplicationKey(
            dto.userId, dto.deduplicationKey,
        );
        if (existing && !existing.isDismissed) return existing;
    }
    // ... create with race condition handling
}
```

### REST API Endpoints

**Source:** `apps/api/src/notifications/notifications.controller.ts`

All endpoints require JWT authentication and are under `/api/notifications`.

| Method | Endpoint                          | Description                     |
| ------ | --------------------------------- | ------------------------------- |
| `GET`  | `/api/notifications`              | List notifications with filters |
| `GET`  | `/api/notifications/unread-count` | Get unread count                |
| `GET`  | `/api/notifications/persistent`   | Get critical alerts             |
| `POST` | `/api/notifications/:id/read`     | Mark as read                    |
| `POST` | `/api/notifications/read-all`     | Mark all as read                |
| `POST` | `/api/notifications/:id/dismiss`  | Dismiss notification            |

**Query Parameters for listing:**

| Parameter    | Type      | Default | Description                 |
| ------------ | --------- | ------- | --------------------------- |
| `unreadOnly` | `boolean` | `false` | Filter to unread only       |
| `limit`      | `number`  | `50`    | Max results (capped at 100) |
| `offset`     | `number`  | `0`     | Pagination offset           |
| `category`   | `string`  | --      | Filter by category          |

## Event Flow Diagrams

### User Registration Flow

```
AuthService.register()
  --> emit(UserCreatedEvent)
  --> MailService.sendSignupConfirmation()
  --> Sends "signup-confirmation" email with verification link

AuthService.verifyEmail()
  --> emit(UserConfirmedEvent)
  --> MailService.sendWelcomeEmail()
  --> Sends "welcome" email with dashboard link
```

### Work Generation Flow

```
WorkGenerationService.generate()
  --> AI content generation completes
  --> emit(WorkGenerationCompletedEvent)
  --> WorkCleanupService.clearWorkCache()
  --> Clears all cache entries for the work

WorkCleanupService.handleStalledGenerations() [every 10 min]
  --> Finds works stuck in GENERATING for too long
  --> Marks them as ERROR status
```

### Plugin Settings Change Flow

```
PluginSettingsService.upsertSettings()
  --> Persists settings to database
  --> emit(PluginEvents.SETTINGS_CHANGED)
  --> Plugin system reacts to configuration changes
```

## Source Files

| File                                                           | Purpose                          |
| -------------------------------------------------------------- | -------------------------------- |
| `apps/api/src/events/index.ts`                                 | User lifecycle event definitions |
| `apps/api/src/mail/mail.service.ts`                            | Email event consumers            |
| `apps/api/src/works/tasks/work-cleanup.service.ts`             | Generation event consumer        |
| `apps/api/src/notifications/notifications.controller.ts`       | Notification REST API            |
| `apps/api/src/auth/services/auth.service.ts`                   | User event emitter               |
| `apps/api/src/api.module.ts`                                   | EventEmitterModule registration  |
| `packages/agent/src/events/base.ts`                            | Base event class                 |
| `packages/agent/src/events/work-generation-completed.event.ts` | Generation completed event       |
| `packages/agent/src/events/work-created.event.ts`              | Work created event               |
| `packages/agent/src/plugins/plugins.constants.ts`              | Plugin event constants           |
| `packages/agent/src/notifications/notification.service.ts`     | Notification business logic      |
| `packages/agent/src/entities/notification.entity.ts`           | Notification database entity     |
| `packages/agent/src/entities/notification.types.ts`            | Notification types and enums     |
