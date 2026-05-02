---
id: work-query
title: Work Query Service
sidebar_label: Work Query
sidebar_position: 7
---

# Work Query Service

The `WorkQueryService` provides read-only access to work data, items, configuration, website settings, taxonomy, and generation history. It is the primary query interface used by the API layer to serve frontend requests.

**Source:** `packages/agent/src/services/work-query.service.ts`

## Overview

All query methods enforce role-based access through the `WorkOwnershipService`. Most queries require only **Viewer** level access, while write operations like updating website settings require **Editor** level.

| Method                       | Required Role | Description                                    |
| ---------------------------- | ------------- | ---------------------------------------------- |
| `getWorks`             | Authenticated | Lists all works accessible to the user   |
| `getWork`               | Viewer        | Gets a single work by ID                  |
| `workExists`            | Authenticated | Checks if a work with a given slug exists |
| `workItems`             | Viewer        | Lists all items in a work                 |
| `workConfig`            | Viewer        | Gets the data repository configuration         |
| `workCount`             | Viewer        | Gets item, category, and tag counts            |
| `workCategoriesTags`    | Viewer        | Lists categories, tags, and collections        |
| `workGenerationHistory` | Viewer        | Paginated generation run history               |
| `getWebsiteSettings`         | Viewer        | Gets website display settings                  |
| `updateWebsiteSettings`      | Editor        | Updates website display settings               |

## Listing Works

```typescript
const result = await queryService.getWorks({ limit: 20, offset: 0, search: 'tools' }, user);
```

### How It Works

1. **Sanitize search** -- Trims and limits search input to 100 characters.
2. **Resolve accessible IDs** -- Queries `workMemberRepository.getAccessibleWorkIds()` to find works where the user has a membership record.
3. **Find all accessible** -- Queries `workRepository.findAllAccessible()` with the user's own works and member works combined.
4. **Batch fetch roles** -- For non-owned works, fetches member roles in a single query via `getMemberRolesForWorks()`.
5. **Attach roles** -- Maps each work to a `WorkWithRole` that includes the user's role (OWNER for creators, membership role for others, VIEWER as fallback).
6. **Count total** -- Runs a separate count query for pagination metadata.

### WorkWithRole

```typescript
type WorkWithRole = Omit<Work, WorkMethods> & {
	userRole: WorkMemberRole;
};
```

The `WorkMethods` type excludes class methods (like `getDataRepo()`, `getRepoOwner()`) from the serialized response, keeping only data properties plus the computed `userRole`.

### Response Shape

```typescript
{
    status: 'success',
    works: WorkWithRole[],
    total: number,
    limit: number,
    offset: number,
}
```

## Getting a Single Work

```typescript
const result = await queryService.getWork(workId, user);
// result.work includes userRole
```

Uses `ownershipService.ensureAccess()` which returns the user's role, then attaches it to the work response.

## Checking Work Existence

```typescript
const exists = await queryService.workExists('my-tools', user);
```

A lightweight check that only queries the database by user ID and slug. Used during work creation to prevent duplicates.

## Work Items

```typescript
const result = await queryService.workItems(workId, user);
// result.items: array of item objects from the data repository
```

Delegates to `dataGenerator.getItems()` which reads item data from the Git repository. If the repository is not found, returns an empty array instead of throwing.

## Work Configuration

```typescript
const result = await queryService.workConfig(workId, user);
// result.config: data repository configuration object (or null)
```

Returns the full configuration including metadata, last request data, initial prompt, and generation settings. Returns `null` if the repository is not yet initialized.

## Website Settings

### Reading Settings

```typescript
const settings = await queryService.getWebsiteSettings(workId, user);
```

Returns:

| Field             | Type     | Default                      | Description                         |
| ----------------- | -------- | ---------------------------- | ----------------------------------- |
| `company_name`    | `string` | `'Acme'`                     | Brand name displayed on the website |
| `company_website` | `string` | `''`                         | Company URL                         |
| `settings`        | `object` | `{}`                         | Feature toggles and defaults        |
| `custom_menu`     | `object` | `{ header: [], footer: [] }` | Custom navigation links             |

### Updating Settings

```typescript
await queryService.updateWebsiteSettings(workId, user, {
	company_name: 'My Brand',
	categories_enabled: true,
	header: {
		submit_enabled: true,
		layout_enabled: true,
		theme_default: 'dark'
	},
	homepage: {
		hero_enabled: true,
		search_enabled: true,
		default_view: 'grid'
	},
	footer: {
		subscribe_enabled: false
	},
	custom_menu: {
		header: [{ label: 'Blog', path: '/blog', target: '_self' }]
	}
});
```

Delegates to `dataGenerator.updateWebsiteSettings()` which writes to the data repository config file.

## Work Counts

```typescript
const counts = await queryService.workCount(workId, user);
// { status: 'success', items: 42, categories: 5, tags: 28 }
```

Returns aggregate counts for items, categories, and tags. Returns zeros if the repository is not found.

## Categories, Tags, and Collections

```typescript
const taxonomy = await queryService.workCategoriesTags(workId, user);
// { status: 'success', categories: [...], tags: [...], collections: [...] }
```

Returns the full taxonomy data including categories, tags, and collections defined in the data repository.

## Generation History

```typescript
const history = await queryService.workGenerationHistory(workId, user, { limit: 20, offset: 0 });
```

### Response: WorkGenerationHistoryListDto

```typescript
interface WorkGenerationHistoryListDto {
	history: WorkGenerationHistoryDto[];
	total: number;
	limit: number; // clamped to 1-100
	offset: number; // minimum 0
}
```

### WorkGenerationHistoryDto

| Field               | Type                  | Description                               |
| ------------------- | --------------------- | ----------------------------------------- |
| `id`                | `string`              | History record UUID                       |
| `status`            | `GenerateStatusType`  | `GENERATING`, `GENERATED`, `ERROR`        |
| `generationMethod`  | `GenerationMethod`    | `CREATE_UPDATE` or `RECREATE`             |
| `startedAt`         | `string`              | ISO timestamp of generation start         |
| `finishedAt`        | `string`              | ISO timestamp of generation end           |
| `durationInSeconds` | `number`              | Wall-clock duration                       |
| `newItemsCount`     | `number`              | Items created in this run                 |
| `updatedItemsCount` | `number`              | Items updated in this run                 |
| `totalItemsCount`   | `number`              | Total items after this run                |
| `metrics`           | `GenerationMetrics`   | Detailed pipeline metrics                 |
| `errorMessage`      | `string`              | Error details (if status is ERROR)        |
| `parameters`        | `Record<string, any>` | Generation parameters used                |
| `triggerRunId`      | `string`              | Trigger.dev run ID (for background tasks) |

## Error Handling

All query methods follow a consistent error handling pattern:

1. If the error is an `HttpException`, re-throw it directly.
2. If the error message contains `'Repository not found'`, return a graceful empty response.
3. Otherwise, throw a `BadRequestException` with a normalized error message.

This ensures the frontend always gets a usable response, even when backing repositories have not been created yet.
