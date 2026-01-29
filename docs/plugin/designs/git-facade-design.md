# Git Facade Service Design Document

> **Status:** Design complete. Implementation blocked on Story 2 (Plugin Runtime).
>
> This document captures the facade design for reference when Story 2 is complete.

---

## Overview

The GitFacade is a thin service wrapper that abstracts git operations behind the plugin system. It follows the generic facade pattern documented in [PLUGIN_SYSTEM_RFC.md - Facade Resolution Flow](../PLUGIN_SYSTEM_RFC.md#facade-resolution-flow).

---

## Provider Resolution: Three-Level Configuration

Git provider selection follows the **three-level configuration** model:

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. USER LEVEL (Settings > Plugins)                                  │
│    - Install git provider plugins (GitHub, GitLab, Bitbucket)       │
│    - Connect OAuth for each provider                                │
│    - Tokens stored in UserPlugin.settings.accessToken               │
├─────────────────────────────────────────────────────────────────────┤
│ 2. DIRECTORY LEVEL (Directory > Apps)                               │
│    - Select DEFAULT git provider for this directory                 │
│    - Stored in DirectoryPlugin.settings.defaults['git-provider']    │
├─────────────────────────────────────────────────────────────────────┤
│ 3. GENERATION LEVEL (Generator Form)                                │
│    - Override provider for THIS generation only                     │
│    - Passed via GenerationOptions.providers.git                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Example Flow

```
User installs: GitHub plugin, GitLab plugin
User connects: GitHub OAuth ✓, GitLab OAuth ✓
  └─→ Stored in UserPlugin.settings for each

Directory A → DirectoryPlugin.settings.defaults['git-provider'] = 'github'
Directory B → DirectoryPlugin.settings.defaults['git-provider'] = 'gitlab'

When generating for Directory A:
  1. GenerationOptions.providers.git is null (no override)
  2. Facade reads DirectoryPlugin → 'github'
  3. Facade gets GitHub plugin from registry
  4. Facade gets user's GitHub token from UserPlugin
  5. GitHub plugin creates repo, pushes code
```

---

## Database Model (Plugin System)

### Token Storage: UserPlugin

OAuth tokens are stored in `UserPlugin.settings` (NOT `User.oauthTokens[]`):

```typescript
// UserPlugin entity
{
    userId: 'user-123',
    pluginId: 'github',  // or 'gitlab', 'bitbucket'
    settings: {
        accessToken: 'gho_xxxx...',      // Encrypted
        refreshToken: 'ghr_xxxx...',      // Encrypted
        scope: 'repo,read:user',
        expiresAt: '2024-01-01T00:00:00Z',
        username: 'octocat',
        email: 'user@example.com',
        metadata: { login: 'octocat', avatar_url: '...' }
    },
    enabled: true
}
```

### Provider Selection: DirectoryPlugin

Default provider per directory is stored in `DirectoryPlugin.settings`:

```typescript
// DirectoryPlugin entity
{
    directoryId: 'dir-456',
    pluginId: 'github',  // The selected git provider
    settings: {
        defaults: {
            'git-provider': 'github'  // Selected provider ID
        },
        // Provider-specific settings...
        lastPullRequest: { main: {...}, data: {...} }
    },
    enabled: true
}
```

### Migration from Hardcoded Fields

See [PLUGIN_SYSTEM_RFC.md - Migration from Hardcoded Infrastructure](../PLUGIN_SYSTEM_RFC.md#migration-from-hardcoded-infrastructure) for the full migration plan.

| Current (Hardcoded)         | After (Plugin System)                               |
| --------------------------- | --------------------------------------------------- |
| `User.oauthTokens[]`        | `UserPlugin.settings`                               |
| `Directory.repoProvider`    | `DirectoryPlugin.settings.defaults['git-provider']` |
| `Directory.lastPullRequest` | `DirectoryPlugin.settings.lastPullRequest`          |
| `User.getGitToken()`        | `GitFacade.getToken()`                              |
| `User.asCommitter()`        | `GitFacade.getCommitter()`                          |
| `Directory.getRepoOwner()`  | `GitFacade.getRepoOwner()`                          |

---

## GitFacade Implementation

### Location

`packages/agent/src/facades/git.facade.ts`

### Dependencies

- **PluginRegistryService** (Story 2) - Get plugin instances by capability
- **PluginSettingsService** (Story 2) - Resolve settings with 4-level hierarchy

### Interface Design

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
	IGitProviderPlugin,
	CreateRepoOptions,
	GitRepository,
	GitCloneOptions,
	GitPushOptions,
	GitCommitter,
	CreatePROptions,
	GitPullRequest,
	MergeOptions,
	MergeResult,
	GitBranch,
	GitUser,
	GitOrganization
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginSettingsService } from '../plugins/plugin-settings.service';
import { UserPlugin, DirectoryPlugin } from '../plugins/entities';

@Injectable()
export class GitFacade {
	private readonly logger = new Logger(GitFacade.name);

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly settingsService: PluginSettingsService
	) {}

	// ========================================
	// PLUGIN RESOLUTION (Private)
	// ========================================

	/**
	 * Get the git provider plugin for a directory.
	 *
	 * Resolution order:
	 * 1. providerOverride (from GenerationOptions.providers.git)
	 * 2. DirectoryPlugin.settings.defaults['git-provider']
	 * 3. Platform default (first available)
	 */
	private async getPlugin(directoryId: string, providerOverride?: string): Promise<IGitProviderPlugin> {
		const providerId =
			providerOverride ??
			(await this.settingsService.getDirectoryProvider(directoryId, 'git-provider')) ??
			(await this.settingsService.getPlatformDefault('git-provider'));

		if (!providerId) {
			throw new GitProviderNotFoundError('No git provider configured');
		}

		const plugin = this.registry.getByCapability<IGitProviderPlugin>('git-provider', providerId);

		if (!plugin) {
			throw new GitProviderNotFoundError(providerId);
		}

		return plugin;
	}

	/**
	 * Get user's OAuth token for the specified git provider.
	 *
	 * Reads from UserPlugin.settings.accessToken (encrypted).
	 */
	private async getToken(userId: string, providerId: string): Promise<string> {
		const settings = await this.settingsService.getUserPluginSettings(userId, providerId);

		if (!settings?.accessToken) {
			throw new GitTokenMissingError(providerId);
		}

		return settings.accessToken;
	}

	/**
	 * Get committer info for a user from their git provider connection.
	 */
	async getCommitter(userId: string, providerId: string): Promise<GitCommitter> {
		const settings = await this.settingsService.getUserPluginSettings(userId, providerId);

		return {
			name: settings?.username || settings?.metadata?.login || 'Unknown',
			email: settings?.email || 'unknown@example.com'
		};
	}

	/**
	 * Get repository owner for a directory.
	 * Returns the username from the user's git provider connection.
	 */
	async getRepoOwner(directoryId: string, userId: string): Promise<string> {
		const providerId = await this.settingsService.getDirectoryProvider(directoryId, 'git-provider');

		if (!providerId) {
			throw new GitProviderNotFoundError('No git provider configured for directory');
		}

		const settings = await this.settingsService.getUserPluginSettings(userId, providerId);
		return settings?.username || settings?.metadata?.login;
	}

	// ========================================
	// REPOSITORY OPERATIONS
	// ========================================

	async createRepository(
		options: CreateRepoOptions,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<GitRepository> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const token = await this.getToken(userId, plugin.id);
		return plugin.createRepository(options, token);
	}

	async getRepository(
		owner: string,
		repo: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<GitRepository | null> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const token = await this.getToken(userId, plugin.id);
		return plugin.getRepository(owner, repo, token);
	}

	async deleteRepository(
		owner: string,
		repo: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<void> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const token = await this.getToken(userId, plugin.id);
		return plugin.deleteRepository(owner, repo, token);
	}

	// ========================================
	// USER & ORGANIZATION OPERATIONS
	// ========================================

	async getUser(directoryId: string, userId: string, providerOverride?: string): Promise<GitUser> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const token = await this.getToken(userId, plugin.id);
		return plugin.getUser(token);
	}

	async getOrganizations(directoryId: string, userId: string, providerOverride?: string): Promise<GitOrganization[]> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const token = await this.getToken(userId, plugin.id);
		return plugin.getOrganizations(token);
	}

	// ========================================
	// LOCAL GIT OPERATIONS
	// ========================================

	async cloneOrPull(options: GitCloneOptions, directoryId: string, providerOverride?: string): Promise<string> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		return plugin.cloneOrPull(options);
	}

	async commit(
		dir: string,
		message: string,
		directoryId: string,
		committer?: GitCommitter,
		providerOverride?: string
	): Promise<string> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		return plugin.commit(dir, message, committer);
	}

	async push(options: GitPushOptions, directoryId: string, providerOverride?: string): Promise<void> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		return plugin.push(options);
	}

	// ========================================
	// PULL REQUEST OPERATIONS
	// ========================================

	async createPullRequest(
		options: CreatePROptions,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<GitPullRequest> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const token = await this.getToken(userId, plugin.id);
		return plugin.createPullRequest(options, token);
	}

	async mergePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		options: MergeOptions | undefined,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<MergeResult> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const token = await this.getToken(userId, plugin.id);
		return plugin.mergePullRequest(owner, repo, prNumber, options, token);
	}

	// ========================================
	// BRANCH OPERATIONS
	// ========================================

	async listBranches(
		owner: string,
		repo: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<GitBranch[]> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const token = await this.getToken(userId, plugin.id);
		return plugin.listBranches(owner, repo, token);
	}
}
```

---

## Error Types

**Location:** `packages/agent/src/facades/errors/git-facade.errors.ts`

```typescript
export class GitFacadeError extends Error {
	constructor(
		message: string,
		public readonly operation: string,
		public readonly provider?: string,
		public readonly cause?: Error
	) {
		super(message);
		this.name = 'GitFacadeError';
	}
}

export class GitProviderNotFoundError extends GitFacadeError {
	constructor(providerId: string) {
		super(`Git provider not found: ${providerId}`, 'getPlugin', providerId);
		this.name = 'GitProviderNotFoundError';
	}
}

export class GitTokenMissingError extends GitFacadeError {
	constructor(providerId: string) {
		super(
			`No ${providerId} token found for user. Please connect your ${providerId} account.`,
			'getToken',
			providerId
		);
		this.name = 'GitTokenMissingError';
	}
}
```

---

## Module Structure

### Facades Module

**Location:** `packages/agent/src/facades/facades.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { GitFacade } from './git.facade';
import { DeployFacade } from './deploy.facade';
import { ScreenshotFacade } from './screenshot.facade';
import { SearchFacade } from './search.facade';
import { AiFacade } from './ai.facade';
import { GitOAuthFacade } from './git-oauth.facade';
import { PluginsModule } from '../plugins/plugins.module';

@Module({
	imports: [PluginsModule],
	providers: [GitFacade, DeployFacade, ScreenshotFacade, SearchFacade, AiFacade, GitOAuthFacade],
	exports: [GitFacade, DeployFacade, ScreenshotFacade, SearchFacade, AiFacade, GitOAuthFacade]
})
export class FacadesModule {}
```

---

## Files to Create

| File                                                     | Description            |
| -------------------------------------------------------- | ---------------------- |
| `packages/agent/src/facades/git.facade.ts`               | Main GitFacade service |
| `packages/agent/src/facades/errors/git-facade.errors.ts` | Error types            |
| `packages/agent/src/facades/facades.module.ts`           | NestJS module          |
| `packages/agent/src/facades/index.ts`                    | Barrel exports         |

---

## Dependencies (Story 2 Required)

This implementation requires services from Story 2 - Plugin Runtime:

1. **PluginRegistryService**
    - `getByCapability<T>(capability: string, providerId?: string): T`

2. **PluginSettingsService**
    - `getDirectoryProvider(directoryId: string, capability: string): Promise<string | null>`
    - `getPlatformDefault(capability: string): Promise<string | null>`
    - `getUserPluginSettings(userId: string, pluginId: string): Promise<Record<string, unknown>>`
    - `resolveSettings(userId: string, directoryId: string, pluginId: string): Promise<Record<string, unknown>>`

---

## Migration Pattern

Once Story 2 (Plugin Runtime) is complete, services will migrate from:

```typescript
// BEFORE - Hardcoded GitHub + entity methods
constructor(private readonly githubService: GithubService) {}

async generateWebsite(directory: Directory, user: User) {
    const token = user.getGitToken();           // ❌ From User.oauthTokens[]
    const owner = directory.getRepoOwner();     // ❌ From Directory.repoProvider
    const committer = user.asCommitter();       // ❌ From User.oauthTokens[]

    await this.githubService.createEmptyRepo(name, description, token);
}
```

To:

```typescript
// AFTER - Plugin system with facade
constructor(private readonly gitFacade: GitFacade) {}

async generateWebsite(directory: Directory, user: User) {
    const owner = await this.gitFacade.getRepoOwner(directory.id, user.id);
    const committer = await this.gitFacade.getCommitter(user.id, 'github');

    await this.gitFacade.createRepository(
        { name, description, owner },
        directory.id,      // Facade reads DirectoryPlugin for provider
        user.id,           // Facade reads UserPlugin for token
    );
}
```

---

## User Flow Example

### Setup (One-Time)

1. User goes to **Settings > Plugins**
2. User installs "GitHub" plugin (may be pre-installed as system plugin)
3. User clicks **"Connect GitHub Account"** (OAuth flow)
    - Token stored in `UserPlugin.settings.accessToken` (encrypted)
4. User optionally installs and connects "GitLab" plugin

### Per-Directory Configuration

1. User creates Directory A
2. In **Directory A > Apps**, user selects git provider: "GitHub"
    - Stored in `DirectoryPlugin.settings.defaults['git-provider'] = 'github'`
3. User creates Directory B
4. In **Directory B > Apps**, user selects git provider: "GitLab"
    - Stored in `DirectoryPlugin.settings.defaults['git-provider'] = 'gitlab'`

### Generation (Runtime)

**When generating data for Directory A:**

1. GitFacade reads `DirectoryPlugin.settings.defaults['git-provider']` → "github"
2. GitFacade gets GitHub plugin from registry
3. GitFacade gets user's GitHub OAuth token from `UserPlugin.settings.accessToken`
4. GitHub plugin creates repo, pushes code

**When generating for Directory B:**

1. GitFacade reads `DirectoryPlugin.settings.defaults['git-provider']` → "gitlab"
2. GitFacade gets GitLab plugin from registry
3. GitFacade gets user's GitLab OAuth token from `UserPlugin.settings.accessToken`
4. GitLab plugin creates repo, pushes code

---

## Generation-Level Override

Users can override the provider at generation time via the generator form:

```typescript
// GenerationOptions (passed to pipeline)
interface GenerationOptions {
	// ... existing fields ...

	providers?: {
		git?: string | null; // Override: "gitlab" | "github" | null
		search?: string | null;
		screenshot?: string | null;
		ai?: string | null;
	};
}

// When processing generation
const providerId =
	generationOptions.providers?.git ?? // Generation override
	directoryPlugin.settings.defaults['git-provider'] ?? // Directory default
	platformDefault; // System fallback
```

---

## Related Documentation

- [PLUGIN_SYSTEM_RFC.md - Generator Form Architecture](../PLUGIN_SYSTEM_RFC.md#generator-form-architecture)
- [PLUGIN_SYSTEM_RFC.md - Migration from Hardcoded Infrastructure](../PLUGIN_SYSTEM_RFC.md#migration-from-hardcoded-infrastructure)
- [PLUGIN_SYSTEM_RFC.md - Settings Resolution](../PLUGIN_SYSTEM_RFC.md#settings-resolution)
- [PLUGIN_SYSTEM_CHECKLIST.md - Story 10a](../PLUGIN_SYSTEM_CHECKLIST.md)
