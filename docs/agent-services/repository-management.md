---
id: repository-management
title: Repository Management Service
sidebar_label: Repository Management
sidebar_position: 4
---

# Repository Management Service

The `RepositoryManagementService` provides a unified interface for inspecting and managing the Git repositories associated with a directory. It abstracts the underlying Git provider (e.g., GitHub) through the `GitFacadeService`.

**Source:** `packages/agent/src/services/repository-management.service.ts`

## Overview

Each directory in Ever Works is backed by up to three Git repositories:

| Repository Type | Naming Convention | Contents                                      |
| --------------- | ----------------- | --------------------------------------------- |
| `data`          | `{slug}-data`     | Item JSON files, config, categories, tags     |
| `directory`     | `{slug}`          | Markdown README and documentation             |
| `website`       | `{slug}-website`  | Generated website (Astro/Next.js) source code |

The `RepositoryManagementService` allows users to check the status of these repositories and toggle their visibility (public/private).

## Dependencies

```typescript
constructor(
    private readonly gitFacade: GitFacadeService,
    private readonly directoryRepository: DirectoryRepository,
)
```

- **GitFacadeService** -- Provider-agnostic Git operations (supports GitHub, GitLab, etc.).
- **DirectoryRepository** -- Persists repository visibility cache to the directory entity.

## Types

### RepositoryType

```typescript
type RepositoryType = 'data' | 'directory' | 'website';
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
const statuses = await repoService.getRepositoriesStatus(directory, user);
```

### How It Works

1. Determines the repository owner from `directory.getRepoOwner()`.
2. Builds a list of all three repositories with their names from the directory entity methods:
    - `directory.getDataRepo()` for the data repository
    - `directory.getMainRepo()` for the markdown/directory repository
    - `directory.getWebsiteRepo()` for the website repository
3. Queries each repository via `gitFacade.getRepository()` in parallel using `Promise.all()`.
4. For repositories that exist, returns the actual URL and privacy status.
5. For repositories that do not exist (404), returns `exists: false` with `isPrivate: true` as a safe default.

### Visibility Cache

After querying, the service compares the fetched visibility against the cached `directory.repoVisibility`. If any value has changed, it persists the updated visibility:

```typescript
interface RepoVisibility {
	data: boolean; // true = private
	directory: boolean;
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
		type: 'directory',
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
	directory,
	user,
	'directory', // repoType
	false // isPrivate = false means public
);
```

### How It Works

1. Resolves the repository name based on the `repoType` parameter:
    - `'data'` maps to `directory.getDataRepo()`
    - `'directory'` maps to `directory.getMainRepo()`
    - `'website'` maps to `directory.getWebsiteRepo()`
2. Calls `gitFacade.updateRepository()` with the `{ isPrivate }` payload.
3. Updates the visibility cache on the directory entity.
4. Returns the updated `RepositoryStatus`.

### Git Provider Context

All Git operations pass a provider context:

```typescript
{
    userId: user.id,
    providerId: directory.gitProvider,
}
```

This allows the Git facade to resolve the correct provider credentials for the user. The `gitProvider` field on the directory (defaulting to `'github'`) determines which plugin handles the operation.

## Error Handling

- Repository queries that fail (e.g., 404 Not Found) are caught silently and treated as `exists: false`.
- Invalid `repoType` values throw a generic `Error('Invalid repository type')`.
- Git API errors from the facade propagate normally.

## Usage Pattern

A typical workflow for repository management in the UI:

1. **Load status** -- Call `getRepositoriesStatus()` to display which repos exist and their visibility.
2. **Toggle visibility** -- User clicks to make a repo public/private; call `updateRepositoryVisibility()`.
3. **Status refresh** -- The response from the update includes the new status, no additional query needed.

## Integration with Directory Lifecycle

The `RepositoryManagementService` complements the `DirectoryLifecycleService`:

- **Creation** -- Repository creation is handled by the generator services during `createDirectory()`.
- **Inspection** -- `RepositoryManagementService` provides visibility into repository state.
- **Deletion** -- Repository deletion is handled by `DirectoryLifecycleService.deleteDirectory()`.
- **Visibility** -- Only `RepositoryManagementService` handles public/private toggling.
