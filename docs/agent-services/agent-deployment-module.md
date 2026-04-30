---
id: agent-deployment-module
title: Deployment Module
sidebar_label: Deployment
sidebar_position: 26
---

# Deployment Module

## Overview

The Deployment module in `@ever-works/agent` manages the deployment lifecycle of directory websites. It provides a unified facade over multiple deployment providers (Vercel, Netlify, etc.) and a comprehensive Git facade for repository management. Together, these facades handle everything from creating deployment projects and triggering builds to managing custom domains and monitoring deployment status.

Both facades follow the plugin-based provider resolution pattern, where the actual deployment and git operations are delegated to provider-specific plugins resolved dynamically from the plugin registry.

## Module Structure

```
packages/agent/src/
  facades/
    deploy.facade.ts              # Deployment provider facade
    git.facade.ts                 # Git provider facade (~813 lines)
    base.facade.ts                # Abstract base class for all facades
    facades.module.ts             # NestJS module registering all facades
  plugins/
    services/
      plugin-registry.service.ts  # Plugin discovery and resolution
      plugin-settings.service.ts  # 4-level settings hierarchy
```

## Key Classes and Services

### `DeployFacadeService`

Implements `IDeployFacade` and provides deployment operations through plugin-based providers:

**Core operations:**

- **`isConfigured()`** -- check if any deployment provider is available
- **`getAvailableProviders()`** -- list all registered deployment providers with their enabled status
- **`validateToken(providerId, token)`** -- verify deployment credentials
- **`getTeams(providerId, token)`** -- list teams/organizations on the deployment platform
- **`deploy(directory, user, options)`** -- trigger a deployment. Connects the website repository to the deployment platform and initiates a build.
- **`getDeploymentStatus(directory)`** -- check the current deployment state (building, ready, error)
- **`lookupExistingDeployment(directory)`** -- find an existing deployment project for a directory
- **`getDeployToken(userId, providerId)`** -- retrieve stored deployment credentials

**Domain management:**

- **`getDomains(directory)`** -- list all domains (custom + default) for a deployment
- **`addDomain(directory, domain)`** -- add a custom domain to the deployment
- **`removeDomain(directory, domain)`** -- remove a custom domain
- **`verifyDomain(directory, domain)`** -- check DNS configuration and SSL status

The database is the primary source of truth for domain records (`DirectoryCustomDomain` entity). Provider APIs are used for synchronization and verification.

**Custom errors:**

- `NoDeployProviderError` -- no deployment provider configured
- `DeployProviderNotFoundError` -- specified provider not found in registry
- `NoDeployCredentialsError` -- no valid credentials for the deployment provider

### `GitFacadeService`

Implements `IGitFacade` and provides comprehensive Git operations (~813 lines):

**Repository management:**

- `getUser(options)` -- get authenticated user info
- `getOrganizations(options)` -- list user's organizations
- `getRepository(owner, repo, options)` -- get repository details
- `listRepositories(owner, options)` -- list repositories
- `createRepository(name, options)` -- create a new repository
- `deleteRepository(owner, repo, options)` -- delete a repository
- `updateRepository(owner, repo, updates, options)` -- update repository settings
- `forkRepository(owner, repo, options)` -- fork a repository
- `createRepositoryFromTemplate(templateOwner, templateRepo, name, options)` -- create from template
- `repositoryExists(owner, repo, options)` -- check if a repo exists
- `hasRepositoryAccess(owner, repo, options)` -- check write access

**Branch operations:**

- `listBranches(owner, repo, options)`
- `createBranch(owner, repo, branchName, fromRef, options)`
- `deleteBranch(owner, repo, branchName, options)`
- `switchBranch(dir, branchName, options)`
- `renameBranch(owner, repo, oldName, newName, options)`

**Pull request operations:**

- `createPullRequest(owner, repo, prData, options)`
- `getPullRequest(owner, repo, number, options)`
- `mergePullRequest(owner, repo, number, options)`
- `listPullRequests(owner, repo, filters, options)`
- `getPullRequestFiles(owner, repo, number, options)`
- `createPullRequestComment(owner, repo, number, body, options)`
- `closePullRequest(owner, repo, number, options)`

**Local Git operations (via isomorphic-git):**

- `cloneOrPull(repoInfo, options)` -- clone or update a local copy
- `pull(dir, options)` -- pull latest changes
- `add(providerId, dir, filepath)` -- stage files
- `addAll(providerId, dir)` -- stage all changes
- `commit(providerId, dir, message)` -- create a commit
- `push(pushOptions, gitOptions)` -- push to remote
- `getCurrentBranch(dir)` -- get current branch name
- `getMainBranch(owner, repo, options)` -- detect default branch
- `getStatus(dir)` -- get working tree status

**File operations:**

- `getFileContent(owner, repo, path, options)` -- read a file from a remote repository
- `getDirectoryContents(owner, repo, path, options)` -- list directory contents remotely
- `getReadme(owner, repo, options)` -- fetch README content
- `getRawFileUrl(providerId, owner, repo, branch, path)` -- construct raw file URL
- `getWebUrl(providerId, owner, repo)` -- construct repository web URL

**Token resolution:**

Git credentials are resolved in priority order:
1. Explicit `token` parameter in `GitFacadeOptions`
2. OAuth token from `OAuthTokenRepository` (for the user and provider)
3. Personal access token (PAT) from plugin settings

**Custom errors:**
- `NoGitProviderError` -- no git provider configured
- `GitProviderNotFoundError` -- specified provider not found
- `NoGitCredentialsError` -- no valid git credentials available

### `BaseFacadeService`

Abstract base class providing shared functionality for all facades:

- **Provider resolution:** `resolvePlugin(providerOverride, userId, directoryId)` resolves a plugin in priority order: explicit override > directory active plugin > defaultForCapabilities > first enabled plugin
- **Settings hierarchy:** `getResolvedSettings(pluginId, options)` merges settings from Directory > User > Admin > Plugin defaults
- **Typed settings access:** `getSettingTyped()`, `getSettingRequired()`, `getSettingWithDefault()` for safe settings retrieval

## API Reference

### DeployFacadeService

```typescript
isConfigured(): boolean
getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }>
validateToken(providerId: string, token: string): Promise<boolean>
getTeams(providerId: string, token: string): Promise<DeployTeam[]>
deploy(directory: Directory, user: User, options?: DeployOptions): Promise<DeployResult>
getDeploymentStatus(directory: Directory): Promise<DeploymentStatus>
lookupExistingDeployment(directory: Directory): Promise<DeployProject | null>
getDeployToken(userId: string, providerId: string): Promise<string | null>
getDomains(directory: Directory): Promise<Domain[]>
addDomain(directory: Directory, domain: string): Promise<DomainResult>
removeDomain(directory: Directory, domain: string): Promise<void>
verifyDomain(directory: Directory, domain: string): Promise<DomainVerification>
```

### GitFacadeService

```typescript
// Options type used across all operations
interface GitFacadeOptions {
    userId?: string;
    providerId?: string;
    token?: string;
}

isConfigured(): boolean
getUser(options: GitFacadeOptions): Promise<GitUser>
createRepository(name: string, options: GitFacadeOptions & CreateRepoOptions): Promise<GitRepository>
cloneOrPull(repoInfo: RepoInfo, options: GitFacadeOptions): Promise<string>  // Returns local path
createPullRequest(owner: string, repo: string, pr: PullRequestData, options: GitFacadeOptions): Promise<GitPullRequest>
push(pushOptions: PushOptions, gitOptions: GitFacadeOptions): Promise<void>
// ... and ~30 more methods (see full source)
```

## Configuration

### Deployment Provider Settings

Deployment providers are configured through the plugin settings system:

```typescript
// Plugin settings (via JSON Schema in plugin package.json)
{
    "token": "ver_...",           // Deployment platform API token (x-secret)
    "teamId": "team_...",        // Default team/org for deployments
    "framework": "nextjs"        // Framework preset
}
```

### Git Provider Settings

```typescript
{
    "personalAccessToken": "ghp_...",    // PAT for API operations (x-secret)
    "defaultBranch": "main"              // Default branch name
}
```

OAuth tokens are stored separately in the `OAuthToken` entity and take priority over PATs.

## Dependencies

| Dependency | Purpose |
|---|---|
| `@ever-works/plugin` | `IDeployPlugin`, `IGitPlugin` interfaces, `PLUGIN_CAPABILITIES` |
| `@ever-works/agent/plugins` | `PluginRegistryService`, `PluginSettingsService` |
| `@ever-works/agent/database` | `DirectoryCustomDomain`, `OAuthTokenRepository` |
| `isomorphic-git` | Local git clone, commit, push operations |

## Usage Examples

### Deploying a Directory Website

```typescript
import { DeployFacadeService } from '@ever-works/agent/facades';

const result = await deployFacade.deploy(directory, user, {
    teamId: 'team_abc123',
});

// Check deployment status
const status = await deployFacade.getDeploymentStatus(directory);
console.log(status.state); // 'building' | 'ready' | 'error'
```

### Managing Custom Domains

```typescript
await deployFacade.addDomain(directory, 'tools.example.com');

const verification = await deployFacade.verifyDomain(directory, 'tools.example.com');
if (!verification.verified) {
    console.log('DNS records needed:', verification.requiredRecords);
}
```

### Git Repository Operations

```typescript
import { GitFacadeService } from '@ever-works/agent/facades';

// Create a repository
const repo = await gitFacade.createRepository('my-directory-data', {
    userId: user.id,
    providerId: 'github',
    isPrivate: true,
    description: 'Data repository for My Directory',
});

// Clone locally, make changes, commit, push
const localPath = await gitFacade.cloneOrPull(
    { owner: 'my-org', repo: 'my-directory-data', committer: user.asCommitter() },
    { userId: user.id, providerId: 'github' },
);

await gitFacade.addAll('github', localPath);
await gitFacade.commit('github', localPath, 'Update item data');
await gitFacade.push({ dir: localPath }, { userId: user.id, providerId: 'github' });
```
