---
id: git-operations
title: Git Operations
sidebar_label: Git Operations
sidebar_position: 9
---

# Git Operations

The Ever Works platform uses Git as its primary storage layer for work data, markdown content, and generated websites. All Git operations are abstracted behind the `GitFacadeService`, which delegates to provider-specific plugins (currently GitHub via Octokit and isomorphic-git).

## Architecture

### GitFacadeService

Located at `packages/agent/src/facades/git.facade.ts`, the facade provides a unified interface for all Git operations regardless of the underlying provider.

The facade resolves the correct Git provider plugin at runtime through the plugin registry:

```
GitFacadeService
  -> PluginRegistryService (find plugin with 'git' capability)
  -> IGitProviderPlugin (provider-specific implementation)
```

### Dependencies

| Package              | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `isomorphic-git`     | Local Git operations (clone, add, commit, push, pull)  |
| `@octokit/rest`      | GitHub REST API (repos, PRs, file content, branches)   |
| `@ever-works/plugin` | Plugin interfaces (`IGitProviderPlugin`, `IGitFacade`) |

## Facade Operations

### Repository Management

| Method                                        | Description                  |
| --------------------------------------------- | ---------------------------- |
| `getRepository(owner, repo, options)`         | Get repository metadata      |
| `repositoryExists(owner, repo, options)`      | Check if a repository exists |
| `createRepository(owner, repo, options)`      | Create a new repository      |
| `hasRepositoryAccess(owner, repo, options)`   | Verify write access          |
| `getWorkContents(owner, repo, path, options)` | List files in a work         |
| `getFileContent(owner, repo, path, options)`  | Read a file's content        |
| `getReadme(owner, repo, options)`             | Fetch the README file        |

### Local Git Operations

| Method                                     | Description                            |
| ------------------------------------------ | -------------------------------------- |
| `cloneOrPull(cloneOptions, facadeOptions)` | Clone a repo or pull if already cloned |
| `add(providerId, dir, pattern)`            | Stage files (git add)                  |
| `commit(providerId, dir, message)`         | Create a commit                        |
| `push(pushOptions, facadeOptions)`         | Push to remote                         |

### Pull Request Operations

| Method                                                               | Description               |
| -------------------------------------------------------------------- | ------------------------- |
| `listPullRequests(owner, repo, options, facadeOptions)`              | List PRs with filters     |
| `getPullRequestFiles(owner, repo, number, facadeOptions)`            | Get files changed in a PR |
| `createPullRequestComment(owner, repo, number, body, facadeOptions)` | Add a comment to a PR     |
| `closePullRequest(owner, repo, number, facadeOptions)`               | Close a PR                |

### Branch and History

| Method                               | Description              |
| ------------------------------------ | ------------------------ |
| `listBranches(owner, repo, options)` | List repository branches |
| `getCommits(owner, repo, options)`   | List commit history      |

### URL Utilities

| Method                                                 | Description                            |
| ------------------------------------------------------ | -------------------------------------- |
| `getWebUrl(providerId, owner, repo)`                   | Get the web URL for a repository       |
| `getRawFileUrl(providerId, owner, repo, branch, path)` | Get raw file URL                       |
| `isConfigured()`                                       | Check if any Git provider is available |

## Credential Resolution

The facade resolves Git credentials automatically from the user's OAuth tokens:

1. Look up the user's OAuth token for the specified Git provider via `OAuthTokenRepository`.
2. If a `token` is explicitly passed in options, use that instead.
3. Throw `NoGitCredentialsError` if no token is available.

```typescript
interface GitFacadeOptions {
	readonly userId: string;
	readonly providerId: string;
	readonly workId?: string;
	readonly token?: string; // Optional explicit token
}
```

## Error Hierarchy

The facade defines a typed error hierarchy for clear error handling:

| Error Class                | When                                                   |
| -------------------------- | ------------------------------------------------------ |
| `GitFacadeError`           | Base class for all Git facade errors                   |
| `NoGitProviderError`       | No Git provider plugin is configured or available      |
| `GitProviderNotFoundError` | Specified provider ID does not match any loaded plugin |
| `NoGitCredentialsError`    | No OAuth token found for the user/provider combination |

## Clone and Pull Strategy

The `cloneOrPull()` method implements an efficient local caching strategy:

1. **First call**: Clone the repository to a local work (managed per user/repo).
2. **Subsequent calls**: Pull latest changes instead of re-cloning.
3. **Branch handling**: Optionally auto-switch to the main branch.

The committer information is embedded in clone options:

```typescript
await gitFacade.cloneOrPull(
	{
		owner: 'ever-works',
		repo: 'my-work-data',
		committer: user.asCommitter() // { name, email }
	},
	{ userId: user.id, providerId: 'github' }
);
```

## Repository Ecosystem

Each work typically operates with three repositories following a naming convention:

| Repository    | Naming           | Content                              |
| ------------- | ---------------- | ------------------------------------ |
| Data repo     | `{slug}-data`    | Items, categories, tags, config YAML |
| Markdown repo | `{slug}`         | Generated markdown content           |
| Website repo  | `{slug}-website` | Generated static website             |

The Git facade handles all three through the same interface. Services like `DataGeneratorService`, `MarkdownGeneratorService`, and `WebsiteGeneratorService` each operate on their respective repository.

## Push Retry Logic

The `push()` method supports retry logic with `maxRetries` for handling transient network failures:

```typescript
await gitFacade.push({ dir: repoDir, force: false, maxRetries: 3 }, gitOptions);
```

## Provider Plugins

The Git provider plugin interface (`IGitProviderPlugin`) defines the full contract that provider implementations must satisfy. Currently, the GitHub plugin (`packages/plugins/github/`) is the primary implementation, wrapping Octokit for API calls and isomorphic-git for local operations.

Additional providers (GitLab, Bitbucket) can be added by implementing the same plugin interface and registering them with the `git` capability.
