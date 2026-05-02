---
id: github-plugin-deep-dive
title: 'GitHub Plugin Deep Dive'
sidebar_label: 'GitHub Deep Dive'
sidebar_position: 51
---

# GitHub Plugin Deep Dive

## Overview

The GitHub plugin is the core Git provider for the Ever Works platform. It manages repositories, branches, commits, pull requests, and OAuth authentication through the GitHub API. As a system plugin, it underpins the entire deployment pipeline by handling the Git operations that push generated sites to GitHub and trigger CI/CD workflows.

## Architecture

The plugin implements three interfaces: `IPlugin`, `IGitProviderPlugin`, and `IOAuthPlugin`. Internally it delegates work to three service classes:

- **`GitHubApiService`** -- wraps the Octokit SDK to perform all REST API calls against GitHub (repositories, branches, pull requests, content access).
- **`GitHubActionsService`** -- manages GitHub Actions secrets, variables, workflow dispatch, and workflow enable/disable operations. Uses `libsodium-wrappers` for secret encryption.
- **`GitOperations`** (from `@ever-works/plugin/git`) -- handles local Git operations such as clone, pull, commit, push, and branch management via `isomorphic-git`.

```
GitHubPlugin
  |-- GitHubApiService   (Octokit, REST API)
  |-- GitHubActionsService (Octokit + libsodium)
  |-- GitOperations        (isomorphic-git, local fs)
```

The plugin is loaded during platform startup. On `onLoad`, it initialises `GitOperations` with auth and clone-URL callbacks so that local Git operations use the correct GitHub token format (`x-access-token`).

## Configuration

### Environment Variables

| Variable                      | Required    | Description                    |
| ----------------------------- | ----------- | ------------------------------ |
| `PLUGIN_GITHUB_CLIENT_ID`     | Yes (admin) | GitHub OAuth App Client ID     |
| `PLUGIN_GITHUB_CLIENT_SECRET` | Yes (admin) | GitHub OAuth App Client Secret |

### Settings Schema

```typescript
interface GitHubSettings {
	readonly clientId?: string; // OAuth App Client ID
	readonly clientSecret?: string; // OAuth App Client Secret (x-secret)
	readonly apiBaseUrl?: string; // Default: 'https://api.github.com'
}
```

- `configurationMode`: `admin-only` -- only platform administrators configure credentials.
- `apiBaseUrl` supports GitHub Enterprise installations by pointing to a custom API endpoint.

## Capabilities

| Capability     | Description                                                             |
| -------------- | ----------------------------------------------------------------------- |
| `git-provider` | Full repository lifecycle: create, read, update, delete, fork, template |
| `oauth`        | GitHub OAuth 2.0 authorization code flow                                |

Default OAuth scopes requested: `user:email`, `read:user`, `repo`, `delete_repo`, `workflow`, `write:repo_hook`, `read:org`, `project`.

## API Reference

### Authentication

| Method                 | Signature                                                              | Description                                               |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `getAuth`              | `(token: string) => GitAuth`                                           | Returns `{ username: 'x-access-token', password: token }` |
| `getAuthorizationUrl`  | `(state: string, config?: Partial<OAuthConfig>) => string`             | Builds GitHub OAuth authorize URL                         |
| `exchangeCodeForToken` | `(code: string, config?: Partial<OAuthConfig>) => Promise<OAuthToken>` | Exchanges authorization code for access token             |
| `getAuthenticatedUser` | `(token: string) => Promise<OAuthUser>`                                | Returns authenticated user info                           |

### Repository Operations

| Method                         | Signature                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `getRepository`                | `(owner, repo, token) => Promise<GitRepository \| null>`                          |
| `listRepositories`             | `(token, page?, perPage?, options?) => Promise<GitRepositoryWithPermissions[]>`   |
| `createRepository`             | `(options: CreateRepoOptions, token) => Promise<GitRepository>`                   |
| `deleteRepository`             | `(owner, repo, token) => Promise<void>`                                           |
| `updateRepository`             | `(owner, repo, data, token) => Promise<GitRepository>`                            |
| `forkRepository`               | `(owner, repo, options, token) => Promise<GitRepository \| null>`                 |
| `createRepositoryFromTemplate` | `(templateOwner, templateRepo, options, token) => Promise<GitRepository \| null>` |

### Branch & Commit Operations

| Method            | Signature                                                    |
| ----------------- | ------------------------------------------------------------ |
| `listBranches`    | `(owner, repo, token) => Promise<GitBranch[]>`               |
| `createBranch`    | `(owner, repo, name, fromRef, token) => Promise<GitBranch>`  |
| `deleteBranch`    | `(owner, repo, name, token) => Promise<void>`                |
| `getLatestCommit` | `(owner, repo, branch, token) => Promise<GitCommit \| null>` |

### Pull Request Operations

| Method              | Signature                                                           |
| ------------------- | ------------------------------------------------------------------- |
| `createPullRequest` | `(options: CreatePROptions, token) => Promise<GitPullRequest>`      |
| `getPullRequest`    | `(owner, repo, prNumber, token) => Promise<GitPullRequest \| null>` |
| `mergePullRequest`  | `(owner, repo, prNumber, options, token) => Promise<MergeResult>`   |
| `listPullRequests`  | `(owner, repo, options, token) => Promise<GitPullRequest[]>`        |
| `closePullRequest`  | `(owner, repo, prNumber, token) => Promise<GitPullRequest>`         |

### GitHub Actions

| Method                      | Signature                                           |
| --------------------------- | --------------------------------------------------- |
| `getRepositoryPublicKey`    | `(owner, repo, token) => Promise<GitHubPublicKey>`  |
| `setActionSecret`           | `(data, publicKey, token) => Promise<void>`         |
| `setActionVariable`         | `(data, token) => Promise<void>`                    |
| `enableDeploymentWorkflows` | `(owner, repo, token, withDelay?) => Promise<void>` |
| `dispatchWorkflow`          | `(data, token) => Promise<void>`                    |

### Local Git Operations

| Method         | Signature                                       |
| -------------- | ----------------------------------------------- |
| `cloneOrPull`  | `(options: GitCloneOptions) => Promise<string>` |
| `commit`       | `(dir, message, committer?) => Promise<string>` |
| `push`         | `(options: GitPushOptions) => Promise<void>`    |
| `switchBranch` | `(dir, branch, create?) => Promise<string>`     |
| `getStatus`    | `(dir) => Promise<GitFileChange[]>`             |

## Implementation Details

### Octokit Client Creation

Every API call creates a fresh `Octokit` instance with the provided token and optional `baseUrl`. This stateless approach ensures per-request authentication and avoids stale token issues.

### Fork Polling

`forkRepository` polls the newly created fork up to 24 times with a 5-second interval (`REPO_CHECK_INTERVAL_MS = 5000`, `MAX_REPO_CHECK_ATTEMPTS = 24`) because GitHub forks are asynchronous and may take time to become available.

### Secret Encryption

`setActionSecret` uses `libsodium-wrappers` to perform Curve25519 sealed-box encryption before sending the encrypted value to the GitHub Actions Secrets API. The repository public key is fetched first via `getRepositoryPublicKey`.

### Deployment Workflow Management

`enableDeploymentWorkflows` activates only the predefined deployment workflows (`Vercel Deployment`, `Production deployment`) and disables all others. It includes an optional 7-second delay to allow newly created repositories to register their workflows.

### Description Sanitization

Repository descriptions are sanitized by stripping newlines and truncating to 500 characters to comply with GitHub API constraints.

## Usage Examples

```typescript
// Get authenticated user
const user = await githubPlugin.getUser(token);

// Create a repository
const repo = await githubPlugin.createRepository(
	{ name: 'my-work', isPrivate: true, organization: 'my-org' },
	token
);

// Create a branch and push changes
await githubPlugin.cloneOrPull({
	owner: 'my-org',
	repo: 'my-work',
	token,
	branch: 'main'
});
await githubPlugin.switchBranch(localDir, 'feature-update', true);
await githubPlugin.addAll(localDir);
await githubPlugin.commit(localDir, 'Update work content');
await githubPlugin.push({ dir: localDir, token, remote: 'origin', branch: 'feature-update' });

// Dispatch a deployment workflow
await githubPlugin.dispatchWorkflow(
	{ workflow: 'deploy_vercel.yaml', branch: 'main', owner: 'my-org', repo: 'my-work' },
	token
);
```

## Rate Limiting & Quotas

- **GitHub REST API**: 5,000 requests per hour for authenticated requests (standard GitHub rate limit).
- **Pagination**: `listBranches` uses Octokit's automatic pagination iterator with `per_page: 100`.
- **Concurrent operations**: `enableDeploymentWorkflows` and `Promise.allSettled` are used to handle multiple workflow toggles concurrently without failing on individual errors.
- The plugin does not implement its own rate-limit tracking; it relies on GitHub's `X-RateLimit-*` response headers and Octokit's built-in handling.

## Error Handling

- **404 errors** are caught and returned as `null` or `false` for methods like `getRepository`, `getPullRequest`, `getLatestCommit`, and `hasRepositoryAccess`, allowing callers to distinguish "not found" from unexpected errors.
- **403 errors** are treated the same as 404 in `listRepositories` (org scope) and `hasRepositoryAccess` to handle permission-denied cases gracefully.
- **OAuth errors** from the token exchange endpoint are parsed from the JSON response and rethrown with the `error_description` field.
- `Promise.allSettled` is used for batch operations (workflow enable/disable, Actions permissions) so that one failure does not block the rest.

## Related Plugins

- [Vercel Plugin Deep Dive](./vercel-plugin-deep-dive) -- deployment target triggered via GitHub Actions workflows managed by this plugin.
- [GitHub Plugin](./github-plugin) -- overview documentation for the GitHub plugin.
