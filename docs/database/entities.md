---
id: entities
title: Database Entities
sidebar_label: Entities
sidebar_position: 1
---

# Database Entities

Ever Works uses TypeORM entities to define the database schema. All entities live in `packages/agent/src/entities/` and are registered in the centralized `ENTITIES` array in `database.config.ts`.

## Entity Registry

The platform registers 15 entities across core domain, authentication, billing, and plugin concerns:

```typescript
export const ENTITIES = [
	Directory,
	DirectoryAdvancedPrompts,
	DirectoryMember,
	User,
	RefreshToken,
	OAuthToken,
	CacheEntry,
	DirectoryGenerationHistory,
	SubscriptionPlan,
	UserSubscription,
	DirectorySchedule,
	UsageLedgerEntry,
	Notification,
	PluginEntity,
	UserPluginEntity,
	DirectoryPluginEntity
];
```

## Core Entities

### Directory

**Table**: `directories` | **Primary Key**: UUID

The central domain entity representing a directory project. Contains 40+ columns spanning generation state, deployment, scheduling, community PRs, comparisons, and website template tracking.

| Column Group         | Key Fields                                                                                                     | Notes                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Identity**         | `id`, `name`, `slug`, `userId`                                                                                 | Slug used for repository naming |
| **Git**              | `owner`, `gitProvider`, `repoVisibility`                                                                       | Default provider: `github`      |
| **Deploy**           | `deployProvider`, `deploymentState`, `deploymentStartedAt`                                                     | Default: `vercel`               |
| **Generation**       | `generateStatus`, `generationStartedAt`, `generationProgressedAt`, `generationFinishedAt`                      | Status stored as `simple-json`  |
| **Domain Type**      | `domainType`, `domainTypeConfidence`, `domainTypeManuallySet`                                                  | For smart image routing         |
| **Scheduling**       | `scheduledUpdatesEnabled`, `scheduledCadence`, `scheduledNextRunAt`, `scheduledStatus`                         | Inline schedule fields          |
| **Website Template** | `websiteTemplateAutoUpdate`, `websiteTemplateUseBeta`, `websiteTemplateLastCommit`, `websiteTemplateLastError` | Auto-update tracking            |
| **Community PR**     | `communityPrEnabled`, `communityPrAutoClose`, `communityPrState`                                               | PR processing state as JSON     |
| **Timestamps**       | `createdAt`, `updatedAt`                                                                                       | Auto-managed by TypeORM         |

**Relations**:

```
Directory --> User           (ManyToOne, eager, CASCADE delete)
Directory --> GenerationHistory  (OneToMany)
Directory --> DirectorySchedule  (OneToOne)
Directory --> DirectoryMember    (OneToMany)
```

**Helper Methods**:

- `getDataRepo()` -- Returns `<slug>-data`
- `getWebsiteRepo()` -- Returns `<slug>-website`
- `getMainRepo()` -- Returns the slug itself
- `getRepoOwner()` -- Returns owner or user's username
- `isCreator(userId)` -- Checks if user is the original creator
- `hasAccess(userId)` -- Checks creator or member status
- `getUserRole(userId)` -- Returns the user's role in this directory

### User

**Table**: `users` | **Primary Key**: UUID

| Column                                       | Type             | Notes                       |
| -------------------------------------------- | ---------------- | --------------------------- |
| `username`                                   | `string`         | Display name                |
| `email`                                      | `string`         | Unique constraint           |
| `password`                                   | `string`         | Bcrypt hashed               |
| `registrationProvider`                       | `string`         | `local`, `github`, `google` |
| `avatar`                                     | `string`         | Nullable                    |
| `emailVerified`                              | `boolean`        | Default `false`             |
| `emailVerificationToken`                     | `string`         | For email confirmation      |
| `isActive`                                   | `boolean`        | Default `true`              |
| `lastLoginAt`, `lastLoginIp`                 | `Date`, `string` | Login tracking              |
| `passwordResetToken`, `passwordResetExpires` | `string`, `Date` | Password reset flow         |
| `defaultPlanId`                              | `string`         | FK to SubscriptionPlan      |

All `OneToMany` relations on User use `lazy: true` (return Promises) to avoid loading large collections eagerly.

### DirectoryGenerationHistory

**Table**: `directory_generation_history` | **Primary Key**: UUID

Tracks every generation run with metrics, timing, and error state.

**Indexes**: `[directoryId, status]`, `[triggeredBy]`, `[scheduleId]`

| Column                                                  | Type                            | Purpose                                     |
| ------------------------------------------------------- | ------------------------------- | ------------------------------------------- |
| `status`                                                | `GenerateStatusType`            | Current generation status                   |
| `generationMethod`                                      | `GenerationMethod`              | RECREATE, APPEND, or UPDATE                 |
| `triggeredBy`                                           | `'user' \| 'schedule' \| 'api'` | Who initiated the run                       |
| `triggerRunId`                                          | `string`                        | Trigger.dev run identifier                  |
| `metrics`                                               | `GenerationMetrics (JSON)`      | URLs scanned, items extracted, tokens, cost |
| `newItemsCount`, `updatedItemsCount`, `totalItemsCount` | `int`                           | Item counters                               |
| `startedAt`, `finishedAt`, `durationInSeconds`          | timestamp/int                   | Timing                                      |
| `errorMessage`                                          | `text`                          | Error details if failed                     |

### DirectoryMember

**Table**: `directory_members` | **Primary Key**: UUID

Implements role-based access control for directory collaboration.

**Unique Constraint**: `[directoryId, userId]` -- A user can only have one membership per directory.

| Role      | Level | Capabilities                                              |
| --------- | ----- | --------------------------------------------------------- |
| `OWNER`   | 4     | Reserved for directory creator (implicit, not assignable) |
| `MANAGER` | 3     | Edit content, manage members                              |
| `EDITOR`  | 2     | Edit content only                                         |
| `VIEWER`  | 1     | Read-only access                                          |

Helper methods: `hasRoleOrHigher(role)`, `canManageMembers()`, `canEdit()`.

## Authentication Entities

### RefreshToken

**Table**: `refresh_tokens`

Supports refresh token rotation with family-based tracking for detecting token reuse attacks.

| Column                                  | Purpose                            |
| --------------------------------------- | ---------------------------------- |
| `token`                                 | Unique token string (indexed)      |
| `family`                                | Groups related tokens for rotation |
| `revoked`, `revokedAt`, `revokedReason` | Revocation tracking                |
| `userAgent`, `ipAddress`                | Device fingerprinting              |
| `expiresAt`                             | TTL (indexed)                      |

### OAuthToken

**Table**: `oauth_tokens`

Stores OAuth access and refresh tokens per provider per user. Uses `lazy: true` for the User relation.

| Column                        | Purpose                         |
| ----------------------------- | ------------------------------- |
| `provider`                    | `github`, `google`, etc.        |
| `accessToken`, `refreshToken` | Token values (text)             |
| `username`, `email`           | Provider profile data           |
| `scope`                       | Comma-separated granted scopes  |
| `metadata`                    | JSON for provider-specific data |

## Billing Entities

### SubscriptionPlan

**Table**: `subscription_plans`

**Indexes**: `[code]` (unique), `[active]`

Defines available subscription tiers with pricing and feature limits.

| Column               | Type                   | Purpose                               |
| -------------------- | ---------------------- | ------------------------------------- |
| `code`               | `SubscriptionPlanCode` | `free`, `standard`, `premium`         |
| `displayName`        | `string`               | Human-readable name                   |
| `maxDirectories`     | `int`                  | Directory limit for the plan          |
| `allowedCadences`    | `simple-json`          | Array of allowed schedule frequencies |
| `monthlyPrice`       | `decimal(10,2)`        | Plan price                            |
| `overagePricePerRun` | `decimal(10,2)`        | Cost per extra generation run         |
| `currency`           | `string`               | Default: `usd`                        |
| `active`             | `boolean`              | Whether plan is available             |

### UserSubscription

**Table**: `user_subscriptions`

**Indexes**: `[userId, status]`, `[planCode]`

| Column              | Type                          | Purpose                                      |
| ------------------- | ----------------------------- | -------------------------------------------- |
| `planCode`          | `SubscriptionPlanCode`        | Subscribed plan tier                         |
| `status`            | `SubscriptionStatus`          | `active`, `canceled`, `past_due`, `trialing` |
| `billingProvider`   | `SubscriptionBillingProvider` | `stripe` or `manual`                         |
| `currentPeriodEnd`  | `Date`                        | When current billing period ends             |
| `cancelAtPeriodEnd` | `boolean`                     | Scheduled cancellation flag                  |
| `paymentMethodMeta` | `JSON`                        | Provider-specific payment data               |

### UsageLedgerEntry

**Table**: `usage_ledger_entries`

**Indexes**: `[userId, status]`, `[directoryId]`, `[createdAt]`, `[scheduleId]`

Tracks individual generation runs for usage-based billing.

| Column                | Type                           | Purpose                                                |
| --------------------- | ------------------------------ | ------------------------------------------------------ |
| `triggerType`         | `UsageLedgerTriggerType`       | `manual` or `scheduled`                                |
| `billingMode`         | `DirectoryScheduleBillingMode` | `subscription` or `usage`                              |
| `units`               | `int`                          | Number of generation units consumed                    |
| `amountCents`         | `int`                          | Charge in cents                                        |
| `status`              | `UsageLedgerStatus`            | `pending`, `queued_for_settlement`, `paid`, `canceled` |
| `generationHistoryId` | `string`                       | Links to the specific generation run                   |

## Scheduling Entity

### DirectorySchedule

**Table**: `directory_schedules`

**Indexes**: `[status, nextRunAt]`, `[userId, status]`, `[directoryId]` (unique)

One-to-one with Directory. Manages recurring generation runs.

| Column                    | Type                           | Purpose                                          |
| ------------------------- | ------------------------------ | ------------------------------------------------ |
| `cadence`                 | `DirectoryScheduleCadence`     | Frequency (daily, weekly, monthly, etc.)         |
| `status`                  | `DirectoryScheduleStatus`      | `disabled`, `active`, `paused`                   |
| `billingMode`             | `DirectoryScheduleBillingMode` | `subscription` or `usage`                        |
| `nextRunAt`, `lastRunAt`  | `Date`                         | Schedule timing                                  |
| `failureCount`            | `int`                          | Consecutive failures                             |
| `maxFailureBeforePause`   | `int`                          | Default: 3, auto-pauses after this many failures |
| `alwaysCreatePullRequest` | `boolean`                      | Force PR mode for scheduled runs                 |
| `providerOverrides`       | `simple-json`                  | Override AI/search providers per schedule        |

## Support Entities

### DirectoryAdvancedPrompts

**Table**: `directory_advanced_prompts`

One-to-one with Directory. Stores per-directory custom prompt overrides for each pipeline stage.

| Field                 | Pipeline Stage                  |
| --------------------- | ------------------------------- |
| `relevanceAssessment` | Web page relevance filtering    |
| `itemGeneration`      | Initial AI item generation      |
| `itemExtraction`      | Item extraction from web pages  |
| `searchQuery`         | Search query generation         |
| `categorization`      | Category and tag assignment     |
| `deduplication`       | Duplicate detection and merging |
| `sourceValidation`    | Source URL validation           |

All fields are nullable text. When non-empty, values are appended as "Additional User Instructions" to the base prompts.

### Notification

**Table**: `notifications`

**Indexes**: `[userId, isRead]`, `[userId, deduplicationKey]` (unique, partial)

| Column                     | Type                   | Purpose                                       |
| -------------------------- | ---------------------- | --------------------------------------------- |
| `type`                     | `NotificationType`     | Notification kind                             |
| `category`                 | `NotificationCategory` | Grouping category                             |
| `title`, `message`         | `string`, `text`       | Content                                       |
| `actionUrl`, `actionLabel` | `string`               | Optional CTA link                             |
| `isRead`, `isDismissed`    | `boolean`              | Read/dismiss state                            |
| `isPersistent`             | `boolean`              | Whether notification persists across sessions |
| `expiresAt`                | `Date`                 | Auto-expiry timestamp (indexed)               |
| `deduplicationKey`         | `string`               | Prevents duplicate notifications              |

### CacheEntry

**Table**: `cache_entries` | **Primary Key**: `key` (varchar)

Simple key-value store with TTL support for caching arbitrary data.

| Column      | Type           | Purpose                          |
| ----------- | -------------- | -------------------------------- |
| `key`       | `varchar` (PK) | Cache key                        |
| `value`     | `text`         | Serialized cache value           |
| `expiresAt` | `bigint`       | Unix timestamp for TTL (indexed) |

## Shared Types

Key enums defined in `entities/types.ts`:

```typescript
enum GenerateStatusType {
	GENERATING,
	GENERATED,
	ERROR,
	CANCELLED,
	IDLE
}

enum DirectoryMemberRole {
	OWNER = 'owner', // Reserved for creator
	MANAGER = 'manager', // Assignable
	EDITOR = 'editor', // Assignable
	VIEWER = 'viewer' // Assignable
}

enum SubscriptionPlanCode {
	FREE = 'free',
	STANDARD = 'standard',
	PREMIUM = 'premium'
}
```

The `GenerateStatus` interface provides granular progress tracking with step names, indices, percentages, and warning arrays.

## Custom Column Decorators

The `TimestampColumn` decorator (from `entities/_types.ts`) normalizes timestamp handling across database drivers (SQLite stores as strings, PostgreSQL as native timestamps).
