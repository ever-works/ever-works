---
id: server-actions
title: Server Actions Reference
sidebar_label: Server Actions
sidebar_position: 4
---

# Server Actions Reference

The web dashboard uses Next.js Server Actions for all server-side mutations. Every action file is marked with `'use server'` and runs exclusively on the server. Actions are organized into two layers: top-level actions for authentication and global concerns, and dashboard-scoped actions under `actions/dashboard/` for directory, generation, and plugin operations.

## File Organization

```
src/app/actions/
  auth.ts                  # Login, register, logout, OAuth, password reset
  email-verification.ts    # (Reserved, currently empty)
  notifications.ts         # Notification CRUD and read status
  plugins.ts               # Global plugin enable/disable/settings
  settings.ts              # Profile, password, notification preferences, danger zone
  validation.ts            # Shared validation constants
  dashboard/
    index.ts               # Re-exports oauth, directories, navigation, generator
    comparisons.ts         # Comparison CRUD and AI config
    deploy.ts              # Deployment and website repository actions
    directories.ts         # Directory CRUD, import, schedule, advanced prompts
    directory-schedule.ts  # Schedule-specific update/run/cancel
    generator.ts           # Item generation, update, markdown regeneration
    generator-form.ts      # Generator form schema fetching
    items.ts               # Item add/remove/update, screenshot, extraction
    members.ts             # Directory member invite/update/remove/leave
    navigation.ts          # Programmatic redirect helpers
    oauth.ts               # Git provider and OAuth connection management
    organizations.ts       # Git provider organization fetching
    taxonomy.ts            # Category, tag, and collection CRUD
```

## Common Patterns

All server actions follow a consistent return shape:

```typescript
// Standard success/error result
interface ActionResult<T = unknown> {
	success: boolean;
	data?: T;
	error?: string;
}
```

**Validation**: Actions use Zod schemas for input validation. Translation-aware schemas are created inside each function via `getTranslations()` to support i18n error messages.

**Authentication Checks**: Dashboard actions call `getAuthFromCookie()` and redirect to the login page if no user session exists.

**Cache Invalidation**: After mutations, actions call `revalidatePath()` to invalidate Next.js page caches for affected routes.

## Authentication Actions

**File**: `src/app/actions/auth.ts`

| Action            | Parameters                                                          | Return                          | Description                                                                         |
| ----------------- | ------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `login`           | `identifier: string, password: string, redirectUrl: string \| null` | `{ success, error? }`           | Validates credentials with Zod, calls `authAPI.login`, sets auth cookies, redirects |
| `register`        | `username: string, email: string, password: string`                 | `{ success, error? }`           | Validates with min-length and regex rules, calls `authAPI.register`, sets cookies   |
| `logout`          | none                                                                | `{ success }`                   | Revokes refresh token, removes cookies, redirects to login                          |
| `connectProvider` | `providerId: OAuthProvider`                                         | `{ success, url?, error? }`     | Generates OAuth state, returns provider-specific auth URL for GitHub/Google         |
| `forgotPassword`  | `email: string`                                                     | `{ success, message?, error? }` | Sends password reset email via `authAPI.forgotPassword`                             |
| `resetPassword`   | `token: string, newPassword: string`                                | `{ success, error? }`           | Validates token and new password strength, calls `authAPI.resetPassword`            |

**Password Validation Rules** (applied in both `register` and `resetPassword`):

- Minimum 6 characters
- Must contain at least one lowercase letter
- Must contain a number or special character
- Cannot start with a period or newline

## Settings Actions

**File**: `src/app/actions/settings.ts`

| Action                          | Parameters                         | Return                          | Description                                             |
| ------------------------------- | ---------------------------------- | ------------------------------- | ------------------------------------------------------- |
| `resendVerificationEmail`       | none                               | `{ success, message?, error? }` | Sends email verification via `authAPI.sendVerification` |
| `updateProfile`                 | `{ username: string }`             | `{ success, data?, error? }`    | Updates username with min-length validation             |
| `updatePassword`                | `{ currentPassword, newPassword }` | `{ success, message?, error? }` | Changes password with strength validation               |
| `updateNotificationPreferences` | `{ email: {...}, app: {...} }`     | `{ success, message?, error? }` | Updates email and in-app notification toggles           |
| `deleteAccount`                 | none                               | `{ success, error? }`           | Currently disabled -- returns error by design           |

## Notification Actions

**File**: `src/app/actions/notifications.ts`

| Action                       | Parameters                           | Return Type           | Description                                      |
| ---------------------------- | ------------------------------------ | --------------------- | ------------------------------------------------ |
| `getNotifications`           | `{ unreadOnly?, limit?, category? }` | `NotificationsResult` | Fetches notification list with filters           |
| `getUnreadNotificationCount` | none                                 | `UnreadCountResult`   | Returns unread notification count                |
| `getPersistentNotifications` | none                                 | `NotificationsResult` | Fetches critical/persistent banner notifications |
| `markNotificationAsRead`     | `notificationId: string`             | `ActionResult`        | Marks single notification as read                |
| `markAllNotificationsAsRead` | none                                 | `ActionResult`        | Marks all notifications as read                  |
| `dismissNotification`        | `notificationId: string`             | `ActionResult`        | Dismisses a notification                         |

## Plugin Actions

**File**: `src/app/actions/plugins.ts`

| Action                          | Parameters                                                            | Return                | Description                                            |
| ------------------------------- | --------------------------------------------------------------------- | --------------------- | ------------------------------------------------------ |
| `enablePlugin`                  | `pluginId, { settings?, secretSettings?, autoEnableForDirectories? }` | `ActionResult`        | Enables a plugin for the current user                  |
| `disablePlugin`                 | `pluginId`                                                            | `ActionResult`        | Disables a plugin for the current user                 |
| `updatePluginSettings`          | `pluginId, { settings?, secretSettings?, metadata? }`                 | `ActionResult`        | Updates user-level plugin configuration                |
| `enableDirectoryPlugin`         | `directoryId, pluginId, { settings?, activeCapability?, priority? }`  | `ActionResult`        | Enables a plugin for a specific directory              |
| `disableDirectoryPlugin`        | `directoryId, pluginId`                                               | `ActionResult`        | Disables a directory plugin                            |
| `updateDirectoryPluginSettings` | `directoryId, pluginId, { settings?, secretSettings?, metadata? }`    | `ActionResult`        | Updates directory-level plugin settings                |
| `fetchModels`                   | `pluginId`                                                            | `ActionResult<any[]>` | Lists available AI models for a provider plugin        |
| `setActiveCapability`           | `directoryId, pluginId, capability`                                   | `ActionResult`        | Sets which capability is active for a directory plugin |

## Directory Actions

**File**: `src/app/actions/dashboard/directories.ts`

This is the largest action file with 20+ exported functions covering the full directory lifecycle.

| Action                       | Key Parameters                                   | Description                                                                     |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `createDirectory`            | `CreateDirectoryDto`                             | Creates a directory with slug, name, description, git/deploy providers          |
| `createDirectoryWithAI`      | `AIDirectoryOptions`                             | AI-generated directory: generates details, creates directory, starts generation |
| `updateDirectory`            | `directoryId, UpdateDirectoryDto`                | Updates name, description, owner, readme config                                 |
| `deleteDirectory`            | `directoryId, DeleteDirectoryDto?`               | Validates UUID, deletes directory                                               |
| `getDirectories`             | `{ search?, limit?, offset? }`                   | Paginated directory list                                                        |
| `syncDirectoryData`          | `directoryId`                                    | Syncs directory data from git repository                                        |
| `analyzeRepository`          | `sourceUrl, providerId?`                         | Analyzes a repository URL for import                                            |
| `importDirectory`            | `ImportDirectoryRequest`                         | Imports a directory from an external source                                     |
| `getUserRepositories`        | `{ gitProvider, page?, search?, owner?, type? }` | Lists user's git repositories                                                   |
| `updateDirectorySchedule`    | `directoryId, UpdateDirectorySchedulePayload`    | Updates auto-generation schedule                                                |
| `getAdvancedPrompts`         | `directoryId`                                    | Fetches custom prompt overrides                                                 |
| `updateAdvancedPrompts`      | `directoryId, UpdateDirectoryAdvancedPromptsDto` | Updates 7 prompt types (max 2000 chars each)                                    |
| `getWebsiteSettings`         | `directoryId`                                    | Fetches website configuration                                                   |
| `updateWebsiteSettings`      | `directoryId, data`                              | Updates header, homepage, footer, custom menu settings                          |
| `updateCommunityPrSettings`  | `directoryId, settings`                          | Toggles community PR and auto-close settings                                    |
| `getRepositoryVisibility`    | `directoryId`                                    | Gets visibility status of data/directory/website repos                          |
| `toggleRepositoryVisibility` | `directoryId, repoType, isPrivate`               | Toggles public/private for a specific repo                                      |

## Generator Actions

**File**: `src/app/actions/dashboard/generator.ts`

| Action               | Parameters                             | Description                                                                    |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `generateItems`      | `directoryId, CreateItemsGeneratorDto` | Sanitizes inputs, validates git connection and org access, triggers generation |
| `updateItems`        | `directoryId, UpdateItemsGeneratorDto` | Triggers item update generation                                                |
| `regenerateMarkdown` | `directoryId`                          | Regenerates markdown for all directory items                                   |

The `sanitizePluginConfig` helper processes plugin config values, sanitizing string arrays and URL arrays before sending them to the API.

## Item Actions

**File**: `src/app/actions/dashboard/items.ts`

| Action                        | Parameters                                                 | Description                                         |
| ----------------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| `addItem`                     | `directoryId, SubmitItemDto`                               | Adds item, returns PR info and merge status         |
| `removeItem`                  | `directoryId, itemSlug, { reason?, create_pull_request? }` | Removes item with optional PR creation              |
| `updateItem`                  | `directoryId, UpdateItemDto`                               | Updates item metadata                               |
| `extractItemDetails`          | `sourceUrl, existingCategories?`                           | AI-extracts item details from a URL                 |
| `captureScreenshot`           | `sourceUrl`                                                | Captures a website screenshot via screenshot plugin |
| `checkScreenshotAvailability` | none                                                       | Checks if screenshot plugin is configured           |

## Taxonomy Actions

**File**: `src/app/actions/dashboard/taxonomy.ts`

Full CRUD for three taxonomy types, all following the same pattern with auth checks and path revalidation:

| Entity          | Actions                                                    |
| --------------- | ---------------------------------------------------------- |
| **Categories**  | `createCategory`, `updateCategory`, `deleteCategory`       |
| **Tags**        | `createTag`, `updateTag`, `deleteTag`                      |
| **Collections** | `createCollection`, `updateCollection`, `deleteCollection` |

## Comparison Actions

**File**: `src/app/actions/dashboard/comparisons.ts`

| Action                        | Parameters                                            | Description                                       |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| `listComparisons`             | `directoryId`                                         | Lists all comparisons for a directory             |
| `getRemainingComparisonCount` | `directoryId`                                         | Gets count of remaining comparisons to generate   |
| `generateNextComparison`      | `directoryId`                                         | Auto-generates the next comparison pair           |
| `generateManualComparison`    | `directoryId, itemASlug, itemBSlug`                   | Generates comparison for specific item pair       |
| `deleteComparison`            | `directoryId, slug`                                   | Deletes a comparison                              |
| `getComparisonAiConfig`       | `directoryId`                                         | Gets AI provider and model config for comparisons |
| `saveComparisonAiConfig`      | `directoryId, { provider, model, extendedAnalysis? }` | Saves AI config, auto-enables plugin if needed    |
| `saveComparisonCustomPrompt`  | `directoryId, customPrompt`                           | Saves custom comparison prompt                    |
| `getAiProviderModels`         | `pluginId`                                            | Lists models for an AI provider                   |

## Deploy Actions

**File**: `src/app/actions/dashboard/deploy.ts`

| Action                          | Parameters                                                             | Description                                           |
| ------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| `deploy`                        | `directoryId, teamScope?`                                              | Triggers deployment, verifies git provider connection |
| `updateWebsiteRepository`       | `directoryId`                                                          | Updates the website repository                        |
| `getDeploymentTeams`            | `directoryId?`                                                         | Lists available deployment teams                      |
| `lookupExistingDeployment`      | `directoryId`                                                          | Checks for existing deployment and returns state      |
| `updateWebsiteTemplateSettings` | `directoryId, { websiteTemplateAutoUpdate?, websiteTemplateUseBeta? }` | Updates template auto-update settings                 |

## Navigation Actions

**File**: `src/app/actions/dashboard/navigation.ts`

Simple redirect helpers using `next-intl` locale-aware routing:

```typescript
redirectToDirectories(); // -> /directories
redirectToNewDirectory(); // -> /directories/new
redirectToDashboard(); // -> /dashboard
redirectToSettings(); // -> /settings
redirectToAnalytics(); // -> /analytics
redirectToNotifications(); // -> /notifications
```

## Validation Constants

**File**: `src/app/actions/validation.ts`

```typescript
export const VALIDATION_RULES = {
	PASSWORD_MIN_LENGTH: 6,
	USERNAME_MIN_LENGTH: 3
} as const;
```

These constants are shared across `auth.ts` and `settings.ts` for consistent validation rules.

## Error Handling Pattern

All server actions wrap API calls in try/catch blocks and return structured error responses:

```typescript
try {
	const result = await someAPI.method(data);
	revalidatePath('/affected/route');
	return { success: true, data: result };
} catch (error) {
	console.error('Failed to perform action:', error);
	return {
		success: false,
		error: error instanceof Error ? error.message : t('genericError')
	};
}
```

Actions never throw errors to the client -- they always return a result object that the calling component can check via `result.success`.
