import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { UsageModule } from '../usage/usage.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { PolicyModule } from '../policy/policy.module';
import { AgentPluginsModule } from '../agent-plugins/agent-plugins.module';
import { MergeApprovalModule } from '../agent-approvals/merge-approval.module';
import { EmailSendPolicyModule } from '../email/email-send-policy.module';
import { ModelRoutingModule } from '../model-routing/model-routing.module';

import { AiFacadeService } from './ai.facade';
import { SearchFacadeService } from './search.facade';
import { ScreenshotFacadeService } from './screenshot.facade';
import { BrowserAutomationFacadeService } from './browser-automation.facade';
import { ContentExtractorFacadeService } from './content-extractor.facade';
import { DataSourceFacadeService } from './data-source.facade';
import { GitFacadeService } from './git.facade';
import { OAuthFacadeService } from './oauth.facade';
import { DeployFacadeService } from './deploy.facade';
import { CodeEditFacadeService } from './code-edit.facade';
import { PromptFacadeService } from './prompt.facade';
import { SkillsFacadeService } from './skills.facade';
import { TasksFacadeService } from './tasks.facade';
import { EmailFacadeService } from './email.facade';
import { NotificationChannelFacadeService } from './notification-channel.facade';
import { AgentMemoryFacadeService } from './agent-memory.facade';
import { TerminalStreamFacadeService } from './terminal-stream.facade';
import { WorkspaceFacadeService } from './workspace.facade';
import { VectorStoreFacadeService } from './vector-store.facade';
import { MetricsFacadeService } from './metrics.facade';
import { PlaybookCatalogFacadeService } from './playbook-catalog.facade';
import { ConnectionScopesFacadeService } from './connection-scopes.facade';
import { AppRuntimeFacadeService } from './app-runtime.facade';
import { AppDependencyFacadeService } from './app-dependency.facade';

const FACADES = [
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    BrowserAutomationFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
    OAuthFacadeService,
    DeployFacadeService,
    CodeEditFacadeService,
    PromptFacadeService,
    SkillsFacadeService,
    TasksFacadeService,
    // Notifications v2 (EW-650 + EW-663) — email + multi-channel notifications.
    EmailFacadeService,
    NotificationChannelFacadeService,
    AgentMemoryFacadeService,
    TerminalStreamFacadeService,
    WorkspaceFacadeService,
    // EW-724 / EW-725 — vector-store facade (KB embeddings; consumed by
    // KnowledgeBaseReembedService via FacadesModule). Provided here like every
    // other barrel facade; deps are the global PluginRegistryService plus two
    // @Optional() injections, so it resolves in this module.
    VectorStoreFacadeService,
    // Goals feature PR-7 — read-only metrics collectors (custom-http,
    // Stripe). Budget-guarded + usage-recorded via UsageModule /
    // BudgetsModule already imported by this module. Goal evaluation
    // (PR-8) consumes it through FacadesModule.
    MetricsFacadeService,
    // Capability & playbook catalogue (AW-21) — read-only fan-out across
    // enabled playbook-provider plugins; consumed by the API catalog module.
    PlaybookCatalogFacadeService,
    // AW-15 — `connection-scopes` capability lookup (which access levels a
    // provider declares). Depends only on the global PluginRegistryService.
    ConnectionScopesFacadeService,
    // APW-06 T20 — the App runtime plugin-and-credential facade (R-5).
    //
    // ⚠️ It IS constructed in every process that imports this module — that is
    // deliberate (APW06-G02) and it is why the class refuses PER CALL, never at
    // construction: every method throws `APP_CLUSTER_IO_IN_API` unless
    // `isAppClusterWorkerContext()` is true. Nothing in an API process may call
    // it, and `apps/api/src` carries a static test asserting no file there
    // imports the marker that would arm the flag.
    AppRuntimeFacadeService,
    // APW-07 T16 — the App dependency provider facade. Like every other facade
    // here it depends only on the global PluginRegistryService plus two
    // @Optional() injections, so it resolves in this module; it is what
    // `AppDependenciesService` selects a provider through (plan §4.8:543-546).
    AppDependencyFacadeService,
];

/**
 * Facades module providing unified access to AI, Search, Screenshot etc. services.
 *
 * These facades wrap the plugin registry and settings service to provide
 * a consistent interface for pipeline steps. Providers are resolved dynamically
 * from the plugin registry based on capability.
 *
 * Resolution priority:
 * 1. Provider override (explicit request)
 * 2. Work default provider
 * 3. User default provider
 * 4. First enabled provider
 *
 * Settings are resolved using the 4-level hierarchy:
 * 1. Work settings
 * 2. User settings
 * 3. Admin settings
 * 4. Plugin defaults
 *
 * Note: This module relies on PluginsModule being registered globally via forRoot()
 * at the application root level. Do not import PluginsModule directly here.
 */
@Module({
    // PolicyModule is a leaf (four scope entities, no facade imports), so
    // importing it here cannot cycle. It binds MERGE_POLICY_ENFORCER,
    // which GitFacadeService consumes @Optional() to enforce the
    // merge-policy matrix on agent-driven merges (Wave 3, D4).
    // AgentPluginsModule is also a leaf (two entities, no facade imports), so
    // importing it here cannot cycle. It binds AGENT_PLUGIN_SKILL_SOURCE,
    // which SkillsFacadeService consumes @Optional() to merge Agent Plugins
    // package skills into the catalog as an additive last source.
    imports: [
        DatabaseModule,
        UsageModule,
        BudgetsModule,
        PolicyModule,
        AgentPluginsModule,
        // Merge approval (self-build slice AE, EW-805) — binds
        // MERGE_APPROVAL_VERIFIER, which GitFacadeService consumes before
        // it lets any merge reach a provider. Imported here (not folded
        // into PolicyModule) so PolicyModule stays the entity-only leaf
        // every policy consumer can depend on.
        MergeApprovalModule,
        // Agent email (AW-05) — binds EMAIL_SEND_POLICY_GATE, which
        // EmailFacadeService consumes before any send reaches a provider
        // (approve-before-send + send ceilings). A DatabaseModule-only leaf,
        // so importing it here cannot cycle.
        EmailSendPolicyModule,
        // Model accounts (AW-16) — binds MODEL_ROUTE_PLANNER, which
        // AiFacadeService consumes around every model call (the workspace /
        // Agent / schedule model ladder, several accounts per provider, and
        // the record a Run keeps of what answered). A DatabaseModule +
        // ActivityLogModule leaf with no facade imports, so it cannot cycle.
        ModelRoutingModule,
    ],
    providers: FACADES,
    exports: FACADES,
})
export class FacadesModule {}
