---
id: work-lifecycle
title: Work Lifecycle Service
sidebar_label: Work Lifecycle
sidebar_position: 1
---

# Work Lifecycle Service

The `WorkLifecycleService` manages the complete lifecycle of a work entity -- from creation through updates and synchronization to deletion. It is the primary entry point for all CRUD operations on works within the agent package.

**Source:** `packages/agent/src/services/work-lifecycle.service.ts`

## Overview

Every work in Ever Works maps to a set of Git repositories (data, markdown, website). The lifecycle service orchestrates creating these repositories, persisting work metadata in the database, and tearing everything down when a work is deleted.

| Operation                | Required Role      | Description                                              |
| ------------------------ | ------------------ | -------------------------------------------------------- |
| `createWork`             | Authenticated user | Creates a new work and its backing repositories          |
| `updateWork`             | Editor or higher   | Modifies work metadata and settings                      |
| `syncFromDataRepository` | Editor or higher   | Pulls latest state from the data repo into the database  |
| `deleteWork`             | Owner only         | Removes the work and optionally deletes all repositories |

## Dependencies

The service injects the following collaborators:

```typescript
constructor(
    private readonly workRepository: WorkRepository,
    private readonly dataGenerator: DataGeneratorService,
    private readonly markdownGenerator: MarkdownGeneratorService,
    private readonly websiteGenerator: WebsiteGeneratorService,
    private readonly ownershipService: WorkOwnershipService,
    private readonly deployFacade: DeployFacadeService,
)
```

- **WorkRepository** -- Database access for work CRUD operations.
- **DataGeneratorService** -- Manages the data Git repository (items, config).
- **MarkdownGeneratorService** -- Manages the markdown/README Git repository.
- **WebsiteGeneratorService** -- Manages the website Git repository.
- **WorkOwnershipService** -- Enforces role-based access checks.
- **DeployFacadeService** -- Validates deploy providers (e.g., Vercel).

## Creating a Work

The `createWork` method accepts a `CreateWorkDto` and a `User` context. It performs the following steps:

1. Extracts fields from the DTO: `slug`, `name`, `description`, `owner`, `readmeConfig`, `organization`, `gitProvider`, `deployProvider`.
2. Persists the work record via `workRepository.create()`.
3. Sets the computed `owner` field from `dir.getRepoOwner()`.
4. Attempts to fetch existing items from the data repository. If items already exist, the generate status is updated to `GENERATED`.
5. Returns a success response with the created work entity.

```typescript
const result = await lifecycleService.createWork(
	{
		slug: 'my-tools',
		name: 'My Tools Work',
		description: 'A curated list of developer tools',
		organization: false,
		gitProvider: 'github'
	},
	currentUser
);
// result.work contains the persisted entity
```

### Initial State

When a work is freshly created, its `generateStatus` is `null` unless pre-existing items are detected in the data repository, in which case it is set to `GENERATED`.

## Updating a Work

The `updateWork` method requires at least **Editor** role. It performs validation on several optional fields:

| Field                                          | Behavior                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `name`, `description`, `owner`, `organization` | Merged with current values (fallback to existing)                                                |
| `readmeConfig`                                 | Replaces the existing README configuration                                                       |
| `deployProvider`                               | Validated against `DeployFacadeService.getAvailableProviders()`                                  |
| `websiteTemplateAutoUpdate`                    | Toggles automatic website template updates                                                       |
| `websiteTemplateUseBeta`                       | Switches between stable and beta template branches; clears `websiteTemplateLastCommit` on change |
| `communityPrEnabled`, `communityPrAutoClose`   | Controls community pull request processing                                                       |

The deploy provider validation checks that the supplied provider ID exists in the list of registered deploy providers. If it does not, a `BadRequestException` is thrown.

```typescript
await lifecycleService.updateWork(workId, { name: 'Updated Name', deployProvider: 'vercel' }, currentUser);
```

## Syncing from Data Repository

The `syncFromDataRepository` method pulls a snapshot from the data generator and updates the work record accordingly:

1. Calls `dataGenerator.getDataSyncSnapshot()` to get the current state.
2. Updates `itemsCount` if it has changed. If items count drops to zero, `generateStatus` is cleared.
3. Syncs pull request metadata from the snapshot if the work lacks it.
4. Syncs `readmeConfig` (header/footer) from markdown templates when not already configured.
5. Persists all accumulated updates in a single `workRepository.update()` call.

This method is typically invoked after external changes to the data repository (e.g., manual Git commits).

## Deleting a Work

The `deleteWork` method requires **Owner** role and accepts a `DeleteWorkDto` that controls which repositories are removed:

| Flag                         | Default | Effect                                                                     |
| ---------------------------- | ------- | -------------------------------------------------------------------------- |
| `delete_data_repository`     | `true`  | Removes the data repository via `dataGenerator.removeRepository()`         |
| `delete_markdown_repository` | `true`  | Removes the markdown repository via `markdownGenerator.removeRepository()` |
| `delete_website_repository`  | `true`  | Removes the website repository via `websiteGenerator.removeRepository()`   |

The deletion flow:

1. Validates ownership via `ownershipService.ensureIsOwner()`.
2. Deletes each repository based on the flags, collecting deleted repository names.
3. Removes the work record from the database.
4. Runs cleanup operations for all three generators in parallel (`dataGenerator.cleanup()`, `markdownGenerator.cleanup()`, `websiteGenerator.cleanup()`).
5. Returns a `DeleteWorkResponseDto` with the list of deleted repositories.

```typescript
const result = await lifecycleService.deleteWork(
	workId,
	{
		delete_data_repository: true,
		delete_markdown_repository: true,
		delete_website_repository: false // keep the website repo
	},
	currentUser
);
// result.deleted_repositories: ['owner/my-tools-data', 'owner/my-tools']
```

Repository deletion errors for individual repositories are caught and logged but do not prevent the overall deletion from proceeding. Only `HttpException` errors are re-thrown.

## Error Handling

All methods use the `rethrowAsNormalized()` utility to ensure consistent error responses. This utility:

- Re-throws `HttpException` instances as-is.
- Wraps other errors in a `BadRequestException` with a normalized error message.
- Logs the original error with contextual information.

## State Transitions

```
[Created] --> generateStatus: null
    |
    v (items found)
[Created] --> generateStatus: GENERATED
    |
    v (update / sync)
[Active] --> generateStatus: GENERATED | GENERATING | ERROR
    |
    v (delete)
[Deleted] --> All repos cleaned up, DB record removed
```
