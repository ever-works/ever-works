# Plugin System - Next Tasks

**Last Updated:** 2026-02-05
**Current Progress:** ~75% (137/183 tasks)

This document outlines the immediate next tasks to advance the plugin system implementation.

---

## Executive Summary

The plugin system has made significant progress. All key blockers have been resolved:

| Completed                         | Status  | Tasks Unblocked                |
| --------------------------------- | ------- | ------------------------------ |
| **GitFacade + GitHub plugin**     | ✅ Done | 21+ tasks (10a, frontend, API) |
| **Git Provider OAuth separation** | ✅ Done | OAuth flow via plugin system   |
| **DeployFacade + Vercel plugin**  | ✅ Done | 16+ tasks (10a, frontend, API) |

**All infrastructure blockers are now resolved.** The remaining work is entity migration (Story 10a), frontend completion, and API refactoring.

---

## What's Working Well

### Fully Complete (137 tasks)

- Phase 1: Plugin contracts, types, base classes, testing utilities
- Phase 2: Pipeline refactoring with 15 built-in steps
- Phase 9 (partial): Foundation testing infrastructure
- **GitFacade:** Complete with OAuth support via plugin system
- **GitHub Plugin:** Full IGitProviderPlugin + IOAuthPlugin implementation
- **DeployFacade:** Complete with plugin-based provider resolution
- **Vercel Plugin:** Full IDeploymentPlugin implementation

### Mostly Complete (22 tasks)

- **7 Facades:** AI, Search, Screenshot, ContentExtractor, DataSource, **Git**, **Deploy**
- **7 Plugins:** Default Pipeline, Tavily, Local Extractor, Notion, Apify, **GitHub**, **Vercel**
- **Frontend Plugin UI:** Pages, components, actions, GeneratorForm integration
- **Git Provider OAuth:** Separate callback route from auth OAuth, plugin-based OAuth flow
- **Deploy Provider Selection:** Frontend components for directory creation and settings

---

## Completed: Deploy Infrastructure

### ✅ Task 1: Create GitHub Plugin Package - COMPLETED

**Status:** ✅ Done (2026-02-02)
**Location:** `packages/plugins/github/`

**What was implemented:**

- Full `IGitProviderPlugin` interface implementation
- Full `IOAuthPlugin` interface implementation
- Settings schema with `x-envVar` annotations for `GH_CLIENT_ID`, `GH_CLIENT_SECRET`
- `GitHubApiService` using Octokit for all API operations
- `GitHubActionsService` for workflow and secrets management
- Support for GitHub Enterprise via configurable `apiBaseUrl`

---

### ✅ Task 2: Create GitFacade Service - COMPLETED

**Status:** ✅ Done (2026-02-02)
**Location:** `packages/agent/src/facades/git.facade.ts`

**What was implemented:**

- Full facade with token resolution from OAuthTokenRepository
- OAuth methods: `getOAuthUrl()`, `exchangeCodeForToken()`, `getOAuthUser()`
- Repository operations: list, create, delete, update, fork
- Branch operations: list, create, delete
- Pull request operations: create, get, merge
- Local git operations: clone, pull, add, commit, push
- Provider resolution with directory/user/default fallback

**OAuth Flow:**

- Separated from authentication OAuth (login)
- New endpoint: `/api/git-providers/:providerId/callback`
- New frontend route: `/api/git-providers/[providerId]/callback`
- Plugin-based OAuth via `IOAuthPlugin` interface

---

### ✅ Task 3: Create Vercel Plugin Package - COMPLETED

**Status:** ✅ Done (2026-02-05)
**Location:** `packages/plugins/vercel/`

**What was implemented:**

- Full `IDeploymentPlugin` interface implementation
- `VercelApiService` using `@vercel/sdk` for all API operations
- Settings schema with `user-required` configuration mode (no env var fallback)
- Token validation, team retrieval, project listing, deployment lookup
- Support for personal accounts and team scopes
- 33 unit tests passing

**Settings Schema:**

```typescript
{
    apiToken: { type: 'string', 'x-secret': true, 'x-masked': true, 'x-writeOnly': true },
    defaultTeamScope: { type: 'string' }
}
```

**Key Features:**

- `autoEnable: true` - plugin is enabled by default for all users
- `configurationMode: 'user-required'` - users must provide their own API token
- Methods: `deploy`, `getDeploymentStatus`, `validateToken`, `getTeams`, `lookupExistingDeployment`, `getAuthenticatedUser`, `listProjects`, `getProject`

---

### ✅ Task 4: Create DeployFacade Service - COMPLETED

**Status:** ✅ Done (2026-02-05)
**Location:** `packages/agent/src/facades/deploy.facade.ts`

**What was implemented:**

- Full facade with plugin resolution from PluginRegistry
- Token retrieval from user's plugin settings
- Provider resolution based on `directory.deployProvider` field
- Integration with GitFacade for repository operations
- Custom error classes: `DeployFacadeError`, `NoDeployProviderError`, `DeployProviderNotFoundError`, `NoDeployCredentialsError`

**Key methods:**

```typescript
interface DeployFacadeService {
	// Configuration
	isConfigured(userId: string, providerId?: string): Promise<boolean>;
	getAvailableProviders(): { id: string; name: string }[];

	// Token management
	validateToken(userId: string, token: string, providerId?: string): Promise<boolean>;
	getTeams(userId: string, providerId?: string): Promise<DeploymentTeam[]>;
	getDeployToken(userId: string, providerId?: string): Promise<string | null>;

	// Deployment operations
	deploy(userId: string, directoryId: string, options: DeployOptions): Promise<DeploymentResult>;
	getDeploymentStatus(userId: string, deploymentId: string): Promise<DeploymentStatus>;
	lookupExistingDeployment(userId: string, directoryId: string): Promise<ExistingDeployment | null>;

	// Provider management
	getDirectoryProvider(directoryId: string): Promise<string>;
	setDirectoryProvider(directoryId: string, providerId: string): Promise<void>;
}
```

**API Integration:**

- `DeployController` at `apps/api/src/plugins-capabilities/deploy/`
- Endpoints: `GET /providers`, `POST /directories/:id`, `POST /validate-token`, `POST /teams`, etc.
- `DeploymentVerifierService` for monitoring deployment status via polling

**Frontend Integration:**

- `DeployProviderSelector` component for directory creation
- `DeployProviderSettings` component for directory settings
- `deployAPI` client in `apps/web/src/lib/api/deploy.ts`

---

## Current Priority: Entity Migration (Story 10a)

Now that GitFacade and DeployFacade are complete, execute these migrations:

### User Entity Migrations

```typescript
// FROM (User entity)
vercelToken: string;
oauthTokens: OAuthToken[];

// TO (UserPlugin settings)
'vercel': { apiToken: '...' }
'github': { accessToken: '...', refreshToken: '...' }
```

### Directory Entity Migrations

```typescript
// FROM (Directory entity)
repoProvider: string;
sourceRepository: SourceRepository;
lastPullRequest: PRUpdate;

// TO (DirectoryPlugin settings)
'github': { activeCapability: 'git-provider', ... }
```

### Method Refactoring

```typescript
// FROM
User.getGitToken() → GitFacade.getToken(userId)
User.asCommitter() → GitFacade.getCommitter(userId)
Directory.getRepoOwner() → GitFacade.getRepoOwner(directoryId)
```

---

## Secondary Priority: AI Provider Plugins

### Task 5: Create OpenAI Plugin Package

**Estimated effort:** 1 day
**Impact:** Non-blocking but enables full plugin-based AI routing

**What to do:**

1. Create `packages/plugins/openai/`
2. Implement `IAiProviderPlugin` interface
3. Use existing LangChain OpenAI integration
4. Add model routing support

---

### Task 6: Create Anthropic Plugin Package

**Estimated effort:** 1 day

**What to do:**

1. Create `packages/plugins/anthropic/`
2. Implement `IAiProviderPlugin` interface
3. Use existing LangChain Anthropic integration

---

## Dependency Graph

```
                    ┌─────────────────┐
                    │  GitHub Plugin  │
                    │   ✅ DONE       │
                    └────────┬────────┘
                             │
                             ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  Vercel Plugin  │   │    GitFacade    │   │  Git OAuth API  │
│   ✅ DONE       │   │   ✅ DONE       │   │   ✅ DONE       │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │                     │                     │
         ▼                     ▼                     ▼
┌─────────────────┐   ┌─────────────────────────────────────────┐
│  DeployFacade   │   │           Story 10a: Entity Migration   │
│   ✅ DONE       │──▶│           🟡 READY TO START             │
└────────┬────────┘   └────────────────────┬────────────────────┘
         │                                 │
         ▼                                 ▼
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│   Frontend Deploy Components    │   │   API Refactoring (Story 11)    │
│   ✅ DONE                       │   │   - Generic /deploy/:provider   │
│   - DeployProviderSelector      │   │   - Plugin-based OAuth ✅ Git   │
│   - DeployProviderSettings      │   │   - Remove hardcoded providers  │
│   - RepositorySelector ✅       │   └─────────────────────────────────┘
│   - GitConnectionAlert ✅       │
└─────────────────────────────────┘
```

---

## Quick Reference: Existing Patterns

### Plugin Package Structure

```
packages/plugins/{plugin-name}/
├── src/
│   ├── {plugin-name}.plugin.ts   # Main plugin class
│   ├── {service}.ts              # Supporting services (optional)
│   └── index.ts                  # Exports
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

### Plugin Class Template

```typescript
import type { IPlugin, PluginContext, PluginManifest } from '@ever-works/plugin';

export class MyPlugin implements IPlugin {
	readonly id = 'my-plugin';
	readonly name = 'My Plugin';
	readonly version = '1.0.0';
	readonly category = 'git-provider'; // or deployment, ai-provider, etc.
	readonly capabilities = ['git-provider', 'oauth'];

	readonly settingsSchema = {
		/* JSON Schema */
	};

	async onLoad(context: PluginContext): Promise<void> {}
	async onEnable(context: PluginContext): Promise<void> {}
	async onDisable(context: PluginContext): Promise<void> {}
	async onUnload(): Promise<void> {}

	getManifest(): PluginManifest {
		return { id: this.id, name: this.name /* ... */ };
	}
}
```

### Facade Service Template

```typescript
import { Injectable, Logger, Optional } from '@nestjs/common';
import { BaseFacadeService } from './base.facade';

@Injectable()
export class MyFacadeService extends BaseFacadeService implements IMyFacade {
	protected readonly logger = new Logger(MyFacadeService.name);
	protected readonly CAPABILITY = 'my-capability';

	constructor(
		registry: PluginRegistryService,
		settingsService: PluginSettingsService,
		@Optional() directoryPluginRepository?: DirectoryPluginRepository,
		@Optional() userPluginRepository?: UserPluginRepository
	) {
		super(registry, settingsService, directoryPluginRepository, userPluginRepository);
	}

	// Implement facade methods...
}
```

---

## Files to Reference

| Reference                    | Location                                                               |
| ---------------------------- | ---------------------------------------------------------------------- |
| IGitProviderPlugin interface | `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` |
| IDeploymentPlugin interface  | `packages/plugin/src/contracts/capabilities/deployment.interface.ts`   |
| GitHub Plugin                | `packages/plugins/github/`                                             |
| Vercel Plugin                | `packages/plugins/vercel/`                                             |
| GitFacade                    | `packages/agent/src/facades/git.facade.ts`                             |
| DeployFacade                 | `packages/agent/src/facades/deploy.facade.ts`                          |
| BaseFacadeService            | `packages/agent/src/facades/base.facade.ts`                            |
| Example plugin (Tavily)      | `packages/plugins/tavily-search/src/tavily-search.plugin.ts`           |
| Example facade (AI)          | `packages/agent/src/facades/ai.facade.ts`                              |
| Plugin entities              | `packages/agent/src/plugins/entities/`                                 |
| User entity                  | `packages/agent/src/entities/user.entity.ts`                           |

---

## Estimated Timeline

| Task                 | Effort    | Status     | Dependencies        |
| -------------------- | --------- | ---------- | ------------------- |
| GitHub Plugin        | 1-2 days  | ✅ Done    | None                |
| GitFacade            | 0.5-1 day | ✅ Done    | GitHub Plugin       |
| Git OAuth Separation | 0.5 day   | ✅ Done    | GitFacade           |
| Vercel Plugin        | 1-2 days  | ✅ Done    | None                |
| DeployFacade         | 0.5-1 day | ✅ Done    | Vercel Plugin       |
| Deploy Frontend      | 0.5 day   | ✅ Done    | DeployFacade        |
| OpenAI Plugin        | 1 day     | Optional   | None (non-blocking) |
| Anthropic Plugin     | 1 day     | Optional   | None (non-blocking) |
| Story 10a Migrations | 2-3 days  | 🟡 Ready   | All facades done    |
| Frontend completion  | 2-3 days  | 🟡 Partial | Story 10a           |
| API refactoring      | 3-5 days  | 🟡 Partial | Frontend completion |

**All infrastructure blockers resolved. Remaining work: ~1 week of focused effort.**
