---
id: repository-management
title: Repository Management Service
sidebar_label: Repository Management
sidebar_position: 4
---

# Repository Management Service

The `RepositoryManagementService` provides a unified interface for inspecting and managing the Git repositories associated with a work. It abstracts the underlying Git provider (e.g., GitHub) through the `GitFacadeService`.

**Source:** `packages/agent/src/services/repository-management.service.ts`

## Overview

Each work in Ever Works is backed by up to three Git repositories:

| Repository Type | Naming Convention | Contents                                      |
| --------------- | ----------------- | --------------------------------------------- |
| `data`          | `{slug}-data`     | Item JSON files, config, categories, tags     |
| `work`          | `{slug}`          | Markdown README and documentation             |
| `website`       | `{slug}-website`  | Generated website (Astro/Next.js) source code |

The `RepositoryManagementService` allows users to check the status of these repositories and toggle their visibility (public/private).

## Dependencies

```typescript
constructor(
    private readonly gitFacade: GitFacadeService,
    private readonly workRepository: WorkRepository,
)
```

- **GitFacadeService** -- Provider-agnostic Git operations (supports GitHub, GitLab, etc.).
- **WorkRepository** -- Persists repository visibility cache to the work entity.

## Types

### RepositoryType

```typescript
type RepositoryType = 'data' | 'work' | 'website';
```

### RepositoryStatus

```typescript
interface RepositoryStatus {
	type: RepositoryType;
	name: string;
	url: string;
	isPrivate: boolean;
	exists: boolean;
}
```

## Getting Repository Status

The `getRepositoriesStatus` method queries the Git provider for all three repositories in parallel:

```typescript
const statuses = await repoService.getRepositoriesStatus(work, user);
```

### How It Works

1. Determines the repository owner from `work.getRepoOwner()`.
2. Builds a list of all three repositories with their names from the work entity methods:
    - `work.getDataRepo()` for the data repository
    - `work.getMainRepo()` for the markdown/work repository
    - `work.getWebsiteRepo()` for the website repository
3. Queries each repository via `gitFacade.getRepository()` in parallel using `Promise.all()`.
4. For repositories that exist, returns the actual URL and privacy status.
5. For repositories that do not exist (404), returns `exists: false` with `isPrivate: true` as a safe default.

### Visibility Cache

After querying, the service compares the fetched visibility against the cached `work.repoVisibility`. If any value has changed, it persists the updated visibility:

```typescript
interface RepoVisibility {
	data: boolean; // true = private
	work: boolean;
	website: boolean;
}
```

This cache prevents unnecessary API calls when the frontend needs to display repository status.

### Example Response

```typescript
[
	{
		type: 'data',
		name: 'my-tools-data',
		url: 'https://github.com/user/my-tools-data',
		isPrivate: true,
		exists: true
	},
	{
		type: 'work',
		name: 'my-tools',
		url: 'https://github.com/user/my-tools',
		isPrivate: false,
		exists: true
	},
	{
		type: 'website',
		name: 'my-tools-website',
		url: '',
		isPrivate: true,
		exists: false
	}
];
```

## Updating Repository Visibility

The `updateRepositoryVisibility` method toggles a repository between public and private:

```typescript
const result = await repoService.updateRepositoryVisibility(
	work,
	user,
	'work', // repoType
	false // isPrivate = false means public
);
```

### How It Works

1. Resolves the repository name based on the `repoType` parameter:
    - `'data'` maps to `work.getDataRepo()`
    - `'work'` maps to `work.getMainRepo()`
    - `'website'` maps to `work.getWebsiteRepo()`
2. Calls `gitFacade.updateRepository()` with the `{ isPrivate }` payload.
3. Updates the visibility cache on the work entity.
4. Returns the updated `RepositoryStatus`.

### Git Provider Context

All Git operations pass a provider context:

```typescript
{
    userId: user.id,
    providerId: work.gitProvider,
}
```

This allows the Git facade to resolve the correct provider credentials for the user. The `gitProvider` field on the work (defaulting to `'github'`) determines which plugin handles the operation.

## Error Handling

- Repository queries that fail (e.g., 404 Not Found) are caught silently and treated as `exists: false`.
- Invalid `repoType` values throw a generic `Error('Invalid repository type')`.
- Git API errors from the facade propagate normally.

## Usage Pattern

A typical workflow for repository management in the UI:

1. **Load status** -- Call `getRepositoriesStatus()` to display which repos exist and their visibility.
2. **Toggle visibility** -- User clicks to make a repo public/private; call `updateRepositoryVisibility()`.
3. **Status refresh** -- The response from the update includes the new status, no additional query needed.

## Integration with Work Lifecycle

The `RepositoryManagementService` complements the `WorkLifecycleService`:

- **Creation** -- Repository creation is handled by the generator services during `createWork()`.
- **Inspection** -- `RepositoryManagementService` provides visibility into repository state.
- **Deletion** -- Repository deletion is handled by `WorkLifecycleService.deleteWork()`.
- **Visibility** -- Only `RepositoryManagementService` handles public/private toggling.
