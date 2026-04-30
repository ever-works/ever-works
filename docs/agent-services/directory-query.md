---
id: directory-query
title: Directory Query Service
sidebar_label: Directory Query
sidebar_position: 7
---

# Directory Query Service

The `DirectoryQueryService` provides read-only access to directory data, items, configuration, website settings, taxonomy, and generation history. It is the primary query interface used by the API layer to serve frontend requests.

**Source:** `packages/agent/src/services/directory-query.service.ts`

## Overview

All query methods enforce role-based access through the `DirectoryOwnershipService`. Most queries require only **Viewer** level access, while write operations like updating website settings require **Editor** level.

| Method                       | Required Role | Description                                    |
| ---------------------------- | ------------- | ---------------------------------------------- |
| `getDirectories`             | Authenticated | Lists all directories accessible to the user   |
| `getDirectory`               | Viewer        | Gets a single directory by ID                  |
| `directoryExists`            | Authenticated | Checks if a directory with a given slug exists |
| `directoryItems`             | Viewer        | Lists all items in a directory                 |
| `directoryConfig`            | Viewer        | Gets the data repository configuration         |
| `directoryCount`             | Viewer        | Gets item, category, and tag counts            |
| `directoryCategoriesTags`    | Viewer        | Lists categories, tags, and collections        |
| `directoryGenerationHistory` | Viewer        | Paginated generation run history               |
| `getWebsiteSettings`         | Viewer        | Gets website display settings                  |
| `updateWebsiteSettings`      | Editor        | Updates website display settings               |

## Listing Directories

```typescript
const result = await queryService.getDirectories({ limit: 20, offset: 0, search: 'tools' }, user);
```

### How It Works

1. **Sanitize search** -- Trims and limits search input to 100 characters.
2. **Resolve accessible IDs** -- Queries `directoryMemberRepository.getAccessibleDirectoryIds()` to find directories where the user has a membership record.
3. **Find all accessible** -- Queries `directoryRepository.findAllAccessible()` with the user's own directories and member directories combined.
4. **Batch fetch roles** -- For non-owned directories, fetches member roles in a single query via `getMemberRolesForDirectories()`.
5. **Attach roles** -- Maps each directory to a `DirectoryWithRole` that includes the user's role (OWNER for creators, membership role for others, VIEWER as fallback).
6. **Count total** -- Runs a separate count query for pagination metadata.

### DirectoryWithRole

```typescript
type DirectoryWithRole = Omit<Directory, DirectoryMethods> & {
	userRole: DirectoryMemberRole;
};
```

The `DirectoryMethods` type excludes class methods (like `getDataRepo()`, `getRepoOwner()`) from the serialized response, keeping only data properties plus the computed `userRole`.

### Response Shape

```typescript
{
    status: 'success',
    directories: DirectoryWithRole[],
    total: number,
    limit: number,
    offset: number,
}
```

## Getting a Single Directory

```typescript
const result = await queryService.getDirectory(directoryId, user);
// result.directory includes userRole
```

Uses `ownershipService.ensureAccess()` which returns the user's role, then attaches it to the directory response.

## Checking Directory Existence

```typescript
const exists = await queryService.directoryExists('my-tools', user);
```

A lightweight check that only queries the database by user ID and slug. Used during directory creation to prevent duplicates.

## Directory Items

```typescript
const result = await queryService.directoryItems(directoryId, user);
// result.items: array of item objects from the data repository
```

Delegates to `dataGenerator.getItems()` which reads item data from the Git repository. If the repository is not found, returns an empty array instead of throwing.

## Directory Configuration

```typescript
const result = await queryService.directoryConfig(directoryId, user);
// result.config: data repository configuration object (or null)
```

Returns the full configuration including metadata, last request data, initial prompt, and generation settings. Returns `null` if the repository is not yet initialized.

## Website Settings

### Reading Settings

```typescript
const settings = await queryService.getWebsiteSettings(directoryId, user);
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
await queryService.updateWebsiteSettings(directoryId, user, {
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

## Directory Counts

```typescript
const counts = await queryService.directoryCount(directoryId, user);
// { status: 'success', items: 42, categories: 5, tags: 28 }
```

Returns aggregate counts for items, categories, and tags. Returns zeros if the repository is not found.

## Categories, Tags, and Collections

```typescript
const taxonomy = await queryService.directoryCategoriesTags(directoryId, user);
// { status: 'success', categories: [...], tags: [...], collections: [...] }
```

Returns the full taxonomy data including categories, tags, and collections defined in the data repository.

## Generation History

```typescript
const history = await queryService.directoryGenerationHistory(directoryId, user, { limit: 20, offset: 0 });
```

### Response: DirectoryGenerationHistoryListDto

```typescript
interface DirectoryGenerationHistoryListDto {
	history: DirectoryGenerationHistoryDto[];
	total: number;
	limit: number; // clamped to 1-100
	offset: number; // minimum 0
}
```

### DirectoryGenerationHistoryDto

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
