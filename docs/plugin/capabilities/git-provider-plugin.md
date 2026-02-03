# Creating a Git Provider Plugin

This guide explains how to create a Git provider plugin for Ever Works. Git providers enable repository management, git operations (clone, push, commit), and integration with platforms like GitHub, GitLab, or Bitbucket.

## Overview

A Git provider plugin can support two authentication methods:

| Method                          | Use Case                             | Capability               |
| ------------------------------- | ------------------------------------ | ------------------------ |
| **OAuth**                       | User authorizes via browser redirect | `git-provider` + `oauth` |
| **Personal Access Token (PAT)** | User enters token in settings        | `git-provider` only      |

The platform's `GitFacade` automatically handles token resolution with fallback:

1. Direct token (if provided)
2. OAuth token (from `oauth_tokens` table)
3. PAT from plugin settings (from `user_plugins.secretSettings`)

## Quick Start

### Option A: OAuth-based Provider (like GitHub)

```typescript
import type {
	IPlugin,
	IGitProviderPlugin,
	IOAuthPlugin,
	PluginContext,
	GitAuth,
	OAuthConfig,
	OAuthToken,
	OAuthUser
	// ... other types
} from '@ever-works/plugin';
import { GitOperations } from '@ever-works/plugin/git';

export class MyGitProviderPlugin implements IPlugin, IGitProviderPlugin, IOAuthPlugin {
	readonly id = 'my-git-provider';
	readonly name = 'My Git Provider';
	readonly version = '1.0.0';
	readonly category = 'git-provider';
	readonly capabilities = ['git-provider', 'oauth'] as const;
	readonly providerName = 'my-provider';
	readonly configurationMode = 'admin-only'; // OAuth credentials set by admin

	// Settings schema for OAuth
	readonly settingsSchema = {
		type: 'object',
		properties: {
			clientId: {
				type: 'string',
				title: 'Client ID',
				'x-envVar': 'PLUGIN_MY_PROVIDER_CLIENT_ID',
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			clientSecret: {
				type: 'string',
				title: 'Client Secret',
				'x-secret': true,
				'x-envVar': 'PLUGIN_MY_PROVIDER_CLIENT_SECRET',
				'x-adminOnly': true,
				'x-scope': 'global'
			}
		}
	};

	// ... implement IGitProviderPlugin and IOAuthPlugin methods
}
```

### Option B: PAT-based Provider (like GitLab with PAT)

```typescript
export class GitLabPATPlugin implements IPlugin, IGitProviderPlugin {
	readonly id = 'gitlab';
	readonly name = 'GitLab';
	readonly version = '1.0.0';
	readonly category = 'git-provider';
	readonly capabilities = ['git-provider'] as const; // NO 'oauth'
	readonly providerName = 'gitlab';
	readonly configurationMode = 'user-required'; // Users must enter their PAT

	readonly settingsSchema = {
		type: 'object',
		properties: {
			accessToken: {
				type: 'string',
				title: 'Personal Access Token',
				description: 'GitLab PAT with api and read_repository scopes',
				'x-secret': true,
				'x-scope': 'user', // User-level setting
				'x-masked': true
			},
			gitUsername: {
				type: 'string',
				title: 'Git Username',
				description: 'Username for git commits',
				'x-scope': 'user'
			},
			gitEmail: {
				type: 'string',
				title: 'Git Email',
				description: 'Email for git commits',
				'x-scope': 'user'
			},
			baseUrl: {
				type: 'string',
				title: 'GitLab URL',
				default: 'https://gitlab.com',
				'x-scope': 'global'
			}
		},
		required: ['accessToken']
	};

	// ... implement IGitProviderPlugin methods only
}
```

## Complete Implementation Guide

### 1. Project Setup

Create a new plugin package:

```bash
mkdir packages/plugins/my-git-provider
cd packages/plugins/my-git-provider
pnpm init
```

**package.json:**

```json
{
	"name": "@ever-works/my-git-provider-plugin",
	"version": "1.0.0",
	"type": "module",
	"main": "./dist/index.js",
	"module": "./dist/index.mjs",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"import": "./dist/index.mjs",
			"require": "./dist/index.js",
			"types": "./dist/index.d.ts"
		}
	},
	"scripts": {
		"build": "tsup",
		"dev": "tsup --watch"
	},
	"dependencies": {
		"@ever-works/plugin": "workspace:*"
	},
	"devDependencies": {
		"tsup": "^8.0.0",
		"typescript": "^5.0.0"
	}
}
```

**tsup.config.ts:**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	target: 'es2021'
});
```

### 2. Implement the Plugin Class

**src/my-git-provider.plugin.ts:**

```typescript
import type {
	IPlugin,
	IGitProviderPlugin,
	IOAuthPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	GitAuth,
	GitRepository,
	GitUser,
	GitOrganization,
	GitBranch,
	GitCommit,
	GitPullRequest,
	CreateRepoOptions,
	CreatePROptions,
	MergeOptions,
	MergeResult,
	ForkRepositoryOptions,
	GitRepositoryWithPermissions,
	GitCloneOptions,
	GitPushOptions,
	GitCommitter,
	GitFileChange,
	OAuthConfig,
	OAuthToken,
	OAuthUser
} from '@ever-works/plugin';
import { GitOperations } from '@ever-works/plugin/git';

interface MyProviderSettings {
	clientId?: string;
	clientSecret?: string;
	apiBaseUrl?: string;
}

export class MyGitProviderPlugin implements IPlugin, IGitProviderPlugin, IOAuthPlugin {
	// ─────────────────────────────────────────────────────────────────
	// Plugin Identity
	// ─────────────────────────────────────────────────────────────────

	readonly id = 'my-git-provider';
	readonly name = 'My Git Provider';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'git-provider';
	readonly capabilities: readonly string[] = ['git-provider', 'oauth'];
	readonly providerName = 'my-provider';
	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'admin-only';

	// ─────────────────────────────────────────────────────────────────
	// Settings Schema
	// ─────────────────────────────────────────────────────────────────

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			clientId: {
				type: 'string',
				title: 'Client ID',
				description: 'OAuth App Client ID',
				'x-envVar': 'PLUGIN_MY_PROVIDER_CLIENT_ID',
				'x-writeOnly': true,
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			clientSecret: {
				type: 'string',
				title: 'Client Secret',
				description: 'OAuth App Client Secret',
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				'x-envVar': 'PLUGIN_MY_PROVIDER_CLIENT_SECRET',
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			apiBaseUrl: {
				type: 'string',
				title: 'API Base URL',
				description: 'API base URL (for self-hosted instances)',
				default: 'https://api.myprovider.com',
				'x-envVar': 'PLUGIN_MY_PROVIDER_API_URL',
				'x-scope': 'global'
			}
		}
	};

	// ─────────────────────────────────────────────────────────────────
	// Private State
	// ─────────────────────────────────────────────────────────────────

	private context?: PluginContext;
	private gitOps?: GitOperations;

	// ─────────────────────────────────────────────────────────────────
	// IGitProviderPlugin - Authentication
	// ─────────────────────────────────────────────────────────────────

	/**
	 * Returns credentials for git operations (clone, push, etc.)
	 * Common patterns:
	 * - GitHub: { username: 'x-access-token', password: token }
	 * - GitLab: { username: 'oauth2', password: token }
	 * - Bitbucket: { username: 'x-token-auth', password: token }
	 */
	getAuth(token: string): GitAuth {
		return { username: 'x-access-token', password: token };
	}

	/**
	 * Returns the HTTPS clone URL for a repository
	 */
	getCloneUrl(owner: string, repo: string): string {
		return `https://myprovider.com/${owner}/${repo}.git`;
	}

	/**
	 * Returns the web URL for viewing a repository
	 */
	getWebUrl(owner: string, repo: string): string {
		return `https://myprovider.com/${owner}/${repo}`;
	}

	// ─────────────────────────────────────────────────────────────────
	// IGitProviderPlugin - User & Organization
	// ─────────────────────────────────────────────────────────────────

	async getUser(token: string): Promise<GitUser> {
		const settings = await this.getSettings();
		const response = await fetch(`${settings.apiBaseUrl}/user`, {
			headers: { Authorization: `Bearer ${token}` }
		});
		const data = await response.json();

		return {
			id: String(data.id),
			login: data.username,
			name: data.name,
			email: data.email,
			avatarUrl: data.avatar_url
		};
	}

	async getOrganizations(token: string): Promise<GitOrganization[]> {
		const settings = await this.getSettings();
		const response = await fetch(`${settings.apiBaseUrl}/user/orgs`, {
			headers: { Authorization: `Bearer ${token}` }
		});
		const data = await response.json();

		return data.map((org: any) => ({
			id: String(org.id),
			login: org.login,
			name: org.name,
			avatarUrl: org.avatar_url
		}));
	}

	// ─────────────────────────────────────────────────────────────────
	// IGitProviderPlugin - Repository Operations
	// ─────────────────────────────────────────────────────────────────

	async getRepository(owner: string, repo: string, token: string): Promise<GitRepository | null> {
		const settings = await this.getSettings();
		const response = await fetch(`${settings.apiBaseUrl}/repos/${owner}/${repo}`, {
			headers: { Authorization: `Bearer ${token}` }
		});

		if (!response.ok) return null;
		const data = await response.json();

		return {
			owner: data.owner.login,
			name: data.name,
			fullName: data.full_name,
			description: data.description,
			defaultBranch: data.default_branch,
			isPrivate: data.private,
			url: data.html_url,
			cloneUrl: data.clone_url,
			isFork: data.fork
		};
	}

	async listRepositories(token: string, page = 1, perPage = 30): Promise<GitRepositoryWithPermissions[]> {
		const settings = await this.getSettings();
		const response = await fetch(`${settings.apiBaseUrl}/user/repos?page=${page}&per_page=${perPage}`, {
			headers: { Authorization: `Bearer ${token}` }
		});
		const data = await response.json();

		return data.map((repo: any) => ({
			owner: repo.owner.login,
			name: repo.name,
			fullName: repo.full_name,
			defaultBranch: repo.default_branch,
			isPrivate: repo.private,
			url: repo.html_url,
			cloneUrl: repo.clone_url,
			permissions: repo.permissions
		}));
	}

	async createRepository(options: CreateRepoOptions, token: string): Promise<GitRepository> {
		const settings = await this.getSettings();
		const url = options.organization
			? `${settings.apiBaseUrl}/orgs/${options.organization}/repos`
			: `${settings.apiBaseUrl}/user/repos`;

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				name: options.name,
				description: options.description,
				private: options.isPrivate
			})
		});

		const data = await response.json();
		return {
			owner: data.owner.login,
			name: data.name,
			fullName: data.full_name,
			defaultBranch: data.default_branch,
			isPrivate: data.private,
			url: data.html_url,
			cloneUrl: data.clone_url
		};
	}

	async deleteRepository(owner: string, repo: string, token: string): Promise<void> {
		const settings = await this.getSettings();
		await fetch(`${settings.apiBaseUrl}/repos/${owner}/${repo}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${token}` }
		});
	}

	// ─────────────────────────────────────────────────────────────────
	// IGitProviderPlugin - Branch Operations
	// ─────────────────────────────────────────────────────────────────

	async listBranches(owner: string, repo: string, token: string): Promise<GitBranch[]> {
		const settings = await this.getSettings();
		const response = await fetch(`${settings.apiBaseUrl}/repos/${owner}/${repo}/branches`, {
			headers: { Authorization: `Bearer ${token}` }
		});
		const data = await response.json();

		return data.map((branch: any) => ({
			name: branch.name,
			commit: branch.commit.sha,
			isDefault: branch.name === 'main' || branch.name === 'master',
			isProtected: branch.protected
		}));
	}

	// ─────────────────────────────────────────────────────────────────
	// IGitProviderPlugin - Pull Request Operations
	// ─────────────────────────────────────────────────────────────────

	async createPullRequest(options: CreatePROptions, token: string): Promise<GitPullRequest> {
		const settings = await this.getSettings();
		const response = await fetch(`${settings.apiBaseUrl}/repos/${options.owner}/${options.repo}/pulls`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				title: options.title,
				head: options.head,
				base: options.base,
				body: options.body,
				draft: options.draft
			})
		});

		const data = await response.json();
		return {
			number: data.number,
			title: data.title,
			state: data.state,
			head: data.head.ref,
			base: data.base.ref,
			url: data.html_url,
			createdAt: data.created_at,
			updatedAt: data.updated_at
		};
	}

	async mergePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		options: MergeOptions | undefined,
		token: string
	): Promise<MergeResult> {
		const settings = await this.getSettings();
		const response = await fetch(`${settings.apiBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				commit_title: options?.commitTitle,
				commit_message: options?.commitMessage,
				merge_method: options?.mergeMethod || 'merge'
			})
		});

		const data = await response.json();
		return {
			sha: data.sha,
			merged: data.merged,
			message: data.message
		};
	}

	// ─────────────────────────────────────────────────────────────────
	// IGitProviderPlugin - Local Git Operations (via GitOperations)
	// ─────────────────────────────────────────────────────────────────

	async cloneOrPull(options: GitCloneOptions): Promise<string> {
		this.ensureGitOps();
		return this.gitOps!.cloneOrPull(options);
	}

	async pull(dir: string, token: string, committer?: GitCommitter): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.pull(dir, token, committer);
	}

	async add(dir: string, paths: string | string[]): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.add(dir, paths);
	}

	async addAll(dir: string): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.addAll(dir);
	}

	async commit(dir: string, message: string, committer?: GitCommitter): Promise<string> {
		this.ensureGitOps();
		return this.gitOps!.commit(dir, message, committer);
	}

	async push(options: GitPushOptions): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.push(options);
	}

	async getCurrentBranch(dir: string): Promise<string | null> {
		this.ensureGitOps();
		return this.gitOps!.getCurrentBranch(dir);
	}

	async getMainBranch(dir: string): Promise<string | null> {
		this.ensureGitOps();
		return this.gitOps!.getMainBranch(dir);
	}

	async switchBranch(dir: string, branch: string, create?: boolean): Promise<string> {
		this.ensureGitOps();
		return this.gitOps!.switchBranch(dir, branch, create);
	}

	async getStatus(dir: string): Promise<GitFileChange[]> {
		this.ensureGitOps();
		return this.gitOps!.getStatus(dir);
	}

	getLocalDir(owner: string, repo: string): string {
		this.ensureGitOps();
		return this.gitOps!.getLocalDir(owner, repo);
	}

	async removeLocalDir(owner: string, repo: string): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.removeLocalDir(owner, repo);
	}

	// ─────────────────────────────────────────────────────────────────
	// IOAuthPlugin - OAuth Implementation
	// ─────────────────────────────────────────────────────────────────

	/**
	 * Generate the authorization URL for OAuth redirect
	 * The user will be redirected here to authorize the app
	 */
	getAuthorizationUrl(state: string, config?: Partial<OAuthConfig>): string {
		const clientId = config?.clientId;
		const redirectUri = config?.redirectUri;
		const scopes = config?.scopes || ['read:user', 'repo'];

		if (!clientId) {
			throw new Error('OAuth client ID not configured');
		}

		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri || '',
			scope: scopes.join(' '),
			state,
			response_type: 'code'
		});

		return `https://myprovider.com/oauth/authorize?${params.toString()}`;
	}

	/**
	 * Exchange authorization code for access token
	 * Called after user authorizes and is redirected back
	 */
	async exchangeCodeForToken(code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken> {
		const clientId = config?.clientId;
		const clientSecret = config?.clientSecret;
		const redirectUri = config?.redirectUri;

		if (!clientId || !clientSecret) {
			throw new Error('OAuth credentials not configured');
		}

		const response = await fetch('https://myprovider.com/oauth/token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json'
			},
			body: JSON.stringify({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: redirectUri,
				grant_type: 'authorization_code'
			})
		});

		const data = await response.json();

		if (data.error) {
			throw new Error(`OAuth error: ${data.error_description || data.error}`);
		}

		return {
			accessToken: data.access_token,
			tokenType: data.token_type || 'bearer',
			scope: data.scope,
			expiresIn: data.expires_in,
			refreshToken: data.refresh_token
		};
	}

	/**
	 * Get authenticated user info using the access token
	 */
	async getAuthenticatedUser(token: string): Promise<OAuthUser> {
		const user = await this.getUser(token);
		return {
			id: user.id,
			username: user.login,
			email: user.email,
			name: user.name,
			avatarUrl: user.avatarUrl
		};
	}

	// ─────────────────────────────────────────────────────────────────
	// IPlugin - Lifecycle Methods
	// ─────────────────────────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.gitOps = new GitOperations(
			(token) => this.getAuth(token),
			(owner, repo) => this.getCloneUrl(owner, repo)
		);
		context.logger.log('My Git Provider Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('My Git Provider Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('My Git Provider Plugin disabled');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.gitOps = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (settings.apiBaseUrl && typeof settings.apiBaseUrl === 'string') {
			try {
				new URL(settings.apiBaseUrl);
			} catch {
				errors.push({ path: 'apiBaseUrl', message: 'Invalid URL format' });
			}
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined
		};
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'My Git Provider plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'My Git Provider integration',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Your Name' },
			license: 'MIT',
			builtIn: false,
			autoEnable: false,
			visibility: 'user-only',
			icon: {
				type: 'lucide',
				value: 'GitBranch',
				backgroundColor: '#6366f1'
			}
		};
	}

	// ─────────────────────────────────────────────────────────────────
	// Private Helpers
	// ─────────────────────────────────────────────────────────────────

	private async getSettings(): Promise<MyProviderSettings> {
		if (!this.context) return {};
		const settings = await this.context.getSettings();
		return {
			clientId: settings?.clientId as string | undefined,
			clientSecret: settings?.clientSecret as string | undefined,
			apiBaseUrl: (settings?.apiBaseUrl as string) || 'https://api.myprovider.com'
		};
	}

	private ensureGitOps(): void {
		if (!this.gitOps) {
			this.gitOps = new GitOperations(
				(token) => this.getAuth(token),
				(owner, repo) => this.getCloneUrl(owner, repo)
			);
		}
	}
}

export default MyGitProviderPlugin;
```

### 3. Export the Plugin

**src/index.ts:**

```typescript
export { MyGitProviderPlugin, default } from './my-git-provider.plugin.js';
```

## Settings Schema Reference

### Schema Extensions (x- properties)

| Property            | Type                                    | Description                        |
| ------------------- | --------------------------------------- | ---------------------------------- |
| `x-secret`          | boolean                                 | Value is encrypted in database     |
| `x-masked`          | boolean                                 | Value shown as `****` in UI        |
| `x-writeOnly`       | boolean                                 | Value cannot be read back          |
| `x-envVar`          | string                                  | Read from environment variable     |
| `x-adminOnly`       | boolean                                 | Only admin can modify              |
| `x-scope`           | `'global'` \| `'user'` \| `'directory'` | Where setting can be configured    |
| `x-requiresRestart` | boolean                                 | Plugin restart needed after change |

### Scope Hierarchy

Settings are resolved in this order (highest priority first):

1. **Directory** - Per-directory settings (`directory_plugins.secretSettings`)
2. **User** - Per-user settings (`user_plugins.secretSettings`)
3. **Admin** - Global admin settings (`plugins.secretSettings`)
4. **Environment** - Environment variables (via `x-envVar`)
5. **Default** - Schema default value

### PAT-based Plugin Settings Example

For plugins using Personal Access Tokens instead of OAuth:

```typescript
readonly settingsSchema: JsonSchema = {
    type: 'object',
    properties: {
        // Required: accessToken is used by GitFacade for PAT fallback
        accessToken: {
            type: 'string',
            title: 'Personal Access Token',
            description: 'Create at: https://gitlab.com/-/profile/personal_access_tokens',
            'x-secret': true,
            'x-masked': true,
            'x-scope': 'user', // User enters their own token
        },
        // Optional: for git commit author info
        gitUsername: {
            type: 'string',
            title: 'Git Username',
            'x-scope': 'user',
        },
        gitEmail: {
            type: 'string',
            title: 'Git Email',
            'x-scope': 'user',
        },
        // Optional: for self-hosted instances
        baseUrl: {
            type: 'string',
            title: 'GitLab URL',
            default: 'https://gitlab.com',
            'x-scope': 'global',
        },
    },
    required: ['accessToken'],
};
```

## Configuration Modes

| Mode            | Description                            | Use Case                            |
| --------------- | -------------------------------------- | ----------------------------------- |
| `admin-only`    | Only admin can configure               | OAuth apps with shared credentials  |
| `user-required` | Each user must configure               | PAT-based authentication            |
| `hybrid`        | Admin sets defaults, user can override | Mixed auth with self-hosted support |

## Testing Your Plugin

Create a test file at `src/__tests__/my-git-provider.plugin.spec.ts`:

```typescript
import { MyGitProviderPlugin } from '../my-git-provider.plugin';

describe('MyGitProviderPlugin', () => {
	let plugin: MyGitProviderPlugin;

	beforeEach(() => {
		plugin = new MyGitProviderPlugin();
	});

	describe('identity', () => {
		it('should have correct id and capabilities', () => {
			expect(plugin.id).toBe('my-git-provider');
			expect(plugin.capabilities).toContain('git-provider');
			expect(plugin.capabilities).toContain('oauth');
		});
	});

	describe('getAuth', () => {
		it('should return correct auth format', () => {
			const auth = plugin.getAuth('test-token');
			expect(auth.username).toBe('x-access-token');
			expect(auth.password).toBe('test-token');
		});
	});

	describe('getCloneUrl', () => {
		it('should return correct clone URL', () => {
			const url = plugin.getCloneUrl('owner', 'repo');
			expect(url).toBe('https://myprovider.com/owner/repo.git');
		});
	});

	describe('getAuthorizationUrl', () => {
		it('should generate authorization URL with state', () => {
			const url = plugin.getAuthorizationUrl('test-state', {
				clientId: 'client-123',
				redirectUri: 'https://app.com/callback'
			});

			expect(url).toContain('client_id=client-123');
			expect(url).toContain('state=test-state');
			expect(url).toContain('redirect_uri=');
		});

		it('should throw if clientId not configured', () => {
			expect(() => plugin.getAuthorizationUrl('state', {})).toThrow('OAuth client ID not configured');
		});
	});
});
```

## Registering Your Plugin

Add your plugin to the built-in plugins loader or register dynamically:

**Option A: Built-in Plugin**

Add to `packages/agent/src/plugins/built-in/index.ts`:

```typescript
import { MyGitProviderPlugin } from '@ever-works/my-git-provider-plugin';

export const BUILT_IN_PLUGINS = [
	// ... other plugins
	new MyGitProviderPlugin()
];
```

**Option B: Dynamic Registration**

```typescript
import { PluginLoaderService } from '@packages/agent';
import { MyGitProviderPlugin } from '@ever-works/my-git-provider-plugin';

// In your module
const plugin = new MyGitProviderPlugin();
await pluginLoader.loadPlugin(plugin);
```

## Environment Variables

For OAuth-based plugins, configure these environment variables:

```bash
# .env
PLUGIN_MY_PROVIDER_CLIENT_ID=your-oauth-client-id
PLUGIN_MY_PROVIDER_CLIENT_SECRET=your-oauth-client-secret
PLUGIN_MY_PROVIDER_API_URL=https://api.myprovider.com  # Optional
```

## OAuth Callback URL

When creating your OAuth app on the provider's developer console, use this callback URL:

```
https://your-domain.com/api/v1/auth/oauth/callback
```

The platform handles the OAuth callback flow automatically when your plugin implements `IOAuthPlugin`.

## See Also

- [OAuth Plugin Guide](./oauth-plugin.md) - For OAuth-only integrations
- [Plugin Architecture Guide](../PLUGIN_ARCHITECTURE_GUIDE.md) - Complete plugin system overview
- [Plugin Package Guide](../PLUGIN_PACKAGE_GUIDE.md) - Package structure and conventions
