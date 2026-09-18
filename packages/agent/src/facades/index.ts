/**
 * Facades module exports.
 *
 * These facades provide a unified interface for pipeline steps to access
 * AI, Search, Screenshot, and Content Extraction capabilities through
 * the plugin system.
 */

// Facades Module
export { FacadesModule } from './facades.module';

// Base Facade
export {
    BaseFacadeService,
    FacadeError,
    NoProviderError,
    ProviderNotFoundError,
    type DefaultProviderInfo,
} from './base.facade';

// Re-export FacadeOptions from plugin for convenience
export type { FacadeOptions } from '@ever-works/plugin';

// AI Facade
export { AiFacadeService, AiFacadeError, TranscriptionNotConfiguredError } from './ai.facade';

// Search Facade
export { SearchFacadeService, SearchFacadeError } from './search.facade';

// Re-export SearchFacadeOptions from plugin for convenience
export type { SearchFacadeOptions } from '@ever-works/plugin';

// Screenshot Facade
export { ScreenshotFacadeService, ScreenshotFacadeError } from './screenshot.facade';
export {
    BrowserAutomationFacadeService,
    BrowserAutomationFacadeError,
    type BrowserReadResult,
} from './browser-automation.facade';

// Content Extractor Facade
export {
    ContentExtractorFacadeService,
    ContentExtractorFacadeError,
    NoContentExtractorProviderError,
    ContentExtractorProviderNotFoundError,
} from './content-extractor.facade';

// Data Source Facade
export { DataSourceFacadeService, DataSourceFacadeError } from './data-source.facade';

// Git Facade
export {
    GitFacadeService,
    GitFacadeError,
    NoGitProviderError,
    GitProviderNotFoundError,
    NoGitCredentialsError,
    // Merge-policy matrix (Wave 3, D4) — refusal error + the actor shape
    // that marks a merge agent-driven. Both cross package boundaries
    // (apps/api maps the error to 403), so both must be barrel-exported.
    MergePolicyRefusedError,
    type AgentMergeActor,
    type GitFacadeOptions,
    type GitProviderInfo,
    type FacadeCloneOptions,
    type FacadePushOptions,
} from './git.facade';

// OAuth Facade
export {
    OAuthFacadeService,
    OAuthFacadeError,
    NoOAuthProviderError,
    OAuthProviderNotFoundError,
    OAuthNotSupportedError,
} from './oauth.facade';

// Deploy Facade
export {
    DeployFacadeService,
    DeployFacadeError,
    NoDeployProviderError,
    DeployProviderNotFoundError,
    NoDeployCredentialsError,
    PLATFORM_MANAGED_KUBECONFIG_SENTINEL,
    type DeployFacadeFullOptions,
} from './deploy.facade';

// Code Edit Facade
export {
    CodeEditFacadeService,
    type CodeEditFacadeOptions,
    type CodeEditProviderInfo,
} from './code-edit.facade';

// Prompt Facade
export { PromptFacadeService } from './prompt.facade';

// Skills Facade — Agents/Skills/Tasks PR #1017, Phase 8.6 (ADR-012)
export { SkillsFacadeService, SkillsFacadeError } from './skills.facade';

// Tasks Facade — Agents/Skills/Tasks PR #1017, Phase 11.8 (ADR-013)
export { TasksFacadeService, TasksFacadeError } from './tasks.facade';

// Email Facade — Notifications v2 (EW-650, EW-668)
export {
    EmailFacadeService,
    EmailFacadeError,
    type EmailFacadeSendInput,
    type EmailFacadeSendOptions,
    type EmailFacadeTemplate,
} from './email.facade';

// Notification Channel Facade — Notifications v2 (EW-663, EW-672)
export {
    NotificationChannelFacadeService,
    NotificationChannelFacadeError,
    NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER,
    type NotificationFanoutContent,
    type NotificationChannelFanoutInput,
    type NotificationChannelFanoutResult,
    type NotificationChannelDeliveryPayload,
    type NotificationChannelDeliveryDispatcher,
    type ResolvedChannelTarget,
} from './notification-channel.facade';

// Agent-Memory Facade — pluggable persistent memory for agents
// (default plugin `@ever-works/agentmemory-plugin` talks to a local or
// hosted `agentmemory` REST server on :3111)
export { AgentMemoryFacadeService, AgentMemoryFacadeError } from './agent-memory.facade';
export { TerminalStreamFacadeService, TerminalStreamFacadeError } from './terminal-stream.facade';
export { WorkspaceFacadeService, WorkspaceFacadeError } from './workspace.facade';

// Vector Store Facade — EW-642 RFC §6 selection chain + D4 embedding
// mode resolver. Routes KB chunk upsert / query / delete through the
// resolved `IVectorStorePlugin` for the (work, user) tuple.
export {
    VectorStoreFacadeService,
    VectorStoreNotConfiguredError,
    EmbeddingModeResolver,
    EmbeddingModeUnsupportedError,
    type SelectVectorStoreOpts,
    type EmbeddingMode,
    type EmbeddingModeSetting,
} from './vector-store.facade';

// Metrics Facade — Goals feature PR-7 (metrics-provider capability).
// Read-only metric reads through enabled providers (custom-http,
// Stripe); Goal evaluation (PR-8) consumes this.
export { MetricsFacadeService, MetricsFacadeError } from './metrics.facade';

// Connection Scopes Facade — AW-15. Which plain-English access levels a
// provider plugin declares; the tool-grant lattice stores the chosen level.
export { ConnectionScopesFacadeService } from './connection-scopes.facade';

// App Runtime Facade — APW-06 T20. The ONE place a Deployment plugin and its
// credential are assembled (R-5): `your-cluster` through the Work's own
// `deployProvider` plugin and its Work-scoped `custom-kubeconfig` settings,
// `ever-works-apps` through the enabled `apps-tier` plugin and
// `AppsTierPolicy.resolveClusterCredential`, only while the tier is open.
// It implements the two seams T58 and T60 declared provisionally
// (`resolveDeletionTarget`, `resolveVerificationTarget`) so those two services
// wire to it unchanged, plus the general `resolveClusterAccess` §9.10's op
// handlers resolve through.
//
// ⚠️ Worker-only, per call: every method throws `APP_CLUSTER_IO_IN_API` unless
// `isAppClusterWorkerContext()` is true. Outside the isolated App runtime
// worker only its CONSTRUCTION is expected — `FacadesModule` provides it so the
// API's plugin graph is complete (APW06-G02), never so the API can call it.
export {
    AppRuntimeFacadeService,
    type AppRuntimeFacadeRefusal,
    type AppRuntimeClusterAccess,
    type AppRuntimeAccessResult,
    type AppDeploymentPlugin,
    type AppRuntimeStateTargetStore,
    type AppRuntimeStateTargetView,
} from './app-runtime.facade';

// App Dependency Facade — APW-07 T16. The ONE place an App dependency provider
// is chosen for a (kind, deploy target) and called: enabled plugins declaring
// the `app-dependency` capability are asked `supports` in ascending
// `preference`, and the owner's explicit choice wins when it is supported
// (plan §4.8:543-546). It also carries the `awaitingConfig` flag of plan §4.9a,
// which is what makes a provider needing the owner's settings land in
// `awaiting_config` instead of burning its deadline.
export {
    AppDependencyFacadeService,
    AppDependencyFacadeError,
    NoAppDependencyProviderError,
    AppDependencyProviderNotFoundError,
    type AppDependencyFacadeOptions,
    type AppDependencySelection,
    type AppDependencySelectionResult,
    type ResolvedAppDependencyProvider,
} from './app-dependency.facade';
export type {
    IMetricsProviderPlugin,
    MetricDescriptor,
    MetricQuery,
    MetricSample,
    MetricWindow,
} from '@ever-works/plugin';

// Playbook Catalog Facade — capability & playbook catalogue (AW-21).
// Version-wins merge across enabled playbook-provider plugins.
export {
    PlaybookCatalogFacadeService,
    PlaybookCatalogFacadeError,
    PLAYBOOK_PROVIDER_PAGE_SIZE,
    MAX_PLAYBOOK_CATALOG_ENTRIES,
} from './playbook-catalog.facade';

// Re-export facade types from plugin for convenience
export type { FacadeExtractionOptions, FacadeExtractedContent } from '@ever-works/plugin';
export type {
    DataSourceFacadeOptions,
    DataSourceFacadeResult,
    EnabledDataSource,
} from '@ever-works/plugin';
