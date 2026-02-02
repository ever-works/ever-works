# Plugin System - Next Tasks

**Last Updated:** 2026-02-02
**Current Progress:** ~65% (119/183 tasks)

This document outlines the immediate next tasks to advance the plugin system implementation.

---

## Executive Summary

The plugin system has made significant progress. Key blockers have been resolved:

| Completed                         | Status     | Tasks Unblocked                |
| --------------------------------- | ---------- | ------------------------------ |
| **GitFacade + GitHub plugin**     | ✅ Done    | 21+ tasks (10a, frontend, API) |
| **Git Provider OAuth separation** | ✅ Done    | OAuth flow via plugin system   |
| **DeployFacade + Vercel plugin**  | 🔴 Pending | 16+ tasks (10a, frontend, API) |

**The DeployFacade and Vercel plugin are the remaining blockers** for ~20 tasks across Phase 6a (entity migration), Phase 7 (API), and Phase 8 (Frontend).

---

## What's Working Well

### Fully Complete (97 tasks)

- Phase 1: Plugin contracts, types, base classes, testing utilities
- Phase 2: Pipeline refactoring with 15 built-in steps
- Phase 9 (partial): Foundation testing infrastructure
- **GitFacade:** Complete with OAuth support via plugin system
- **GitHub Plugin:** Full IGitProviderPlugin + IOAuthPlugin implementation

### Mostly Complete (22 tasks)

- **6 Facades:** AI, Search, Screenshot, ContentExtractor, DataSource, **Git**
- **6 Plugins:** Default Pipeline, Tavily, Local Extractor, Notion, Apify, **GitHub**
- **Frontend Plugin UI:** Pages, components, actions, GeneratorForm integration
- **Git Provider OAuth:** Separate callback route from auth OAuth, plugin-based OAuth flow

---

## Immediate Priority: Deploy Infrastructure

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

### Task 3: Create Vercel Plugin Package - PRIORITY

**Estimated effort:** 1-2 days
**Unblocks:** DeployFacade, Story 6.x, Story 10a.1
**Status:** 🔴 Pending

**What to do:**

1. Create `packages/plugins/vercel/` with standard plugin structure
2. Extract `packages/agent/src/deploy/vercel.service.ts` to plugin
3. Implement `IDeploymentPlugin` interface
4. Add settings schema (API token)

**Files to reference:**

- Interface: `packages/plugin/src/contracts/capabilities/deployment.interface.ts`
- Existing service: `packages/agent/src/deploy/vercel.service.ts`
- GitHub plugin (example): `packages/plugins/github/`

**Settings Schema:**

```typescript
{
  apiToken: { type: 'string', 'x-secret': true, 'x-envVar': 'VERCEL_TOKEN' },
  teamId: { type: 'string', 'x-envVar': 'VERCEL_TEAM_ID' },
  defaultProjectSettings: { type: 'object' }
}
```

---

### Task 4: Create DeployFacade Service - PRIORITY

**Estimated effort:** 0.5-1 day
**Unblocks:** Story 6.2, Story 10.2, Story 10a.1
**Status:** 🔴 Pending

**What to do:**

1. Create `packages/agent/src/facades/deploy.facade.ts`
2. Follow GitFacade patterns for plugin resolution
3. Implement `IDeployFacade` interface methods
4. Add to `FacadesModule` exports

**Key methods:**

```typescript
interface IDeployFacade {
	// Deployment operations
	deploy(options: DeployOptions): Promise<Deployment>;
	getDeploymentStatus(deploymentId: string): Promise<DeploymentStatus>;
	cancelDeployment(deploymentId: string): Promise<void>;

	// Project management
	getProjects(userId: string): Promise<Project[]>;
	createProject(options: CreateProjectOptions): Promise<Project>;

	// Domain management
	getDomains(projectId: string): Promise<Domain[]>;
	addDomain(projectId: string, domain: string): Promise<Domain>;
}
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

## After Git/Deploy Facades: Entity Migration (Story 10a)

Once GitFacade and DeployFacade exist, execute these migrations:

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
│   (Task 3)      │   │   ✅ DONE       │   │   ✅ DONE       │
│   🔴 PENDING    │   └────────┬────────┘   └────────┬────────┘
└────────┬────────┘            │                     │
         │                     ▼                     ▼
         │            ┌─────────────────────────────────────────┐
         │            │           Story 10a: Entity Migration   │
         │            │  (Git operations ready, need deploy)    │
         │            └────────────────────┬────────────────────┘
         │                                 │
         ▼                                 │
┌─────────────────┐                        │
│  DeployFacade   │                        │
│   (Task 4)      │────────────────────────┘
│   🔴 PENDING    │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│   Frontend Completion           │
│   (Stories 12, 14, 15, 16)      │
│   - DeployForm                  │
│   - RepositorySelector ✅       │
│   - GitConnectionAlert ✅       │
│   - OAuthConnections            │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│   API Refactoring (Story 11)    │
│   - Generic /deploy/:provider   │
│   - Plugin-based OAuth ✅ Git   │
│   - Remove hardcoded providers  │
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
└── tsconfig.json
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
| Existing GitHub service      | `packages/agent/src/git/github.service.ts`                             |
| Existing Vercel service      | `packages/agent/src/deploy/vercel.service.ts`                          |
| BaseFacadeService            | `packages/agent/src/facades/base.facade.ts`                            |
| Example plugin (Tavily)      | `packages/plugins/tavily-search/src/tavily-search.plugin.ts`           |
| Example facade (AI)          | `packages/agent/src/facades/ai.facade.ts`                              |
| Plugin entities              | `packages/agent/src/plugins/entities/`                                 |
| User entity                  | `packages/agent/src/entities/user.entity.ts`                           |

---

## Estimated Timeline

| Task                 | Effort         | Status           | Dependencies        |
| -------------------- | -------------- | ---------------- | ------------------- |
| GitHub Plugin        | 1-2 days       | ✅ Done          | None                |
| GitFacade            | 0.5-1 day      | ✅ Done          | GitHub Plugin       |
| Git OAuth Separation | 0.5 day        | ✅ Done          | GitFacade           |
| Vercel Plugin        | 1-2 days       | 🔴 Pending       | None                |
| DeployFacade         | 0.5-1 day      | 🔴 Pending       | Vercel Plugin       |
| **Total remaining**  | **1.5-3 days** |                  |                     |
| OpenAI Plugin        | 1 day          | Optional         | None (non-blocking) |
| Anthropic Plugin     | 1 day          | Optional         | None (non-blocking) |
| Story 10a Migrations | 2-3 days       | 🟡 Partial ready | Deploy facade       |
| Frontend completion  | 2-3 days       | 🟡 Partial done  | Story 10a           |
| API refactoring      | 3-5 days       | 🟡 Partial done  | Frontend completion |

**Estimated time to unblock everything: ~1-2 weeks of focused work**
