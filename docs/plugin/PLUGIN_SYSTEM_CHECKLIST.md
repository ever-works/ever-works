# Ever Works Plugin System - Implementation Checklist

This checklist tracks the implementation progress of the Plugin System as defined in [PLUGIN_SYSTEM_JIRA_TICKETS.md](./PLUGIN_SYSTEM_JIRA_TICKETS.md).

**Total Tasks:** 164 across 18 Stories

---

## Progress Summary

| Phase                      | Stories | Tasks   | Completed |
| -------------------------- | ------- | ------- | --------- |
| Phase 1: Foundation        | 1-2     | 40      | 0         |
| Phase 2: Pipeline          | 3       | 23      | 0         |
| Phase 3: Module Decoupling | 5-8     | 16      | 0         |
| Phase 4: Built-in Plugins  | 4       | 12      | 0         |
| Phase 5: Data Sources      | 9       | 3       | 0         |
| Phase 6: Service Facades   | 10      | 7       | 0         |
| Phase 7: API Refactoring   | 11      | 12      | 0         |
| Phase 8: Frontend          | 12-17   | 36      | 0         |
| Phase 9: Testing & CI      | 18      | 15      | 0         |
| **Total**                  | **18**  | **164** | **0**     |

---

## Phase 1: Foundation

### Story 1: Plugin Contracts Package (28 tasks)

Create `packages/plugin-contracts` containing all TypeScript interfaces and types.

**⚠️ TYPE SAFETY IS CRITICAL:** All interfaces must be strongly typed. Step IDs, data keys, and step results use union types and mapped interfaces for compile-time validation.

- [ ] **1.1** Set up plugin-contracts package structure
- [ ] **1.2** Define base IPlugin interface (includes `configurationMode` for admin/user/hybrid settings)
- [ ] **1.3** Define PluginContext interface (**TYPE-SAFE:** typed events with `PluginEventName` and `PluginEventPayloads`)
- [ ] **1.4** Define IGitProviderPlugin capability interface
- [ ] **1.5** Define IDeploymentPlugin capability interface
- [ ] **1.6** Define IScreenshotPlugin capability interface
- [ ] **1.7** Define ISearchPlugin capability interface
- [ ] **1.8** Define IContentExtractorPlugin capability interface
- [ ] **1.9** Define IDataSourcePlugin capability interface
- [ ] **1.10** Define IAiProviderPlugin interface (includes `askJson`, `getCapabilities`, `healthCheck`)
- [ ] **1.11** Define IPipelineStepPlugin capability interface (**TYPE-SAFE:** uses `BuiltInStepId`, `StepDataKey`, `StepDataTypes`)
- [ ] **1.12** Define IFullPipelinePlugin capability interface
- [ ] **1.13** Define IFormFieldPlugin capability interface
- [ ] **1.14** Define IGitOAuthPlugin capability interface for git provider OAuth
- [ ] **1.15** Define ICustomCapabilityRegistry interface for plugin-to-plugin communication
- [ ] **1.16** Define CapabilityMetadata and related types
- [ ] **1.17** Define common types for settings, validation, and pipeline (includes `step-types.ts`)
- [ ] **1.18** Create clean export index for all interfaces (exports `step-types.ts`)
- [ ] **1.19** Define ISubProviderPlugin interface for multi-capability plugins
- [ ] **1.20** Define IConfigAwarePlugin interface for ConfigDto field handling
- [ ] **1.21** Define PluginSubProvider and SubProviderOption types
- [ ] **1.22** Define PluginIcon type with multiple format support
- [ ] **1.23** Define PipelineStepDefinition interface (**TYPE-SAFE:** typed `id`, `dependencies`, `provides`)
- [ ] **1.24** Define StepPosition union type (**TYPE-SAFE:** `stepId` must be `BuiltInStepId`)
- [ ] **1.25** Define ParallelGroup interface for concurrent step execution
- [ ] **1.26** Define ExecutablePipeline interface for compiled pipelines
- [ ] **1.27** Define step-types.ts with `BuiltInStepId`, `StepDataKey`, `StepDataTypes` types
- [ ] **1.28** Define event-types.ts with `PluginEventName` and `PluginEventPayloads` types

### Story 2: Plugin System Runtime (12 tasks)

Create the plugin runtime system in `packages/agent` for discovery, loading, and lifecycle management.

- [ ] **2.1** Create PluginRegistry service
- [ ] **2.2** Create PluginLoader service for discovery and loading
- [ ] **2.3** Create PluginManifestValidator service
- [ ] **2.4** Create PluginVersionChecker service
- [ ] **2.5** Create PluginClassValidator service
- [ ] **2.6** Create PluginLifecycleManager service
- [ ] **2.7** Create PluginSettingsService with 4-level hierarchy (Plugin → Admin → User → Directory)
- [ ] **2.8** Create PluginContextFactory service
- [ ] **2.9** Create CustomCapabilityRegistryService
- [ ] **2.10** Create TypeORM entities (Plugin, AdminPlugin, UserPlugin, DirectoryPlugin)
- [ ] **2.11** Create PluginsModule with forRoot configuration
- [ ] **2.12** Add @ever-works/plugin-contracts as dependency

---

## Phase 2: Pipeline

### Story 3: Pipeline Refactoring (23 tasks)

Refactor the pipeline to be fully plugin-driven with step injection support.

**⚠️ TYPE SAFETY:** Pipeline must use typed step IDs (`BuiltInStepId`), data keys (`StepDataKey`), and result types (`StepDataTypes`).

- [ ] **3.1** Refactor GenerationContext for dependency-based data flow (**TYPE-SAFE:** generic `getStepResult<K>()`)
- [ ] **3.2** Define BUILT_IN_STEPS array with explicit dependencies (**TYPE-SAFE:** uses step-types.ts)
- [ ] **3.3** Create default pipeline plugin wrapping built-in steps (systemPlugin: true, hidden from UI)
- [ ] **3.4** Create PipelineBuilderService for pipeline compilation
- [ ] **3.5** Implement step replacement in PipelineBuilderService
- [ ] **3.6** Implement step injection in PipelineBuilderService
- [ ] **3.7** Implement step disabling in PipelineBuilderService
- [ ] **3.8** Implement append/prepend positioning
- [ ] **3.9** Implement topological sort for step ordering
- [ ] **3.10** Identify steps that can run in parallel
- [ ] **3.11** Apply provider overrides to category steps
- [ ] **3.12** Create ExecutablePipeline class
- [ ] **3.13** Create StepPipelineExecutor (step-based pipeline executor)
- [ ] **3.14** Create FullPipelineExecutor
- [ ] **3.15** Check providers.pipeline for full vs step-based execution
- [ ] **3.16** Skip steps when previous step already provided data
- [ ] **3.17** Track per-step execution metrics
- [ ] **3.18** Save context after each step (checkpoint saving)
- [ ] **3.19** Add pipeline event hooks (beforePipeline, afterStep, onStepError, afterPipeline)
- [ ] **3.20** Map step IDs to executors
- [ ] **3.21** Validate step dependencies before execution
- [ ] **3.22** Detect circular dependencies in step graph
- [ ] **3.23** Refactor existing 14 services to new step interface

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

### Story 7: Screenshot Module Decoupling (3 tasks)

Abstract screenshot operations behind IScreenshotPlugin interface.

- [ ] **7.1** Move screenshot-one.service.ts to plugin (extract)
- [ ] **7.2** Create ScreenshotService Facade using plugin registry
- [ ] **7.3** Update SmartImageRouter to use Screenshot facade

### Story 8: AI Module Decoupling (4 tasks)

Decouple AI module and fix provider instantiation.

- [ ] **8.1** Fix provider switch (use correct LLM classes per provider)
- [ ] **8.2** Extract AI providers to plugin packages
- [ ] **8.3** Create AiService Facade using plugin registry
- [ ] **8.4** Implement proper provider factory pattern

---

## Phase 4: Built-in Plugins

### Story 4: Built-in Plugins Package (12 tasks)

Create `packages/plugins/` with all built-in plugins as full packages.

- [ ] **4.1** Set up packages/plugins workspace structure
- [ ] **4.2** Create GitHub plugin package (IGitProviderPlugin + IGitOAuthPlugin)
- [ ] **4.3** Create GitLab plugin package (IGitProviderPlugin + IGitOAuthPlugin)
- [ ] **4.4** Create Vercel plugin package (IDeploymentPlugin)
- [ ] **4.5** Create Netlify plugin package (IDeploymentPlugin)
- [ ] **4.6** Create ScreenshotOne plugin package (IScreenshotPlugin)
- [ ] **4.7** Create Tavily plugin package (ISearchPlugin + IContentExtractorPlugin)
- [ ] **4.8** Create Exa.ai plugin package (IFullPipelinePlugin + ISearchPlugin)
- [ ] **4.9** Create OpenAI plugin package (IAiProviderPlugin)
- [ ] **4.10** Create Anthropic plugin package (IAiProviderPlugin)
- [ ] **4.11** Create Notion plugin package (IDataSourcePlugin)
- [ ] **4.12** Create Apify plugin package (IDataSourcePlugin)

---

## Phase 5: Data Sources

### Story 9: Data Source Plugins (3 tasks)

Create the data source abstraction and extract existing importers.

- [ ] **9.1** Move Awesome Readme parser to plugin (extract)
- [ ] **9.2** Create DataSource Facade using plugin registry
- [ ] **9.3** Update import services to use DataSource facade

---

## Phase 6: Service Facades

### Story 10: Service Facades (7 tasks)

Create thin facade services in packages/agent wrapping plugin registry calls.

- [ ] **10.1** Create GitFacade service
- [ ] **10.2** Create DeployFacade service
- [ ] **10.3** Create ScreenshotFacade service
- [ ] **10.4** Create SearchFacade service
- [ ] **10.5** Create AiFacade service with model routing (complexity → tier → provider selection)
- [ ] **10.6** Create GitOAuthFacade service
- [ ] **10.7** Update all agent consumers to use facades

---

## Phase 7: API Refactoring

### Story 11: API App Refactoring (12 tasks)

Refactor apps/api to use the plugin system instead of hardcoded providers.

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

### Story 12: Frontend - API Layer Refactoring (6 tasks)

Refactor apps/web/src/lib/api/ for plugin-based providers.

- [ ] **12.1** Update deploy.ts to be provider-agnostic
- [ ] **12.2** Update auth.ts to be provider-agnostic
- [ ] **12.3** Update screenshot.ts to be provider-agnostic
- [ ] **12.4** Create plugins.ts API functions
- [ ] **12.5** Update enums.ts for plugin types
- [ ] **12.6** Add plugin settings API functions

### Story 13: Frontend - Settings Components (5 tasks)

Refactor settings UI to be plugin-driven with dynamic forms.

- [ ] **13.1** Create PluginsSettings component
- [ ] **13.2** Create dynamic OAuthConnections component
- [ ] **13.3** Create Plugin Settings Page
- [ ] **13.4** Create Plugin Install Dialog
- [ ] **13.5** Update existing settings pages to use plugin data

### Story 14: Frontend - Directory Components (6 tasks)

Refactor directory UI to support multiple providers.

- [ ] **14.1** Create generic DeployForm component
- [ ] **14.2** Create generic RepositorySelector component
- [ ] **14.3** Update Directory Apps Tab for plugins
- [ ] **14.4** Create Plugin Enable/Disable toggle
- [ ] **14.5** Create Directory Plugin Settings component
- [ ] **14.6** Update provider icons to use plugin metadata

### Story 15: Frontend - Git Provider Connection (5 tasks)

Refactor Git provider connection UI components (for repository access, not app authentication).

- [ ] **15.1** Create generic GitConnectionAlert (GitHub, GitLab, Bitbucket)
- [ ] **15.2** Create generic GitStatusSidebar
- [ ] **15.3** Implement dynamic provider icons from plugins
- [ ] **15.4** Remove GitHub-specific connection components
- [ ] **15.5** Create generic GitProviderConnectButton

### Story 16: Frontend - Actions Refactoring (4 tasks)

Refactor server actions to use plugin APIs.

- [ ] **16.1** Create generic deploy actions
- [ ] **16.2** Create generic oauth actions
- [ ] **16.3** Create plugin settings actions
- [ ] **16.4** Create plugin management actions

### Story 17: Generator Form Provider Selection (10 tasks)

Add sub-provider selection to generator form with dynamic fields.

- [ ] **17.1** Create `/directories/:id/generator-form` API endpoint
- [ ] **17.2** Add `providers` and `pluginOptions` fields to generation DTO
- [ ] **17.3** Update Pipeline Factory to resolve sub-providers
- [ ] **17.4** Create SubProviderSelector dropdown component
- [ ] **17.5** Create DynamicSubProviderFields component (render form fields from plugins)
- [ ] **17.6** Create PipelineModeSelector component (Standard vs Full toggle)
- [ ] **17.7** Integrate provider selection into GeneratorForm
- [ ] **17.8** Implement ConfigDto field graying (for handled fields)
- [ ] **17.9** Create "Handled by {sub-provider}" tooltips
- [ ] **17.10** Create SubProviderResolverService (backend)

---

## Phase 9: Testing & CI

### Story 18: Testing Infrastructure (15 tasks)

Create comprehensive testing infrastructure for the plugin system.

- [ ] **18.1** Create `@ever-works/plugin-test-utils` package
- [ ] **18.2** Create MockPluginContext factory
- [ ] **18.3** Create MockPluginEnvironment factory
- [ ] **18.4** Create Plugin Contract Tests base suite
- [ ] **18.5** Create unit tests for plugin discovery and loading (PluginLoaderService)
- [ ] **18.6** Create unit tests for plugin registry (PluginRegistryService)
- [ ] **18.7** Create tests for plugin lifecycle management
- [ ] **18.8** Create unit tests for PipelineBuilderService
- [ ] **18.9** Create unit tests for pipeline execution (StepPipelineExecutor)
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
