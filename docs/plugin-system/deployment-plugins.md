---
id: deployment-plugins
title: Deployment & Git Plugins
sidebar_label: Deployment & Git
sidebar_position: 11
---

# Deployment & Git Plugins

Deployment and git plugins handle the full lifecycle of publishing a generated directory: creating repositories, managing branches, committing code, creating pull requests, and deploying to hosting platforms.

## GitHub Plugin

The GitHub plugin is the platform's git provider, handling both remote API operations (via the GitHub REST API) and local git operations (via `isomorphic-git`).

| Property | Value |
|---|---|
| Package | `@ever-works/github-plugin` |
| Category | `git-provider` |
| Capabilities | `git-provider`, `oauth` |
| SDK | `octokit` |
| Configuration Mode | `hybrid` (admin OAuth app + user tokens) |

### Architecture

The GitHub plugin consists of three main components:

1. **`GitHubPlugin`** -- main plugin class implementing `IGitProviderPlugin` and `IOAuthPlugin`
2. **`GitHubApiService`** -- handles all GitHub REST API calls using Octokit
3. **`GitHubActionsService`** -- manages GitHub Actions workflow dispatch and secrets

Local git operations (clone, commit, push, branch management) are provided by `GitOperations` from `@ever-works/plugin/git`, which wraps `isomorphic-git`.

### IGitProviderPlugin Interface

The git provider interface is extensive, covering authentication, repositories, branches, pull requests, forks, and content access:

```typescript
interface IGitProviderPlugin extends IPlugin, IGitOperations {
  readonly providerName: string;

  // Authentication
  getAuth(token: string): GitAuth;
  getCloneUrl(owner: string, repo: string): string;
  getWebUrl(owner: string, repo: string): string;

  // Repository operations
  createRepository(options: CreateRepoOptions, token: string): Promise<GitRepository>;
  getRepository(owner: string, repo: string, token: string): Promise<GitRepository | null>;
  deleteRepository(owner: string, repo: string, token: string): Promise<void>;
  listRepositories?(token: string, page?, perPage?, options?): Promise<GitRepositoryWithPermissions[]>;

  // User & organizations
  getUser(token: string): Promise<GitUser>;
  getOrganizations(token: string): Promise<GitOrganization[]>;

  // Branch operations
  listBranches(owner: string, repo: string, token: string): Promise<GitBranch[]>;
  createBranch?(owner, repo, name, fromRef, token): Promise<GitBranch>;

  // Pull request operations
  createPullRequest(options: CreatePROptions, token: string): Promise<GitPullRequest>;
  mergePullRequest(owner, repo, prNumber, options, token): Promise<MergeResult>;
  listPullRequests?(owner, repo, options, token): Promise<GitPullRequest[]>;

  // Fork & template operations
  forkRepository?(owner, repo, options, token): Promise<GitRepository | null>;
  createRepositoryFromTemplate?(templateOwner, templateRepo, options, token): Promise<GitRepository | null>;

  // Content access
  getFileContent?(owner, repo, path, ref?, token?): Promise<{ content, encoding } | null>;
  getReadme?(owner, repo, ref?, token?): Promise<{ content, path } | null>;
  getDirectoryContents?(owner, repo, path, token): Promise<Array<{ name, type, path }> | null>;
}
```

### Local Git Operations (IGitOperations)

These operations use `isomorphic-git` and are the same for all git providers -- only the authentication differs:

| Method | Description |
|---|---|
| `cloneOrPull(options)` | Clone a repo or pull if already cloned |
| `pull(dir, token, committer?)` | Pull latest changes |
| `add(dir, paths)` | Stage specific files |
| `addAll(dir)` | Stage all changes |
| `commit(dir, message, committer?)` | Create a commit |
| `push(options)` | Push to remote (with retry support) |
| `getCurrentBranch(dir)` | Get the current branch name |
| `getMainBranch(dir)` | Detect the main/master branch |
| `switchBranch(dir, branch, create?)` | Switch or create a branch |
| `getStatus(dir)` | Get file change status |
| `getLocalDir(owner, repo)` | Get local clone directory path |
| `removeLocalDir(owner, repo)` | Clean up local clone |

### OAuth Integration

The GitHub plugin implements `IOAuthPlugin` for GitHub OAuth App authentication:

```typescript
// Default OAuth scopes
const DEFAULT_SCOPES = [
  'user:email', 'read:user', 'repo', 'delete_repo',
  'workflow', 'write:repo_hook', 'read:org', 'project'
];
```

Admin-level settings (`clientId`, `clientSecret`) configure the OAuth App. User tokens are obtained through the OAuth flow and stored per-user.

### GitHub Actions Integration

The `GitHubActionsService` handles:

- **Workflow dispatch** -- triggering deployment workflows
- **Encrypted secrets** -- setting repository secrets using `libsodium-wrappers` for encryption
- **Workflow status** -- checking if workflows completed successfully

### Settings

| Setting | Scope | Description |
|---|---|---|
| `clientId` | global (admin) | GitHub OAuth App Client ID |
| `clientSecret` | user (admin, secret) | GitHub OAuth App Client Secret |
| `apiBaseUrl` | global | GitHub API base URL (for GitHub Enterprise) |
| `webBaseUrl` | global | GitHub web base URL (for GitHub Enterprise) |

## Vercel Plugin

The Vercel plugin handles deployment of generated directories to the Vercel hosting platform.

| Property | Value |
|---|---|
| Package | `@ever-works/vercel-plugin` |
| Category | `deployment` |
| Capabilities | `deployment` |
| SDK | `@vercel/sdk` |
| Configuration Mode | `user-required` |

### IDeploymentPlugin Interface

```typescript
interface IDeploymentPlugin extends IPlugin {
  readonly providerName: string;

  deploy(config: DeploymentConfig, token: string): Promise<DeploymentResult>;
  getDeploymentStatus(deploymentId: string, token: string): Promise<DeploymentResult>;

  // Optional
  validateToken?(token: string): Promise<boolean>;
  getTeams?(token: string): Promise<Array<{ id, slug, name }>>;
  lookupExistingDeployment?(projectName, token, teamScope?): Promise<{ found, website?, projectId? }>;
  getAuthenticatedUser?(token: string): Promise<{ username, email? } | null>;
  getProject?(projectId: string, token: string): Promise<DeploymentProject | null>;
  listProjects?(token: string): Promise<DeploymentProject[]>;
}
```

### Deployment Flow

The Vercel plugin works with the GitHub plugin for a git-based deployment workflow:

1. **Repository creation** -- GitHub plugin creates or updates the repository with generated code
2. **Deployment trigger** -- deployment is orchestrated through GitHub Actions workflow dispatch
3. **Status tracking** -- the Vercel API is polled for deployment status
4. **Domain management** -- custom domains are configured through the Vercel API

### Deployment Configuration

```typescript
interface DeploymentConfig {
  projectName: string;      // Vercel project name
  sourceDir: string;        // Directory containing the code
  buildCommand?: string;    // Custom build command
  outputDir?: string;       // Build output directory
  env?: Record<string, string>;  // Environment variables
  domain?: string;          // Custom domain
  options?: Record<string, unknown>;
}
```

### Deployment Status

```typescript
type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'ready' | 'error' | 'cancelled';
```

### Settings

| Setting | Scope | Description |
|---|---|---|
| `apiToken` | user (secret) | Vercel API token |
| `defaultTeamScope` | user | Default Vercel team for deployments |

### Vercel API Service

The `VercelApiService` wraps the `@vercel/sdk` and provides:

- **Token validation** -- verify API tokens are valid
- **Team listing** -- get teams/organizations for team-scoped deployments
- **Deployment lookup** -- check if a project already exists on Vercel
- **User info** -- get the authenticated user's details

## Deployment Workflow

The full deployment workflow combines both plugins:

```
User clicks "Deploy"
  |
  v
GitHub Plugin: createRepository() or getRepository()
  |
  v
GitHub Plugin: cloneOrPull() -> write files -> addAll() -> commit() -> push()
  |
  v
GitHub Plugin (Actions): dispatchWorkflow() with Vercel token
  |
  v
Vercel: Automatic deployment via GitHub integration
  |
  v
Vercel Plugin: lookupExistingDeployment() to get URL
  |
  v
User sees live deployment URL
```

## Creating a Custom Deployment Plugin

To add support for another hosting platform (e.g., Netlify, Cloudflare Pages):

1. Create a new package implementing `IDeploymentPlugin`
2. Implement `deploy()` to trigger deployment via the platform's API
3. Implement `getDeploymentStatus()` to poll for completion
4. Optionally implement `validateToken()`, `getTeams()`, and `listProjects()`
5. Define settings schema with API token configuration

Similarly, to add a new git provider (e.g., GitLab, Bitbucket):

1. Extend `BaseGitProvider` from `@ever-works/plugin/abstract`
2. Implement provider-specific `getAuth()`, `getCloneUrl()`, `getWebUrl()`
3. Implement the GitHub REST API equivalents for the new provider
4. The local git operations (`IGitOperations`) are inherited from the shared implementation
