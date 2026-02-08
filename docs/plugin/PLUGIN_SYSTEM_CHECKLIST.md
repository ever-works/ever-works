# Ever Works Plugin System - Implementation Checklist

This checklist tracks the implementation progress of the Plugin System as defined in [PLUGIN_SYSTEM_JIRA_TICKETS.md](./PLUGIN_SYSTEM_JIRA_TICKETS.md).

**Total Tasks:** 178 across 19 Stories

**Note:** The package is named `@ever-works/plugin` (not `plugin-contracts` as originally planned) to reflect its expanded scope including base classes, helpers, and testing utilities.

---

## Progress Summary

| Phase                         | Status         | Progress | Notes                                        |
| ----------------------------- | -------------- | -------- | -------------------------------------------- |
| Phase 1: Foundation           | ✅ COMPLETE    | 40/40    | Stories 1-2 fully implemented                |
| Phase 2: Pipeline             | ✅ COMPLETE    | 23/23    | Story 3 fully implemented                    |
| Phase 3: Module Decoupling    | 🟡 IN PROGRESS | 3/16     | Stories 7-8 partial; 5-6 not started         |
| Phase 4: Built-in Plugins     | 🟡 IN PROGRESS | 6/14     | 5 plugins created + workspace setup          |
| Phase 5: Data Sources         | 🟡 IN PROGRESS | 1/3      | DataSourceFacade complete                    |
| Phase 6: Service Facades      | 🟡 IN PROGRESS | 7/10     | 5 facades + base; Git, Deploy, OAuth missing |
| Phase 6a: Hardcoded Migration | ❌ BLOCKED     | 0/13     | Blocked by Git/Deploy facades                |
| Phase 7: API Refactoring      | ❌ NOT STARTED | 0/13     | Blocked by Git/Deploy plugins                |
| Phase 8: Frontend             | 🟡 IN PROGRESS | 19/36    | Plugin UI complete; Git/Deploy blocked       |
| Phase 9: Testing & CI         | 🟡 IN PROGRESS | 9/15     | Foundation tests complete                    |

**Overall Progress:** ~108/183 tasks (~59%)

**Key Insight:** Frontend plugin UI is largely complete! The remaining frontend tasks (12.1-12.3, 13.2, 14.1-14.2, 15.x, 16.1-16.2) are all blocked by missing GitFacade and DeployFacade backends.

---

## Phase 1: Foundation

### Story 1: Plugin Package (28 tasks) ✅ COMPLETE

Create `packages/plugin` containing all TypeScript interfaces, types, base classes, and testing utilities.

**⚠️ TYPE SAFETY IS CRITICAL:** All interfaces must be strongly typed. Step IDs, data keys, and step results use union types and mapped interfaces for compile-time validation.

- [x] **1.1** Set up plugin package structure
- [x] **1.2** Define base IPlugin interface (includes `configurationMode` for admin/user/hybrid settings)
- [x] **1.3** Define PluginContext interface (**TYPE-SAFE:** typed events with `PluginEventName` and `PluginEventPayloads`)
- [x] **1.4** Define IGitProviderPlugin capability interface (includes API operations: createRepository, createPullRequest, etc.)
- [x] **1.5** Define IDeploymentPlugin capability interface
- [x] **1.6** Define IScreenshotPlugin capability interface
- [x] **1.7** Define ISearchPlugin capability interface
- [x] **1.8** Define IContentExtractorPlugin capability interface
- [x] **1.9** Define IDataSourcePlugin capability interface
- [x] **1.10** Define IAiProviderPlugin interface (includes `askJson`, `getCapabilities`, `healthCheck`)
- [x] **1.11** Define IPipelineStepPlugin capability interface (**TYPE-SAFE:** uses `BuiltInStepId`, `StepDataKey`, `StepDataTypes`)
- [x] **1.12** Define IFullPipelinePlugin capability interface
- [x] **1.13** Define IFormFieldPlugin capability interface
- [x] **1.14** Define IOAuthPlugin capability interface for OAuth (separate from git-provider)
- [x] **1.15** Define ICustomCapabilityRegistry interface for plugin-to-plugin communication
- [x] **1.16** Define CapabilityMetadata and related types
- [x] **1.17** Define common types for settings, validation, and pipeline (includes `step-types.ts`)
- [x] **1.18** Create clean export index for all interfaces (exports `step-types.ts`)
- [x] **1.19** Define ISubProviderPlugin interface for multi-capability plugins
- [x] **1.20** Define IConfigAwarePlugin interface for ConfigDto field handling
- [x] **1.21** Define PluginSubProvider and SubProviderOption types
- [x] **1.22** Define PluginIcon type with multiple format support
- [x] **1.23** Define PipelineStepDefinition interface (**TYPE-SAFE:** typed `id`, `dependencies`, `provides`)
- [x] **1.24** Define StepPosition union type (**TYPE-SAFE:** `stepId` must be `BuiltInStepId`)
- [x] **1.25** Define ParallelGroup interface for concurrent step execution
- [x] **1.26** Define ExecutablePipeline interface for compiled pipelines
- [x] **1.27** Define step-types.ts with `BuiltInStepId`, `StepDataKey`, `StepDataTypes` types
- [x] **1.28** Define event-types.ts with `PluginEventName` and `PluginEventPayloads` types

**Additional Deliverables (beyond original scope):**

- [x] Abstract base classes: `BasePlugin`, `BaseGitProvider`, `BaseAiProvider`, `BasePipelineStep`
- [x] Helper utilities: settings resolver, validation helpers, context helpers
- [x] Testing utilities: mock context, mock environment, test harness, contract tests
- [x] `IGitOperations` interface for local git operations (clone, push, commit - shared by all providers)

### Story 2: Plugin System Runtime (12 tasks) ✅ COMPLETE

Create the plugin runtime system in `packages/agent` for discovery, loading, and lifecycle management.

- [x] **2.1** Create PluginRegistry service
- [x] **2.2** Create PluginLoader service for discovery and loading
- [x] **2.3** Create PluginManifestValidator service
- [x] **2.4** Create PluginVersionChecker service
- [x] **2.5** Create PluginClassValidator service
- [x] **2.6** Create PluginLifecycleManager service
- [x] **2.7** Create PluginSettingsService with 4-level hierarchy (Plugin → Admin → User → Directory)
- [x] **2.8** Create PluginContextFactory service
- [x] **2.9** Create CustomCapabilityRegistryService
- [x] **2.10** Create TypeORM entities (Plugin, AdminPlugin, UserPlugin, DirectoryPlugin)
- [x] **2.11** Create PluginsModule with forRoot configuration
- [x] **2.12** Add @ever-works/plugin as dependency

---

## Phase 2: Pipeline

### Story 3: Pipeline Refactoring (23 tasks) ✅ COMPLETE

Refactor the pipeline to be fully plugin-driven with step injection support.

**⚠️ TYPE SAFETY:** Pipeline must use typed step IDs (`BuiltInStepId`), data keys (`StepDataKey`), and result types (`StepDataTypes`).

**Implementation files:**

- `packages/agent/src/pipeline/generation-context.ts` - TypedGenerationContext
- `packages/agent/src/pipeline/built-in-steps.ts` - BUILT_IN_STEPS array
- `packages/agent/src/pipeline/default-pipeline.plugin.ts` - DefaultPipelinePlugin
- `packages/agent/src/pipeline/pipeline-builder.service.ts` - PipelineBuilderService
- `packages/agent/src/pipeline/step-adapter.service.ts` - StepAdapterService
- `packages/agent/src/pipeline/executable-pipeline.class.ts` - ExecutablePipelineRunner
- `packages/agent/src/pipeline/step-pipeline-executor.service.ts` - StepPipelineExecutorService
- `packages/agent/src/pipeline/full-pipeline-executor.service.ts` - FullPipelineExecutorService
- `packages/agent/src/pipeline/pipeline-orchestrator.service.ts` - PipelineOrchestratorService
- `packages/agent/src/pipeline/provider-override.service.ts` - ProviderOverrideService

- [x] **3.1** Refactor GenerationContext for dependency-based data flow (**TYPE-SAFE:** generic `getStepResult<K>()`)
- [x] **3.2** Define BUILT_IN_STEPS array with explicit dependencies (**TYPE-SAFE:** uses step-types.ts)
- [x] **3.3** Create default pipeline plugin wrapping built-in steps (systemPlugin: true, hidden from UI)
- [x] **3.4** Create PipelineBuilderService for pipeline compilation
- [x] **3.5** Implement step replacement in PipelineBuilderService
- [x] **3.6** Implement step injection in PipelineBuilderService
- [x] **3.7** Implement step disabling in PipelineBuilderService
- [x] **3.8** Implement append/prepend positioning
- [x] **3.9** Implement topological sort for step ordering
- [x] **3.10** Identify steps that can run in parallel
- [x] **3.11** Apply provider overrides to category steps (ProviderOverrideService)
- [x] **3.12** Create ExecutablePipeline class (ExecutablePipelineRunner)
- [x] **3.13** Create StepPipelineExecutor (StepPipelineExecutorService)
- [x] **3.14** Create FullPipelineExecutor (FullPipelineExecutorService)
- [x] **3.15** Check providers.pipeline for full vs step-based execution (PipelineOrchestratorService)
- [x] **3.16** Skip steps when previous step already provided data
- [x] **3.17** Track per-step execution metrics
- [x] **3.18** Save context after each step (checkpoint saving)
- [x] **3.19** Add pipeline event hooks (beforePipeline, afterStep, onStepError, afterPipeline)
- [x] **3.20** Map step IDs to executors
- [x] **3.21** Validate step dependencies before execution
- [x] **3.22** Detect circular dependencies in step graph
- [x] **3.23** Create step adapter for existing services (StepAdapterService)

---

## Phase 3: Module Decoupling

### Story 5: Git Module Decoupling (5 tasks)

Abstract git operations behind IGitProviderPlugin interface.

- [ ] **5.1** Move github.service.ts to GitHub plugin (extract)
- [ ] **5.2** Create GitService Facade using plugin registry
- [ ] **5.3** Abstract workflow triggers (remove hardcoded GitHub Actions references)
- [ ] **5.4** Implement GitLab plugin
- [ ] **5.5** Update BranchSyncService to use Git facade

### Story 6: Deploy Module Decoupling (4 tasks)

Abstract deployment operations behind IDeploymentPlugin interface.

- [ ] **6.1** Move vercel.service.ts to Vercel plugin (extract)
- [ ] **6.2** Create DeployService Facade using plugin registry
- [ ] **6.3** Abstract deployment triggers (remove hardcoded GitHub Actions dispatch)
- [ ] **6.4** Update BatchDeployService to use Deploy facade

### Story 7: Screenshot Module Decoupling (3 tasks) 🟡 IN PROGRESS

Abstract screenshot operations behind IScreenshotPlugin interface.

- [ ] **7.1** Move screenshot-one.service.ts to plugin (extract)
- [x] **7.2** Create ScreenshotService Facade using plugin registry _(implemented: `packages/agent/src/facades/screenshot.facade.ts`)_
- [ ] **7.3** Update SmartImageRouter to use Screenshot facade

### Story 8: AI Module Decoupling (4 tasks) 🟡 IN PROGRESS

Decouple AI module and fix provider instantiation.

- [ ] **8.1** Fix provider switch (use correct LLM classes per provider)
- [ ] **8.2** Extract AI providers to plugin packages
- [x] **8.3** Create AiService Facade using plugin registry _(implemented: `packages/agent/src/facades/ai.facade.ts` with model routing, cost calculation)_
- [ ] **8.4** Implement proper provider factory pattern

---

## Phase 4: Built-in Plugins

### Story 4: Built-in Plugins Package (12 tasks) 🟡 IN PROGRESS

Create `packages/plugins/` with all built-in plugins as full packages.

- [x] **4.1** Set up packages/plugins workspace structure _(5 plugins created)_
- [ ] **4.2** Create GitHub plugin package (IGitProviderPlugin + IOAuthPlugin)
- [ ] **4.3** Create GitLab plugin package (IGitProviderPlugin + IOAuthPlugin)
- [ ] **4.4** Create Vercel plugin package (IDeploymentPlugin)
- [ ] **4.5** Create Netlify plugin package (IDeploymentPlugin)
- [ ] **4.6** Create ScreenshotOne plugin package (IScreenshotPlugin)
- [x] **4.7** Create Tavily plugin package (ISearchPlugin + IContentExtractorPlugin) _(implemented: `packages/plugins/tavily/`)_
- [ ] **4.8** Create Exa.ai plugin package (IFullPipelinePlugin + ISearchPlugin)
- [ ] **4.9** Create OpenAI plugin package (IAiProviderPlugin)
- [ ] **4.10** Create Anthropic plugin package (IAiProviderPlugin)
- [x] **4.11** Create Notion plugin package (IContentExtractorPlugin) _(implemented: `packages/plugins/notion-extractor/`)_
- [x] **4.12** Create Apify plugin package (IDataSourcePlugin) _(implemented: `packages/plugins/apify/`)_

**Additional plugins created (beyond original scope):**

- [x] **4.13** Create Default Pipeline plugin (IPipelineStepPlugin) _(system plugin: `packages/plugins/default-pipeline/`)_
- [x] **4.14** Create Local Content Extractor plugin (IContentExtractorPlugin) _(fallback: `packages/plugins/local-content-extractor/`)_

---

## Phase 5: Data Sources

### Story 9: Data Source Plugins (3 tasks) 🟡 IN PROGRESS

Create the data source abstraction and extract existing importers.

- [ ] **9.1** Move Awesome Readme parser to plugin (extract)
- [x] **9.2** Create DataSource Facade using plugin registry _(implemented: `packages/agent/src/facades/data-source.facade.ts`)_
- [ ] **9.3** Update import services to use DataSource facade

---

## Phase 6: Service Facades

### Story 10: Service Facades (7 tasks) 🟡 IN PROGRESS

Create thin facade services in packages/agent wrapping plugin registry calls.

- [ ] **10.1** Create GitFacade service _(CRITICAL: blocks Story 10a)_
- [ ] **10.2** Create DeployFacade service _(CRITICAL: blocks Story 10a)_
- [x] **10.3** Create ScreenshotFacade service _(implemented: `packages/agent/src/facades/screenshot.facade.ts`)_
- [x] **10.4** Create SearchFacade service _(implemented: `packages/agent/src/facades/search.facade.ts`)_
- [x] **10.5** Create AiFacade service with model routing _(implemented: `packages/agent/src/facades/ai.facade.ts`)_
- [ ] **10.6** Create OAuthFacade service
- [ ] **10.7** Update all agent consumers to use facades

**Additional facades created (beyond original scope):**

- [x] **10.8** Create ContentExtractorFacade service _(implemented: `packages/agent/src/facades/content-extractor.facade.ts`)_
- [x] **10.9** Create DataSourceFacade service _(implemented: `packages/agent/src/facades/data-source.facade.ts`)_
- [x] **10.10** Create BaseFacadeService _(shared 3-level enable resolution: `packages/agent/src/facades/base.facade.ts`)_

### Story 10a: Migrate Hardcoded Infrastructure to Plugin System (13 tasks)

Migrate hardcoded entity fields to the plugin system. See [PLUGIN_SYSTEM_RFC.md - Migration from Hardcoded Infrastructure](./PLUGIN_SYSTEM_RFC.md#migration-from-hardcoded-infrastructure) for details.

**User Entity Migrations:**

- [ ] **10a.1** Migrate `User.vercelToken` to `UserPlugin.settings` (vercel plugin)
- [ ] **10a.2** Migrate `User.screenshotoneAccessKey` to `UserPlugin.settings` (screenshotone plugin)
- [ ] **10a.3** Migrate `User.screenshotoneSecretKey` to `UserPlugin.settings` (screenshotone plugin)

**OAuthToken Entity Migration:**

- [ ] **10a.4** Migrate `OAuthToken` entity to `UserPlugin.settings` for git providers (github, gitlab, bitbucket)
- [ ] **10a.5** Remove `User.oauthTokens[]` relationship after migration

**Directory Entity Migrations:**

- [ ] **10a.6** Migrate `Directory.repoProvider` to `DirectoryPlugin` capability defaults
- [ ] **10a.7** Migrate `Directory.sourceRepository` to `DirectoryPlugin.settings` (data-source plugin)
- [ ] **10a.8** Migrate `Directory.lastPullRequest` to `DirectoryPlugin.settings` (git plugin)

**DirectorySchedule Entity Migration:**

- [ ] **10a.9** Migrate `DirectorySchedule.alwaysCreatePullRequest` to `DirectoryPlugin.settings` (git plugin)

**Method Refactoring:**

- [ ] **10a.10** Refactor `User.getGitToken()` to use `GitFacade.getToken()`
- [ ] **10a.11** Refactor `User.asCommitter()` to use `GitFacade.getCommitter()`
- [ ] **10a.12** Refactor `Directory.getRepoOwner()` to use `GitFacade.getRepoOwner()`

**Data Migration:**

- [ ] **10a.13** Create database migration script to move existing data to plugin tables

---

## Phase 7: API Refactoring

### Story 11: API App Refactoring (13 tasks)

Refactor apps/api to use the plugin system instead of hardcoded providers.

- [ ] **11.0** Import and configure PluginsModule in AppModule (with dev/prod plugin paths)
- [ ] **11.1** Replace /vercel/_ with generic /deploy/:provider/_ controller
- [ ] **11.2** Remove VercelDeploymentVerifier (use IDeploymentPlugin.getStatus())
- [ ] **11.3** Replace GitHub strategy with plugin-based Git OAuth
- [ ] **11.4** Remove github-token.service.ts
- [ ] **11.5** Remove github-scopes.config.ts
- [ ] **11.6** Update screenshot controller to use facade
- [ ] **11.7** Create plugin discovery endpoint
- [ ] **11.8** Create plugin installation endpoint
- [ ] **11.9** Create plugin settings endpoints
- [ ] **11.10** Create directory plugin management endpoints
- [ ] **11.11** Create dynamic generator form API endpoint
- [ ] **11.12** Update DTOs (remove provider-specific fields)

---

## Phase 8: Frontend

### Story 12: Frontend - API Layer Refactoring (6 tasks) 🟡 IN PROGRESS

Refactor apps/web/src/lib/api/ for plugin-based providers.

- [ ] **12.1** Update deploy.ts to be provider-agnostic
- [ ] **12.2** Update auth.ts to be provider-agnostic
- [ ] **12.3** Update screenshot.ts to be provider-agnostic
- [x] **12.4** Create plugins.ts API functions _(implemented: `apps/web/src/lib/api/plugins.ts`)_
- [x] **12.5** Update enums.ts for plugin types _(implemented: PluginCategory, PluginState, ConfigurationMode types)_
- [x] **12.6** Add plugin settings API functions _(implemented: updateSettings, updateDirectorySettings, etc.)_

### Story 13: Frontend - Settings Components (5 tasks) ✅ MOSTLY COMPLETE

Refactor settings UI to be plugin-driven with dynamic forms.

- [x] **13.1** Create PluginsSettings component _(implemented: `PluginsList.tsx`, `PluginCard.tsx`)_
- [ ] **13.2** Create dynamic OAuthConnections component _(blocked by OAuthFacade)_
- [x] **13.3** Create Plugin Settings Page _(implemented: `/plugins/[pluginId]/page.tsx`, `PluginSettings.tsx`)_
- [ ] **13.4** Create Plugin Install Dialog _(marketplace not implemented)_
- [x] **13.5** Update existing settings pages to use plugin data _(implemented: plugin pages use API)_

### Story 14: Frontend - Directory Components (6 tasks) ✅ MOSTLY COMPLETE

Refactor directory UI to support multiple providers.

- [ ] **14.1** Create generic DeployForm component _(blocked by DeployFacade)_
- [ ] **14.2** Create generic RepositorySelector component _(blocked by GitFacade)_
- [x] **14.3** Update Directory Apps Tab for plugins _(implemented: `/directories/[id]/plugins/page.tsx`)_
- [x] **14.4** Create Plugin Enable/Disable toggle _(implemented: `DirectoryPluginCard.tsx`)_
- [x] **14.5** Create Directory Plugin Settings component _(implemented: `DirectoryPluginsList.tsx`, `CapabilitySelector.tsx`)_
- [x] **14.6** Update provider icons to use plugin metadata _(implemented: `PluginIcon.tsx` with 5 icon types)_

### Story 15: Frontend - Git Provider Connection (5 tasks) ❌ NOT STARTED

Refactor Git provider connection UI components (for repository access, not app authentication).

- [ ] **15.1** Create generic GitConnectionAlert (GitHub, GitLab, Bitbucket) _(blocked by GitFacade)_
- [ ] **15.2** Create generic GitStatusSidebar _(blocked by GitFacade)_
- [ ] **15.3** Implement dynamic provider icons from plugins _(PluginIcon ready, needs integration)_
- [ ] **15.4** Remove GitHub-specific connection components _(blocked by GitFacade)_
- [ ] **15.5** Create generic GitProviderConnectButton _(blocked by GitFacade)_

### Story 16: Frontend - Actions Refactoring (4 tasks) 🟡 IN PROGRESS

Refactor server actions to use plugin APIs.

- [ ] **16.1** Create generic deploy actions _(blocked by DeployFacade)_
- [ ] **16.2** Create generic oauth actions _(blocked by OAuthFacade)_
- [x] **16.3** Create plugin settings actions _(implemented: `apps/web/src/app/actions/plugins.ts`)_
- [x] **16.4** Create plugin management actions _(implemented: enable/disable/updateSettings actions)_

### Story 17: Generator Form Provider Selection (10 tasks) ✅ MOSTLY COMPLETE

Add sub-provider selection to generator form with dynamic fields.

- [x] **17.1** Create `/directories/:id/generator-form` API endpoint _(implemented: getFormSchema action)_
- [x] **17.2** Add `providers` and `pluginOptions` fields to generation DTO _(implemented: GeneratorForm supports providers)_
- [ ] **17.3** Update Pipeline Factory to resolve sub-providers _(backend work needed)_
- [x] **17.4** Create SubProviderSelector dropdown component _(implemented: `ProviderSelector.tsx`)_
- [x] **17.5** Create DynamicSubProviderFields component _(implemented: `DynamicPluginFields.tsx` with groups, conditions)_
- [x] **17.6** Create PipelineModeSelector component _(implemented: `PipelineModeSelector.tsx`)_
- [x] **17.7** Integrate provider selection into GeneratorForm _(implemented: full integration)_
- [ ] **17.8** Implement ConfigDto field graying (for handled fields)
- [ ] **17.9** Create "Handled by {sub-provider}" tooltips
- [ ] **17.10** Create SubProviderResolverService (backend)

---

## Phase 9: Testing & CI

### Story 18: Testing Infrastructure (15 tasks)

Create comprehensive testing infrastructure for the plugin system.

- [x] **18.1** Create testing utilities in `@ever-works/plugin/testing` (moved from separate package)
- [x] **18.2** Create MockPluginContext factory
- [x] **18.3** Create MockPluginEnvironment factory
- [x] **18.4** Create Plugin Contract Tests base suite
- [x] **18.5** Create unit tests for plugin discovery and loading (PluginLoaderService)
- [x] **18.6** Create unit tests for plugin registry (PluginRegistryService)
- [x] **18.7** Create tests for plugin lifecycle management
- [x] **18.8** Create unit tests for PipelineBuilderService
- [x] **18.9** Create unit tests for pipeline execution (StepPipelineExecutor, PipelineOrchestrator)
- [ ] **18.10** Create unit tests for GitHub plugin
- [ ] **18.11** Create unit tests for Vercel plugin
- [ ] **18.12** Create unit tests for ScreenshotOne plugin
- [ ] **18.13** Create unit tests for service facades
- [ ] **18.14** Create E2E/integration tests for plugin system
- [ ] **18.15** Update CI pipeline for plugin tests (coverage validation)

---

## Implementation Timeline

| Phase                      | Duration   | Stories       |
| -------------------------- | ---------- | ------------- |
| Phase 1: Foundation        | Week 1-2   | Stories 1-2   |
| Phase 2: Pipeline          | Week 3     | Story 3       |
| Phase 3: Module Decoupling | Week 4-5   | Stories 5-8   |
| Phase 4: Built-in Plugins  | Week 6-7   | Story 4       |
| Phase 5: Data Sources      | Week 8     | Story 9       |
| Phase 6: Service Facades   | Week 9     | Story 10      |
| Phase 7: API Refactoring   | Week 10-11 | Story 11      |
| Phase 8: Frontend          | Week 12-14 | Stories 12-17 |
| Phase 9: Testing & CI      | Week 15    | Story 18      |

---

## Notes

- See [PLUGIN_SYSTEM_JIRA_TICKETS.md](./PLUGIN_SYSTEM_JIRA_TICKETS.md) for detailed implementation details
- See [PLUGIN_ARCHITECTURE_GUIDE.md](./PLUGIN_ARCHITECTURE_GUIDE.md) for architecture overview and design patterns
- Each task checkbox can be marked with `[x]` when completed
- Update the Progress Summary table as tasks are completed
- **Package naming**: `@ever-works/plugin` includes contracts, base classes, helpers, and testing utilities

---

## Next Priorities (Recommended Order)

The following priorities are based on dependency analysis and unblocking subsequent work.

**Key Finding:** Frontend plugin UI is ~53% complete. All remaining frontend work is blocked by GitFacade and DeployFacade.

### 🔴 Priority 1: Git & Deploy Infrastructure (CRITICAL BLOCKERS)

These block **45+ tasks** across Phase 6a, Phase 7, and Phase 8:

| Task                 | Description                                        | Blocks                               |
| -------------------- | -------------------------------------------------- | ------------------------------------ |
| **Story 4.2 + 5.1**  | Create GitHub plugin (extract `github.service.ts`) | GitFacade                            |
| **Story 5.2 + 10.1** | Create GitFacade service                           | 13 Story 10a tasks, 8 frontend tasks |
| **Story 4.4 + 6.1**  | Create Vercel plugin (extract `vercel.service.ts`) | DeployFacade                         |
| **Story 6.2 + 10.2** | Create DeployFacade service                        | 3 Story 10a tasks, 5 frontend tasks  |

**Recommended approach:**

1. Create GitHub plugin package first (most used git provider)
2. Create GitFacade with GitHub as first provider
3. Create Vercel plugin package
4. Create DeployFacade with Vercel as first provider

### 🟠 Priority 2: AI Provider Plugins (Non-Blocking Enhancement)

AiFacade already exists. Creating AI plugins enables full plugin-based AI routing:

5. **Story 4.9**: Create OpenAI plugin package _(most used)_
6. **Story 4.10**: Create Anthropic plugin package

### 🟡 Priority 3: Complete Remaining Frontend

After GitFacade/DeployFacade exist, complete blocked frontend tasks:

7. **Story 12.1-12.3**: Provider-agnostic API layer (deploy, auth, screenshot)
8. **Story 13.2**: Dynamic OAuthConnections component
9. **Story 14.1-14.2**: Generic DeployForm, RepositorySelector
10. **Story 15.1-15.5**: Generic Git provider connection UI
11. **Story 16.1-16.2**: Generic deploy/oauth actions

### 🟢 Priority 4: Entity Migration (Story 10a)

Once GitFacade and DeployFacade exist:

12. **Story 10a.1-10a.5**: User entity migrations (vercelToken, oauthTokens)
13. **Story 10a.6-10a.9**: Directory entity migrations (repoProvider, sourceRepository)
14. **Story 10a.10-10a.12**: Method refactoring (getGitToken, asCommitter)
15. **Story 10a.13**: Database migration script

### 🔵 Priority 5: API Refactoring (Phase 7)

16. **Story 11.0-11.12**: API app refactoring (plugin endpoints, remove hardcoded providers)

---

## Dependency Graph

```
[Phase 1-2: Foundation/Pipeline] ✅ COMPLETE
         │
         ▼
[Git/Deploy Facades] ◀── CURRENT BLOCKER
         │
         ▼
[Git/Deploy Plugins] ◀── REQUIRED FOR FACADES
         │
         ▼
[Story 10a: Entity Migration] ◀── BLOCKED
         │
         ▼
[Phase 7: API Refactoring] ◀── BLOCKED
         │
         ▼
[Phase 8: Frontend] ◀── BLOCKED
```

---

## Implementation Files Reference

### Existing Facades (`packages/agent/src/facades/`)

| Facade                 | File                          | Status         |
| ---------------------- | ----------------------------- | -------------- |
| AiFacade               | `ai.facade.ts`                | ✅ Complete    |
| SearchFacade           | `search.facade.ts`            | ✅ Complete    |
| ScreenshotFacade       | `screenshot.facade.ts`        | ✅ Complete    |
| ContentExtractorFacade | `content-extractor.facade.ts` | ✅ Complete    |
| DataSourceFacade       | `data-source.facade.ts`       | ✅ Complete    |
| BaseFacade             | `base.facade.ts`              | ✅ Complete    |
| GitFacade              | -                             | ❌ Not started |
| DeployFacade           | -                             | ❌ Not started |
| OAuthFacade            | -                             | ❌ Not started |

### Existing Plugins (`packages/plugins/`)

| Plugin           | Package                   | Capabilities                            | Status      |
| ---------------- | ------------------------- | --------------------------------------- | ----------- |
| Default Pipeline | `default-pipeline`        | `pipeline-step`, `form-schema-provider` | ✅ System   |
| Tavily           | `tavily`                  | `search`, `content-extractor`           | ✅ Complete |
| Local Extractor  | `local-content-extractor` | `content-extractor`                     | ✅ Default  |
| Notion Extractor | `notion-extractor`        | `content-extractor`                     | ✅ Complete |
| Apify            | `apify`                   | `data-source`, `form-schema-provider`   | ✅ Complete |

### Missing Plugins (Required)

| Plugin        | Capabilities              | Priority |
| ------------- | ------------------------- | -------- |
| GitHub        | `git-provider`, `oauth`   | 🔴 P1    |
| Vercel        | `deployment`              | 🔴 P1    |
| OpenAI        | `ai-provider`             | 🟠 P2    |
| Anthropic     | `ai-provider`             | 🟠 P2    |
| GitLab        | `git-provider`, `oauth`   | 🟡 P3    |
| Netlify       | `deployment`              | 🟡 P3    |
| ScreenshotOne | `screenshot`              | 🟡 P3    |
| Exa.ai        | `full-pipeline`, `search` | 🟢 P4    |
