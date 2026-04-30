---
id: directory-import-service
title: 'DirectoryImportService Deep Dive'
sidebar_label: 'Directory Import'
sidebar_position: 12
---

# DirectoryImportService Deep Dive

## Overview

The `DirectoryImportService` orchestrates the entire directory import pipeline, handling the creation of directories from external sources such as existing data repositories, Awesome List READMEs, and pre-existing repository ecosystems. It manages repository analysis, import dispatching (to Trigger.dev or in-process fallback), sync scheduling, and status tracking through generation history records.

## Architecture

The import service acts as the top-level coordinator, delegating actual import execution to `ImportExecutorService` and repository analysis to `SourceRepoAnalyzerService`. It integrates with the task dispatching system for background processing and falls back to in-process execution when Trigger.dev is unavailable.

```
API Controller
       |
       v
DirectoryImportService
       |
       +-- analyzeRepository()     --> SourceRepoAnalyzerService
       +-- analyzeForLinking()     --> SourceRepoAnalyzerService
       +-- getUserRepositories()   --> GitFacadeService
       +-- initiateImport()
       |       |
       |       +-- dispatchImportTask()
       |       |       |
       |       |       +-- DirectoryImportDispatcher (Trigger.dev)
       |       |       +-- processImport() (in-process fallback)
       |       |               |
       |       |               +-- ImportExecutorService.executeBySourceType()
       |       |
       |       +-- DirectoryScheduleService.updateSchedule() (for awesome_readme)
       |
       +-- syncDirectory()         --> syncFromDataRepo() / syncFromAwesomeReadme()
```

## API Reference

### Methods

#### `analyzeRepository(dto, user)`

Analyzes a repository URL to detect its type (data repo, awesome list, etc.) and structure.

| Parameter | Type                   | Description                                     |
| --------- | ---------------------- | ----------------------------------------------- |
| `dto`     | `AnalyzeRepositoryDto` | Contains `sourceUrl` and optional `gitProvider` |
| `user`    | `User`                 | The requesting user                             |

**Returns:** `Promise<AnalyzeRepositoryResponseDto>` -- includes detected type, repository structure, slug conflicts, and related repos.

#### `analyzeForLinking(dto, user)`

Checks if a repository can be linked as an existing directory (verifies write access, related repos).

| Parameter | Type                   | Description                                     |
| --------- | ---------------------- | ----------------------------------------------- |
| `dto`     | `AnalyzeRepositoryDto` | Contains `sourceUrl` and optional `gitProvider` |
| `user`    | `User`                 | The requesting user                             |

**Returns:** `Promise<AnalyzeForLinkingResponseDto>` -- includes `canLink`, `hasWriteAccess`, and `relatedRepos` status.

#### `getUserRepositories(dto, user)`

Lists repositories from the user's connected git provider account with pagination and search.

| Parameter | Type                     | Description                            |
| --------- | ------------------------ | -------------------------------------- |
| `dto`     | `GetUserRepositoriesDto` | Pagination, search, and filter options |
| `user`    | `User`                   | The requesting user                    |

**Returns:** `Promise<GetUserRepositoriesResponseDto>` -- paginated list of `GitRepoDto` objects.

#### `initiateImport(dto, user, context?)`

Creates a new directory and starts the import process.

| Parameter | Type                                 | Description                                              |
| --------- | ------------------------------------ | -------------------------------------------------------- |
| `dto`     | `ImportDirectoryDto`                 | Import configuration (source URL, type, name, providers) |
| `user`    | `User`                               | The requesting user                                      |
| `context` | `OperationTriggerContext` (optional) | Trigger context (user, schedule, or API)                 |

**Returns:** `Promise<ImportDirectoryResponseDto>` -- includes status, directory ID, and history ID.

#### `syncDirectory(directory, user, historyId?)`

Re-syncs an existing directory from its original source repository.

| Parameter   | Type                | Description                        |
| ----------- | ------------------- | ---------------------------------- |
| `directory` | `Directory`         | The directory entity to sync       |
| `user`      | `User`              | The user performing the sync       |
| `historyId` | `string` (optional) | Generation history entry to update |

**Returns:** `Promise<DirectoryImportResult>` -- sync outcome with item counts and error codes.

## Implementation Details

### Import Source Types

The service handles three distinct import source types:

1. **`data_repo`** -- Clones an existing Ever Works data repository and copies its items, categories, and tags.
2. **`awesome_readme`** -- Parses an Awesome List README using AI to extract structured items, then generates all three repos (data, markdown, website).
3. **`link_existing`** -- Links to pre-existing repositories without cloning data, simply recording the association.

### Name Normalization

The `normalizeDirectoryName()` method strips `-data` and `-website` suffixes from directory names for `data_repo` and `link_existing` imports. This prevents naming collisions where a repo named `my-dir-data` would generate a data repo called `my-dir-data-data`.

### Slug Conflict Resolution

`resolveSlugConflicts()` checks the git provider for existing repositories matching the slug pattern (`{slug}`, `{slug}-data`, `{slug}-website`). If conflicts exist, it tries suffixes `-2` through `-10`, falling back to a timestamp-based suffix.

### Dispatch Strategy

The `dispatchImportTask()` method uses a two-tier approach:

1. **Trigger.dev dispatch** (preferred) -- sends the import payload to a background worker via the `DirectoryImportDispatcher`
2. **In-process fallback** -- if Trigger.dev dispatch fails:
    - Schedule-triggered imports run `await` (synchronous) to prevent concurrency explosion
    - User/API-triggered imports run fire-and-forget (`void`)

### Sync Scheduling

For `awesome_readme` imports, the service automatically creates a weekly sync schedule with `alwaysCreatePullRequest: true`, enabling ongoing automatic updates from the source repository.

## Database Interactions

| Repository                             | Methods Used                                                                                                                | Purpose                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `DirectoryRepository`                  | `findByOwnerAndSlug`, `create`, `update`, `updateGenerateStatus`, `recordGenerationStartTime`, `recordGenerationFinishTime` | Directory CRUD and status tracking |
| `DirectoryGenerationHistoryRepository` | `createEntry`, `updateEntry`, `deleteEntry`                                                                                 | Generation history lifecycle       |

## Event System

### Events Emitted

| Event                               | When                                            |
| ----------------------------------- | ----------------------------------------------- |
| `DirectoryGenerationCompletedEvent` | After successful import completion              |
| `DirectoryGenerationCompletedEvent` | After import failure (for cleanup/notification) |
| `DirectoryGenerationCompletedEvent` | After linking existing repos                    |

## Error Handling

- **URL parsing failures** return an immediate `{ status: 'error' }` response without creating any directory
- **AI provider validation** runs before directory creation for `awesome_readme` imports (fail-fast)
- **Import failures** update both the directory `generateStatus` and the history entry with error details
- **Cleanup** (`cleanupFailedImport`) deletes the directory and history entry if the import fails during the early stages
- All errors are normalized through `normalizeGeneratorError()` for consistent error messages
- `HttpException` errors are re-thrown directly; other errors are wrapped in the response DTO

## Usage Examples

```typescript
// Analyze a repository before importing
const analysis = await importService.analyzeRepository(
	{ sourceUrl: 'https://github.com/sindresorhus/awesome-nodejs' },
	currentUser
);
// analysis.detectedType === 'awesome_readme'

// Import from an awesome list
const result = await importService.initiateImport(
	{
		sourceUrl: 'https://github.com/sindresorhus/awesome-nodejs',
		sourceType: ImportSourceTypeEnum.AWESOME_README,
		name: 'Awesome Node.js',
		gitProvider: 'github',
		sync: true
	},
	currentUser
);
// result.status === 'success', result.directoryId === '...'

// Sync an existing imported directory
const syncResult = await importService.syncDirectory(existingDirectory, currentUser);
// syncResult.success === true, syncResult.itemsImported === 15
```

## Configuration

| Setting         | Description                                              |
| --------------- | -------------------------------------------------------- |
| Git Provider    | Required for all import operations; specified in the DTO |
| Deploy Provider | Optional; used when generating website repos             |
| AI Provider     | Optional override via `providers.ai` in the DTO          |
| Sync Schedule   | Automatically set to `WEEKLY` for awesome_readme imports |

## Related Services

- [Import System](/agent-services/import-system) -- the underlying import execution layer
- [Directory Scheduling](/agent-services/directory-scheduling) -- manages sync schedules created by imports
- [Directory Lifecycle](/agent-services/directory-lifecycle) -- alternative creation path for prompt-based directories
