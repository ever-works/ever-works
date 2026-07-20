import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { UsageModule } from '../usage/usage.module';
import { BudgetsModule } from '../budgets/budgets.module';

import { AiFacadeService } from './ai.facade';
import { SearchFacadeService } from './search.facade';
import { ScreenshotFacadeService } from './screenshot.facade';
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
import { VectorStoreFacadeService } from './vector-store.facade';
import { MetricsFacadeService } from './metrics.facade';

const FACADES = [
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
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
    imports: [DatabaseModule, UsageModule, BudgetsModule],
    providers: FACADES,
    exports: FACADES,
})
export class FacadesModule {}
