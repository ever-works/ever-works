---
id: plugin-git-module
title: Plugin Git Module
sidebar_label: Plugin Git Module
sidebar_position: 6
---

# Plugin Git Module

The Plugin Git Module (`@ever-works/plugin/git`) provides a complete git operations layer for plugin development. It wraps [isomorphic-git](https://isomorphic-git.org/) to provide clone, pull, push, branch management, and file status tracking operations. Git provider plugins (e.g., GitHub) use this module to handle all local repository manipulation.

## Package Overview

| Property         | Value                                              |
| ---------------- | -------------------------------------------------- |
| **Import path**  | `@ever-works/plugin/git`                           |
| **Location**     | `platform/packages/plugin/src/git/`                |
| **Dependencies** | `isomorphic-git`, `isomorphic-git/http/node`       |
| **Used by**      | GitHub plugin, and any future git provider plugins |

## Module Exports

```typescript
export { GitOperations, type GitOperationsConfig } from './git-operations.js';

export type {
	IGitOperations,
	IGitProviderPlugin,
	GitAuth,
	GitCommitter,
	GitRepository,
	GitBranch,
	GitCommit,
	GitFileStatus,
	GitFileChange,
	GitCloneOptions,
	GitPushOptions,
	CreateRepoOptions,
	ForkRepositoryOptions,
	CreatePROptions,
	MergeOptions,
	MergeResult,
	GitUser,
	GitOrganization,
	GitPullRequest,
	GitRepositoryPermissions,
	GitRepositoryWithPermissions,
	ListRepositoriesOptions,
	GitPullRequestFile,
	ListPullRequestsOptions
} from '../contracts/capabilities/git-provider.interface.js';

export { isGitProviderPlugin } from '../contracts/capabilities/git-provider.interface.js';
```

## GitOperations Class

The core class implementing the `IGitOperations` interface. It is constructed with authentication and URL generation callbacks, making it provider-agnostic.

### Configuration

```typescript
interface GitOperationsConfig {
	readonly baseDir?: string; // default: os.tmpdir()/ever-works-repos
	readonly defaultCommitter?: GitCommitter; // default: Ever Works Bot
}

interface GitCommitter {
	name: string;
	email: string;
}
```

### Constructor

```typescript
const gitOps = new GitOperations(
	(token) => ({ username: 'x-access-token', password: token }), // getAuth
	(owner, repo) => `https://github.com/${owner}/${repo}.git`, // getCloneUrl
	{ baseDir: '/tmp/repos' } // optional config
);
```

## Core Operations

### Clone and Pull

| Method                         | Description                                                             |
| ------------------------------ | ----------------------------------------------------------------------- |
| `cloneOrPull(options)`         | Clones a repo or pulls if already cloned. Auto-switches to main branch. |
| `pull(dir, token, committer?)` | Pulls latest changes from remote                                        |
| `cloneBranch(params)`          | Clones a specific branch into a unique work                        |

The `cloneOrPull` method handles several edge cases:

- If the work exists, attempts a pull first; on failure, removes and re-clones
- If the remote repository is empty or not found, initializes a new repo with `git init`
- Automatically switches to the main branch before pulling

```typescript
const dir = await gitOps.cloneOrPull({
	owner: 'my-org',
	repo: 'my-work',
	token: 'ghp_...',
	branch: 'main',
	autoSwitchToMainBranch: true
});
// => '/tmp/ever-works-repos/my-org-my-work'
```

### Staging and Committing

| Method                             | Description                               |
| ---------------------------------- | ----------------------------------------- |
| `add(dir, paths)`                  | Stage specific file paths                 |
| `addAll(dir)`                      | Stage all changed, new, and deleted files |
| `commit(dir, message, committer?)` | Create a commit                           |

The `addAll` method uses `git.statusMatrix` to correctly handle additions, modifications, and deletions:

```typescript
await gitOps.addAll(dir);
await gitOps.commit(dir, 'Update work content', {
	name: 'Ever Works Bot',
	email: 'bot@ever.works'
});
```

### Pushing

The `push` method includes automatic retry with exponential backoff for transient failures:

```typescript
await gitOps.push({
	dir,
	token: 'ghp_...',
	force: false,
	maxRetries: 3 // default
});
```

**Retryable errors:** `cannot lock ref`, `failed to lock`, `ETIMEDOUT`, `ECONNRESET`

### Branch Management

| Method                                        | Description                        |
| --------------------------------------------- | ---------------------------------- |
| `getCurrentBranch(dir)`                       | Get the current branch name        |
| `getMainBranch(dir)`                          | Find `main` or `master` branch     |
| `switchBranch(dir, branch, create?)`          | Switch to or create a branch       |
| `renameBranch(dir, oldName, newName)`         | Rename a branch                    |
| `createAndSwitchToRandomBranch(dir, prefix?)` | Create a unique timestamped branch |

```typescript
// Create a feature branch with unique name
const branchName = await gitOps.createAndSwitchToRandomBranch(dir, 'feature');
// => 'feature-1709567234567-a1b2c3'
```

The `renameBranch` method handles edge cases:

- If the new branch already exists, checks out to it and deletes the old one
- Preserves commit history by resolving the commit SHA before renaming

### File Status

```typescript
const changes = await gitOps.getStatus(dir);
// [
//   { path: 'README.md', status: 'modified' },
//   { path: 'new-item.md', status: 'added' },
//   { path: 'old-item.md', status: 'deleted' },
// ]
```

**Status types:** `added`, `deleted`, `modified`, `untracked`

### Remote Management

| Method                                 | Description                     |
| -------------------------------------- | ------------------------------- |
| `remoteAdd(dir, remote, url)`          | Add a remote                    |
| `remoteRemove(dir, remote)`            | Remove a remote                 |
| `replaceRemote(dir, remote, url)`      | Replace a remote (remove + add) |
| `fetch(dir, token, remote?)`           | Fetch from remote               |
| `merge(dir, ours, theirs, committer?)` | Merge branches                  |

### Work Management

| Method                        | Description                             |
| ----------------------------- | --------------------------------------- |
| `getLocalDir(owner, repo)`    | Get the local work path for a repo |
| `removeLocalDir(owner, repo)` | Remove the local clone                  |

The local work path is generated by slugifying `{owner}-{repo}` and placing it under the configured `baseDir`.

## Error Handling

The class implements robust error handling:

- **Clone failures** for empty/missing repos fall back to `git init` + `addRemote`
- **Push failures** retry up to 3 times with exponential backoff (1s, 2s, 4s)
- **Work removal** retries up to 3 times, handling `ENOTEMPTY` by removing `.git` first
- **Branch operations** gracefully handle missing branches

## Default Branch Detection

The module uses `['main', 'master']` as the ordered list of default branch names. The `switchToMainBranch` private method checks the current branch, then searches for a default branch to switch to.

## Type Exports

The module re-exports all git-related types from the contracts package for convenience:

| Type                      | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `GitAuth`                 | Authentication credentials (username/password) |
| `GitRepository`           | Repository metadata                            |
| `GitBranch`               | Branch information                             |
| `GitCommit`               | Commit data                                    |
| `GitPullRequest`          | Pull request details                           |
| `CreateRepoOptions`       | Options for creating repositories              |
| `CreatePROptions`         | Options for creating pull requests             |
| `ListRepositoriesOptions` | Options for listing repositories               |

## File Structure

```
plugin/src/git/
  index.ts              # Public exports and type re-exports
  git-operations.ts     # GitOperations class implementation
```
