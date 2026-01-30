# Plugin System - Next Tasks

**Last Updated:** 2026-01-30
**Current Progress:** ~59% (108/183 tasks)

This document outlines the immediate next tasks to advance the plugin system implementation.

---

## Executive Summary

The plugin system has a **solid foundation** but is **blocked** by two missing pieces:

| Blocker                          | Impact   | Tasks Blocked                  |
| -------------------------------- | -------- | ------------------------------ |
| **GitFacade + GitHub plugin**    | Critical | 21+ tasks (10a, frontend, API) |
| **DeployFacade + Vercel plugin** | Critical | 16+ tasks (10a, frontend, API) |

**Creating these two facades and plugins will unblock ~45 tasks** across Phase 6a (entity migration), Phase 7 (API), and Phase 8 (Frontend).

---

## What's Working Well

### Fully Complete (86 tasks)

- Phase 1: Plugin contracts, types, base classes, testing utilities
- Phase 2: Pipeline refactoring with 15 built-in steps
- Phase 9 (partial): Foundation testing infrastructure

### Mostly Complete (22 tasks)

- **5 Facades:** AI, Search, Screenshot, ContentExtractor, DataSource
- **5 Plugins:** Default Pipeline, Tavily, Local Extractor, Notion, Apify
- **Frontend Plugin UI:** Pages, components, actions, GeneratorForm integration

---

## Immediate Priority: Git & Deploy Infrastructure

### Task 1: Create GitHub Plugin Package

**Estimated effort:** 1-2 days
**Unblocks:** GitFacade, Story 5.x, Story 10a.4-10a.5, Story 15.x

**What to do:**

1. Create `packages/plugins/github/` with standard plugin structure
2. Extract `packages/agent/src/git/github.service.ts` to plugin
3. Implement `IGitProviderPlugin` interface
4. Implement `IOAuthPlugin` interface
5. Add settings schema (API token, OAuth credentials)

**Files to reference:**

- Interface: `packages/plugin/src/contracts/capabilities/git-provider.interface.ts`
- Existing service: `packages/agent/src/git/github.service.ts`
- Example plugin: `packages/plugins/tavily-search/`

**Settings Schema:**

```typescript
{
  apiToken: { type: 'string', 'x-secret': true, 'x-envVar': 'GITHUB_TOKEN' },
  appId: { type: 'string' },
  appPrivateKey: { type: 'string', 'x-secret': true },
  clientId: { type: 'string' },
  clientSecret: { type: 'string', 'x-secret': true }
}
```

---

### Task 2: Create GitFacade Service

**Estimated effort:** 0.5-1 day
**Unblocks:** Story 5.2, Story 10.1, Story 10a.4-10a.5, Story 10a.10-10a.11

**What to do:**

1. Create `packages/agent/src/facades/git.facade.ts`
2. Extend `BaseFacadeService` (follow existing patterns)
3. Implement `IGitFacade` interface methods
4. Add to `FacadesModule` exports

**Key methods:**

```typescript
interface IGitFacade {
	// Repository operations
	getRepositories(userId: string): Promise<Repository[]>;
	createRepository(options: CreateRepoOptions): Promise<Repository>;

	// Authentication
	getToken(userId: string, provider?: string): Promise<string | null>;
	getCommitter(userId: string): Promise<GitCommitter>;

	// Pull Request operations
	createPullRequest(options: CreatePROptions): Promise<PullRequest>;
	getPullRequestStatus(prUrl: string): Promise<PRStatus>;

	// OAuth
	getOAuthUrl(provider: string, scopes: string[]): string;
	handleOAuthCallback(code: string, provider: string): Promise<OAuthToken>;
}
```

---

### Task 3: Create Vercel Plugin Package

**Estimated effort:** 1-2 days
**Unblocks:** DeployFacade, Story 6.x, Story 10a.1

**What to do:**

1. Create `packages/plugins/vercel/` with standard plugin structure
2. Extract `packages/agent/src/deploy/vercel.service.ts` to plugin
3. Implement `IDeploymentPlugin` interface
4. Add settings schema (API token)

**Files to reference:**

- Interface: `packages/plugin/src/contracts/capabilities/deployment.interface.ts`
- Existing service: `packages/agent/src/deploy/vercel.service.ts`

**Settings Schema:**

```typescript
{
  apiToken: { type: 'string', 'x-secret': true, 'x-envVar': 'VERCEL_TOKEN' },
  teamId: { type: 'string' },
  defaultProjectSettings: { type: 'object' }
}
```

---

### Task 4: Create DeployFacade Service

**Estimated effort:** 0.5-1 day
**Unblocks:** Story 6.2, Story 10.2, Story 10a.1

**What to do:**

1. Create `packages/agent/src/facades/deploy.facade.ts`
2. Extend `BaseFacadeService`
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
                    │   (Task 1)      │
                    └────────┬────────┘
                             │
                             ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  Vercel Plugin  │   │    GitFacade    │   │  OAuthFacade    │
│   (Task 3)      │   │   (Task 2)      │   │   (Future)      │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │                     │                     │
         ▼                     ▼                     ▼
┌─────────────────┐   ┌─────────────────────────────────────────┐
│  DeployFacade   │   │           Story 10a: Entity Migration   │
│   (Task 4)      │   │  (User.vercelToken, OAuthToken, etc.)   │
└────────┬────────┘   └────────────────────┬────────────────────┘
         │                                 │
         └─────────────┬───────────────────┘
                       ▼
         ┌─────────────────────────────────┐
         │   Frontend Completion           │
         │   (Stories 12, 14, 15, 16)      │
         │   - DeployForm                  │
         │   - RepositorySelector          │
         │   - GitConnectionAlert          │
         │   - OAuthConnections            │
         └─────────────────────────────────┘
                       │
                       ▼
         ┌─────────────────────────────────┐
         │   API Refactoring (Story 11)    │
         │   - Generic /deploy/:provider   │
         │   - Plugin-based OAuth          │
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

| Task                   | Effort       | Dependencies         |
| ---------------------- | ------------ | -------------------- |
| GitHub Plugin          | 1-2 days     | None                 |
| GitFacade              | 0.5-1 day    | GitHub Plugin        |
| Vercel Plugin          | 1-2 days     | None                 |
| DeployFacade           | 0.5-1 day    | Vercel Plugin        |
| **Total for blockers** | **3-6 days** |                      |
| OpenAI Plugin          | 1 day        | None (non-blocking)  |
| Anthropic Plugin       | 1 day        | None (non-blocking)  |
| Story 10a Migrations   | 2-3 days     | Git + Deploy facades |
| Frontend completion    | 2-3 days     | Story 10a            |
| API refactoring        | 3-5 days     | Frontend completion  |

**Estimated time to unblock everything: ~2-3 weeks of focused work**
