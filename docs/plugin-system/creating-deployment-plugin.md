---
id: creating-deployment-plugin
title: 'Creating a Deployment Plugin'
sidebar_label: 'Deployment Plugin'
sidebar_position: 10
---

# Creating a Deployment Plugin

Ever Works deploys works as live websites through the cooperation of two plugin types: **git providers** and **deployment providers**. This guide covers how to create both.

## How Git and Deployment Work Together

The deployment pipeline follows this sequence:

1. The **git provider plugin** creates (or updates) a repository with the generated site files.
2. The git provider commits the content and pushes it to the remote.
3. The **deployment plugin** triggers a build -- either directly via API or by dispatching a CI workflow (e.g., GitHub Actions).
4. The deployment plugin polls for status and returns the live URL once the build completes.

Because of this tight coupling, a deployment plugin typically requires a git provider to be configured first. The platform's `DeployFacade` and `GitFacade` coordinate both plugin types behind the scenes.

## Creating a Git Provider Plugin

Git provider plugins extend `BaseGitProvider` from `@ever-works/plugin/abstract` and implement the `IGitProviderPlugin` interface from `@ever-works/plugin`.

### Project Setup

Create a new package in `packages/plugins/`:

```
packages/plugins/gitlab/
  src/
    index.ts
    gitlab.plugin.ts
    gitlab-api.service.ts
    types.ts
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
```

Your `package.json` must declare the plugin metadata under `everworks.plugin`:

```json
{
	"name": "@ever-works/gitlab-plugin",
	"version": "1.0.0",
	"type": "module",
	"main": "./dist/index.cjs",
	"module": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js",
			"require": "./dist/index.cjs"
		}
	},
	"scripts": {
		"build": "tsup",
		"test": "vitest run"
	},
	"peerDependencies": {
		"@ever-works/plugin": "workspace:*",
		"isomorphic-git": "^1.27.0"
	},
	"devDependencies": {
		"@ever-works/plugin": "workspace:*",
		"isomorphic-git": "^1.27.0",
		"tsup": "^8.4.0",
		"typescript": "^5.7.3",
		"vitest": "^3.0.0"
	},
	"everworks": {
		"plugin": {
			"id": "gitlab",
			"name": "GitLab",
			"version": "1.0.0",
			"category": "git-provider",
			"capabilities": ["git-provider", "oauth"],
			"description": "GitLab integration for repository management and git operations",
			"author": { "name": "Your Name" },
			"license": "AGPL-3.0",
			"autoEnable": true,
			"systemPlugin": true,
			"builtIn": true,
			"visibility": "user-only"
		}
	}
}
```

### Implementing the Plugin Class

A git provider plugin implements two interfaces: `IPlugin` (base lifecycle) and `IGitProviderPlugin` (git operations + remote API).

```typescript
import type {
	IPlugin,
	IGitProviderPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	GitAuth,
	GitRepository,
	GitUser,
	GitOrganization,
	GitBranch,
	GitPullRequest,
	CreateRepoOptions,
	CreatePROptions,
	MergeOptions,
	MergeResult,
	GitCloneOptions,
	GitPushOptions,
	GitCommitter,
	GitFileChange,
	GitRepositoryWithPermissions,
	ListPullRequestsOptions
} from '@ever-works/plugin';
import { GitOperations } from '@ever-works/plugin/git';

export class GitLabPlugin implements IPlugin, IGitProviderPlugin {
	readonly id = 'gitlab';
	readonly name = 'GitLab';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'git-provider';
	readonly capabilities: readonly string[] = ['git-provider', 'oauth'];
	readonly providerName = 'gitlab';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			clientId: {
				type: 'string',
				title: 'Application ID',
				description: 'GitLab OAuth Application ID',
				'x-envVar': 'PLUGIN_GITLAB_CLIENT_ID',
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			clientSecret: {
				type: 'string',
				title: 'Application Secret',
				description: 'GitLab OAuth Application Secret',
				'x-secret': true,
				'x-envVar': 'PLUGIN_GITLAB_CLIENT_SECRET',
				'x-adminOnly': true,
				'x-scope': 'user'
			},
			apiBaseUrl: {
				type: 'string',
				title: 'API Base URL',
				description: 'GitLab API URL (for self-hosted instances)',
				default: 'https://gitlab.com',
				format: 'uri',
				'x-hidden': true,
				'x-scope': 'global'
			}
		}
	};

	readonly configurationMode = 'admin-only' as const;

	private context?: PluginContext;
	private gitOps?: GitOperations;

	// ================================================
	// Provider-specific authentication
	// ================================================

	getAuth(token: string): GitAuth {
		// GitLab uses 'oauth2' as the username for token auth
		return { username: 'oauth2', password: token };
	}

	getCloneUrl(owner: string, repo: string): string {
		return `https://gitlab.com/${owner}/${repo}.git`;
	}

	getWebUrl(owner: string, repo: string): string {
		return `https://gitlab.com/${owner}/${repo}`;
	}

	// ================================================
	// Remote API operations (provider-specific)
	// ================================================

	async getUser(token: string): Promise<GitUser> {
		// Call GitLab API: GET /api/v4/user
		throw new Error('Not implemented');
	}

	async getOrganizations(token: string): Promise<GitOrganization[]> {
		// Call GitLab API: GET /api/v4/groups
		throw new Error('Not implemented');
	}

	async createRepository(options: CreateRepoOptions, token: string): Promise<GitRepository> {
		// Call GitLab API: POST /api/v4/projects
		throw new Error('Not implemented');
	}

	async getRepository(owner: string, repo: string, token: string): Promise<GitRepositoryWithPermissions | null> {
		// Call GitLab API: GET /api/v4/projects/:id
		throw new Error('Not implemented');
	}

	async deleteRepository(owner: string, repo: string, token: string): Promise<void> {
		// Call GitLab API: DELETE /api/v4/projects/:id
		throw new Error('Not implemented');
	}

	async listBranches(owner: string, repo: string, token: string): Promise<GitBranch[]> {
		// Call GitLab API: GET /api/v4/projects/:id/repository/branches
		throw new Error('Not implemented');
	}

	async createPullRequest(options: CreatePROptions, token: string): Promise<GitPullRequest> {
		// GitLab calls these "merge requests"
		// Call GitLab API: POST /api/v4/projects/:id/merge_requests
		throw new Error('Not implemented');
	}

	async mergePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		options: MergeOptions | undefined,
		token: string
	): Promise<MergeResult> {
		// Call GitLab API: PUT /api/v4/projects/:id/merge_requests/:mr_iid/merge
		throw new Error('Not implemented');
	}

	// ================================================
	// Local git operations (delegated to GitOperations)
	// ================================================

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

	async commit(dir: string, message: string, committer?: GitCommitter): Promise<string | null> {
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

	async replaceRemote(dir: string, remote: string, url: string): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.replaceRemote(dir, remote, url);
	}

	async renameBranch(dir: string, oldName: string, newName: string): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.renameBranch(dir, oldName, newName);
	}

	// ================================================
	// Plugin lifecycle
	// ================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.gitOps = new GitOperations(
			(token) => this.getAuth(token),
			(owner, repo) => this.getCloneUrl(owner, repo)
		);
		context.logger.log('GitLab Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.gitOps = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'GitLab plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'GitLab integration for source code management',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Your Name' },
			license: 'AGPL-3.0',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			visibility: 'user-only',
			icon: { type: 'lucide', value: 'GitBranch' }
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

export default GitLabPlugin;
```

### Key Concepts

#### Provider-Specific vs. Shared Operations

The `IGitProviderPlugin` interface combines two concerns:

| Concern                       | Implementation              | Examples                                                                       |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| **Provider-specific methods** | You write these             | `getAuth()`, `getCloneUrl()`, `getWebUrl()`, `createRepository()`, `getUser()` |
| **Local git operations**      | Delegate to `GitOperations` | `cloneOrPull()`, `commit()`, `push()`, `switchBranch()`                        |

The `GitOperations` class from `@ever-works/plugin/git` uses `isomorphic-git` under the hood and works identically for all providers. You only need to supply two callbacks when constructing it: `getAuth()` and `getCloneUrl()`.

#### Authentication Formats

Each provider uses a different authentication scheme:

```typescript
// GitHub
getAuth(token: string): GitAuth {
  return { username: 'x-access-token', password: token };
}

// GitLab
getAuth(token: string): GitAuth {
  return { username: 'oauth2', password: token };
}

// Bitbucket
getAuth(token: string): GitAuth {
  return { username: 'x-token-auth', password: token };
}
```

#### Required vs. Optional Methods

The `IGitProviderPlugin` interface has both required and optional methods. Methods marked with `?` are optional:

**Required:**

- `getAuth()`, `getCloneUrl()`, `getWebUrl()` -- provider identity
- `createRepository()`, `getRepository()`, `deleteRepository()` -- repository CRUD
- `getUser()`, `getOrganizations()` -- user identity
- `listBranches()` -- branch listing
- `createPullRequest()`, `mergePullRequest()` -- PR workflow
- All `IGitOperations` methods (delegate to `GitOperations`)

**Optional:**

- `listRepositories()`, `hasRepositoryAccess()`, `updateRepository()` -- extended repository ops
- `createBranch()`, `deleteBranch()` -- remote branch management
- `forkRepository()`, `createRepositoryFromTemplate()` -- fork/template operations
- `listPullRequests()`, `getPullRequest()`, `getPullRequestFiles()` -- extended PR operations
- `getFileContent()`, `getReadme()`, `getWorkContents()` -- content access

### Settings Schema

Git provider plugins typically use `configurationMode: 'admin-only'` because OAuth credentials are configured at the system level:

```typescript
readonly settingsSchema: JsonSchema = {
  type: 'object',
  properties: {
    clientId: {
      type: 'string',
      title: 'Client ID',
      'x-envVar': 'PLUGIN_GITLAB_CLIENT_ID',  // Populated from env var
      'x-adminOnly': true,                      // Not visible to users
      'x-scope': 'global'                       // Platform-wide setting
    },
    clientSecret: {
      type: 'string',
      title: 'Client Secret',
      'x-secret': true,                         // Encrypted at rest
      'x-envVar': 'PLUGIN_GITLAB_CLIENT_SECRET',
      'x-adminOnly': true,
      'x-scope': 'user'
    },
    apiBaseUrl: {
      type: 'string',
      title: 'API Base URL',
      default: 'https://gitlab.com',
      'x-hidden': true,                          // Not shown in UI
      'x-scope': 'global'
    }
  }
};
```

:::tip Setting Schema Extensions

- `x-secret`: Value is encrypted and never returned in API responses.
- `x-envVar`: Pre-populated from the named environment variable on startup.
- `x-adminOnly`: Visible only to platform administrators.
- `x-scope`: Controls at which level the setting is stored (`global`, `user`, or `work`).
- `x-hidden`: Hidden from the settings UI entirely.
  :::

## Creating a Deployment Plugin

Deployment plugins implement `IPlugin` and `IDeploymentPlugin`. They handle the second half of the pipeline: taking committed code and making it a live website.

### Project Setup

```
packages/plugins/netlify/
  src/
    index.ts
    netlify.plugin.ts
    netlify-api.service.ts
    types.ts
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
```

The `package.json` declares the `deployment` category:

```json
{
	"name": "@ever-works/netlify-plugin",
	"version": "1.0.0",
	"type": "module",
	"peerDependencies": {
		"@ever-works/plugin": "workspace:*"
	},
	"everworks": {
		"plugin": {
			"id": "netlify",
			"name": "Netlify",
			"version": "1.0.0",
			"category": "deployment",
			"capabilities": ["deployment"],
			"description": "Deploy works to Netlify",
			"author": { "name": "Your Name" },
			"license": "AGPL-3.0",
			"autoEnable": true,
			"systemPlugin": true,
			"builtIn": true,
			"visibility": "user-only",
			"defaultForCapabilities": ["deployment"]
		}
	}
}
```

### Implementing the Plugin Class

```typescript
import type {
	IPlugin,
	IDeploymentPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	DeploymentConfig,
	DeploymentResult,
	DeploymentProject,
	ConnectionValidationResult
} from '@ever-works/plugin';

export class NetlifyPlugin implements IPlugin, IDeploymentPlugin {
	readonly id = 'netlify';
	readonly name = 'Netlify';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'deployment';
	readonly capabilities: readonly string[] = ['deployment'];
	readonly providerName = 'netlify';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiToken: {
				type: 'string',
				title: 'Netlify API Token',
				description: 'Your personal Netlify access token',
				'x-secret': true,
				'x-scope': 'user'
			}
		},
		required: ['apiToken']
	};

	// Users must provide their own API token
	readonly configurationMode = 'user-required' as const;

	private context?: PluginContext;

	// ================================================
	// IDeploymentPlugin -- required methods
	// ================================================

	async deploy(config: DeploymentConfig, token: string): Promise<DeploymentResult> {
		// Deploy the site. The config contains:
		// - projectName: the site/project name
		// - sourceDir: path to the built site files
		// - buildCommand: optional build command
		// - outputDir: build output work
		// - env: environment variables for the build
		// - domain: custom domain
		// - options: provider-specific options

		const result = await this.callNetlifyApi('/deploys', {
			method: 'POST',
			token,
			body: {
				/* ... */
			}
		});

		return {
			id: result.id,
			status: 'building',
			url: result.ssl_url,
			createdAt: new Date().toISOString()
		};
	}

	async getDeploymentStatus(deploymentId: string, token: string): Promise<DeploymentResult> {
		const result = await this.callNetlifyApi(`/deploys/${deploymentId}`, {
			method: 'GET',
			token
		});

		return {
			id: result.id,
			status: this.mapNetlifyStatus(result.state),
			url: result.ssl_url,
			createdAt: result.created_at,
			completedAt: result.published_at
		};
	}

	// ================================================
	// IDeploymentPlugin -- optional methods
	// ================================================

	async validateToken(token: string): Promise<boolean> {
		try {
			const response = await fetch('https://api.netlify.com/api/v1/user', {
				headers: { Authorization: `Bearer ${token}` }
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	async getTeams(token: string): Promise<Array<{ id: string; slug: string; name: string | null }>> {
		// Fetch teams/accounts from Netlify API
		return [];
	}

	async lookupExistingDeployment(
		projectName: string,
		token: string,
		teamScope?: string
	): Promise<{
		found: boolean;
		website?: string;
		deploymentState?: string;
		projectId?: string;
	}> {
		// Search for an existing Netlify site matching projectName
		return { found: false };
	}

	async getAuthenticatedUser(token: string): Promise<{ username: string; email?: string } | null> {
		// GET /api/v1/user
		return null;
	}

	// ================================================
	// Connection validation
	// ================================================

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const token = settings.apiToken as string | undefined;
		if (!token) {
			return { success: false, message: 'Enter a Netlify API token.' };
		}
		const valid = await this.validateToken(token);
		if (!valid) {
			return { success: false, message: 'Netlify rejected the API token.' };
		}
		return { success: true, message: 'Netlify connection verified.' };
	}

	// ================================================
	// Plugin lifecycle
	// ================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Netlify Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Netlify plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Deploy works to Netlify',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Your Name' },
			license: 'AGPL-3.0',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			visibility: 'user-only',
			defaultForCapabilities: ['deployment'],
			uiHints: {
				setupLink: {
					url: 'https://app.netlify.com/user/applications#personal-access-tokens',
					label: 'Netlify Tokens',
					buttonLabel: 'Get Netlify API token',
					showWhenEmpty: ['apiToken']
				},
				validateOnSave: true,
				includeInOnboarding: true,
				onboardingPriority: 4,
				completionFields: ['apiToken'],
				onboardingDescription: 'Add a Netlify token to deploy works as live websites.'
			},
			icon: { type: 'lucide', value: 'Globe' }
		};
	}

	// Private helpers

	private mapNetlifyStatus(state: string): DeploymentResult['status'] {
		switch (state) {
			case 'new':
			case 'pending':
				return 'pending';
			case 'building':
				return 'building';
			case 'deploying':
			case 'uploading':
				return 'deploying';
			case 'ready':
				return 'ready';
			case 'error':
				return 'error';
			default:
				return 'pending';
		}
	}

	private async callNetlifyApi(
		path: string,
		options: {
			method: string;
			token: string;
			body?: unknown;
		}
	): Promise<any> {
		// Implementation omitted for brevity
		throw new Error('Not implemented');
	}
}

export default NetlifyPlugin;
```

### The DeploymentConfig and DeploymentResult Types

The `IDeploymentPlugin` interface uses well-defined types for its operations:

```typescript
interface DeploymentConfig {
	readonly projectName: string; // Site/project name
	readonly sourceDir: string; // Work containing built files
	readonly buildCommand?: string; // e.g., "npm run build"
	readonly outputDir?: string; // e.g., "dist" or ".next"
	readonly env?: Record<string, string>;
	readonly domain?: string; // Custom domain
	readonly options?: Record<string, unknown>; // Provider-specific
}

interface DeploymentResult {
	readonly id: string; // Deployment ID from provider
	readonly status: DeploymentStatus; // 'pending' | 'building' | 'deploying' | 'ready' | 'error' | 'cancelled'
	readonly url?: string; // Production URL
	readonly previewUrl?: string; // Preview URL
	readonly error?: string;
	readonly logsUrl?: string;
	readonly createdAt: string;
	readonly completedAt?: string;
}
```

### Domain Management

Deployment plugins can optionally support custom domain management:

```typescript
// Get domains attached to a project
getDomains?(projectId: string, token: string, teamScope?: string): Promise<DeploymentDomain[]>;

// Add a custom domain
addDomain?(projectId: string, domain: string, token: string, teamScope?: string): Promise<AddDomainResult>;

// Remove a domain
removeDomain?(projectId: string, domain: string, token: string, teamScope?: string): Promise<boolean>;

// Verify DNS configuration
verifyDomain?(projectId: string, domain: string, token: string, teamScope?: string): Promise<DeploymentDomain>;
```

The `DeploymentDomain` type includes DNS verification challenges so the UI can guide users through domain setup:

```typescript
interface DeploymentDomain {
	readonly name: string; // e.g., 'example.com'
	readonly verified: boolean;
	readonly verification?: readonly DeploymentDomainVerification[];
}

interface DeploymentDomainVerification {
	readonly type: string; // 'CNAME', 'TXT', 'A'
	readonly domain: string; // DNS record name
	readonly value: string; // DNS record value
	readonly reason: string; // Human-readable explanation
}
```

### Configuration Mode: `user-required` vs. `admin-only`

Deployment plugins typically use `user-required` because each user needs their own API token:

| Mode            | When to Use                                    | Example                                         |
| --------------- | ---------------------------------------------- | ----------------------------------------------- |
| `admin-only`    | OAuth credentials configured at platform level | GitHub plugin (clientId, clientSecret)          |
| `user-required` | Each user must provide their own credentials   | Vercel plugin (apiToken)                        |
| `hybrid`        | Admin provides defaults; users can override    | A plugin with both global and per-user settings |

:::info How the Vercel Plugin Works
The built-in Vercel plugin does not deploy directly via the Vercel SDK. Instead, deployment is orchestrated through GitHub Actions -- the git provider pushes code, then the Vercel GitHub integration or a workflow handles the build. The `deploy()` method returns a pending status, and `lookupExistingDeployment()` checks Vercel's API for the resulting deployment URL.
:::

## OAuth Integration

Git provider plugins can also implement the `IOAuthPlugin` interface to support sign-in via the provider. Add `'oauth'` to the capabilities array and implement the interface:

```typescript
import type { IOAuthPlugin, OAuthConfig, OAuthToken, OAuthUser } from '@ever-works/plugin';

export class GitLabPlugin implements IPlugin, IGitProviderPlugin, IOAuthPlugin {
	readonly capabilities: readonly string[] = ['git-provider', 'oauth'];

	getAuthorizationUrl(state: string, config?: Partial<OAuthConfig>): string {
		const params = new URLSearchParams({
			client_id: config?.clientId || '',
			redirect_uri: config?.redirectUri || '',
			response_type: 'code',
			scope: (config?.scopes || ['read_user', 'api']).join(' '),
			state
		});
		return `https://gitlab.com/oauth/authorize?${params.toString()}`;
	}

	async exchangeCodeForToken(code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken> {
		const response = await fetch('https://gitlab.com/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: config?.clientId,
				client_secret: config?.clientSecret,
				code,
				grant_type: 'authorization_code',
				redirect_uri: config?.redirectUri
			})
		});

		const data = await response.json();
		return {
			accessToken: data.access_token,
			tokenType: data.token_type || 'bearer',
			scope: data.scope,
			expiresIn: data.expires_in,
			refreshToken: data.refresh_token
		};
	}

	async refreshAccessToken(refreshToken: string, config?: Partial<OAuthConfig>): Promise<OAuthToken> {
		// POST to /oauth/token with grant_type=refresh_token
		throw new Error('Not implemented');
	}

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
}
```

:::caution OAuth Settings Scope
OAuth credentials (`clientId`, `clientSecret`) should be marked `'x-adminOnly': true` and configured at the platform level. Individual users never see or provide these values -- they authenticate through the OAuth flow and receive an access token.
:::

## Testing

### Contract Tests

The `@ever-works/plugin/testing` package provides contract test suites that verify your plugin meets the interface requirements:

```typescript
import { describe, it, expect } from 'vitest';
import { testBasePluginContract, testGitProviderContract, testDeploymentContract } from '@ever-works/plugin/testing';
import { GitLabPlugin } from '../gitlab.plugin.js';
import { NetlifyPlugin } from '../netlify.plugin.js';

describe('GitLabPlugin contracts', () => {
	it('passes base plugin contract', async () => {
		const plugin = new GitLabPlugin();
		const results = await testBasePluginContract(plugin);
		for (const result of results) {
			expect(result.passed).toBe(true);
		}
	});

	it('passes git provider contract', async () => {
		const plugin = new GitLabPlugin();
		const results = await testGitProviderContract(plugin);
		for (const result of results) {
			expect(result.passed).toBe(true);
		}
	});
});

describe('NetlifyPlugin contracts', () => {
	it('passes deployment contract', async () => {
		const plugin = new NetlifyPlugin();
		const results = await testDeploymentContract(plugin);
		for (const result of results) {
			expect(result.passed).toBe(true);
		}
	});
});
```

### Unit Tests with Mock Context

Use `createMockPluginContext` to test plugin lifecycle and settings resolution:

```typescript
import { describe, it, expect } from 'vitest';
import { createMockPluginContext } from '@ever-works/plugin/testing';
import { NetlifyPlugin } from '../netlify.plugin.js';

describe('NetlifyPlugin', () => {
	it('loads and unloads cleanly', async () => {
		const plugin = new NetlifyPlugin();
		const context = createMockPluginContext({
			pluginId: 'netlify',
			settings: { apiToken: 'test-token' }
		});

		await plugin.onLoad(context);
		const health = await plugin.healthCheck();
		expect(health.status).toBe('healthy');

		await plugin.onUnload();
	});

	it('validates connection with valid token', async () => {
		const plugin = new NetlifyPlugin();
		const context = createMockPluginContext({ pluginId: 'netlify' });
		await plugin.onLoad(context);

		// Mock the validateToken response in your tests
		const result = await plugin.validateConnection({ apiToken: '' });
		expect(result.success).toBe(false);
	});
});
```

### API Service Tests

Extract provider-specific HTTP calls into a separate service class (like `GitHubApiService` or `VercelApiService`) so you can test API logic independently:

```typescript
describe('NetlifyApiService', () => {
	it('maps deployment status correctly', () => {
		const service = new NetlifyApiService();
		expect(service.mapStatus('ready')).toBe('ready');
		expect(service.mapStatus('building')).toBe('building');
		expect(service.mapStatus('error')).toBe('error');
	});
});
```

## Plugin Checklist

Use this checklist before submitting your deployment or git provider plugin:

### Git Provider Plugin

- [ ] Package created in `packages/plugins/<name>/` with correct structure
- [ ] `package.json` includes `everworks.plugin` metadata with `category: "git-provider"`
- [ ] `capabilities` array includes `"git-provider"` (and `"oauth"` if applicable)
- [ ] `getAuth()` returns the correct authentication format for the provider
- [ ] `getCloneUrl()` and `getWebUrl()` return valid URLs
- [ ] Local git operations delegate to `GitOperations` from `@ever-works/plugin/git`
- [ ] Required remote API methods implemented: `createRepository`, `getRepository`, `deleteRepository`, `getUser`, `getOrganizations`, `listBranches`, `createPullRequest`, `mergePullRequest`
- [ ] Settings schema uses `x-envVar` for credentials that should come from environment
- [ ] Settings schema marks secrets with `x-secret: true`
- [ ] `onLoad()` initializes `GitOperations` with auth and clone URL callbacks
- [ ] `onUnload()` cleans up resources
- [ ] `getManifest()` returns complete metadata including icon
- [ ] Contract tests pass (`testGitProviderContract`)
- [ ] `index.ts` exports the plugin class as default export

### Deployment Plugin

- [ ] Package created in `packages/plugins/<name>/` with correct structure
- [ ] `package.json` includes `everworks.plugin` metadata with `category: "deployment"`
- [ ] `capabilities` array includes `"deployment"`
- [ ] `configurationMode` set appropriately (`user-required` for API token plugins)
- [ ] `deploy()` returns a `DeploymentResult` with at minimum `id`, `status`, and `createdAt`
- [ ] `getDeploymentStatus()` maps provider statuses to the standard `DeploymentStatus` enum
- [ ] `validateToken()` implemented for connection validation
- [ ] `validateConnection()` implemented for the "test connection" UI button
- [ ] `lookupExistingDeployment()` implemented so the platform can find previously deployed sites
- [ ] Settings schema marks API token with `x-secret: true` and `x-scope: 'user'`
- [ ] `uiHints` includes `setupLink` pointing to the provider's token page
- [ ] `uiHints` includes `validateOnSave: true` and `completionFields`
- [ ] Contract tests pass (`testDeploymentContract`)
- [ ] Domain management methods implemented if the provider supports custom domains
- [ ] `index.ts` exports the plugin class as default export

### General

- [ ] `pnpm install` run after adding the package
- [ ] `pnpm build:plugins` passes
- [ ] `vitest run` passes in the plugin work
- [ ] `pnpm type-check` passes
- [ ] Plugin registered in workspace `pnpm-workspace.yaml` if needed
