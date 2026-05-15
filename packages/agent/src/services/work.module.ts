import { Module } from '@nestjs/common';
import { DataGeneratorModule } from '../generators/data-generator/data-generator.module';
import { ItemsGeneratorModule } from '../items-generator/items-generator.module';
import { FacadesModule } from '../facades/facades.module';
import { MarkdownGeneratorModule } from '../generators/markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from '../generators/website-generator/website-generator.module';
import { DatabaseModule } from '../database/database.module';
import { ImportModule } from '../import/import.module';
import { CommunityPrModule } from '../community-pr/community-pr.module';
import { ComparisonGeneratorModule } from '../comparison-generator/comparison-generator.module';
import { TemplateCatalogModule } from '../template-catalog/template-catalog.module';
import { WorkDetailService } from './work-detail.service';
import { WorkOwnershipService } from './work-ownership.service';
import { WorkQueryService } from './work-query.service';
import { WorkLifecycleService } from './work-lifecycle.service';
import { WorkGenerationService } from './work-generation.service';
import { WorkScheduleService } from './work-schedule.service';
import { WorkScheduleDispatcherService } from './work-schedule-dispatcher.service';
import { AnonymousUserCleanupService } from './anonymous-user-cleanup.service';
import { WorkMemberService } from './work-member.service';
import { WorkInvitationService } from './work-invitation.service';
import { WorkImportService } from './work-import.service';
import { WorkAdvancedPromptsService } from './work-advanced-prompts.service';
import { WorkTaxonomyService } from './work-taxonomy.service';
import { GeneratorFormSchemaService } from './generator-form-schema.service';
import { WorkWebsiteRepositoryStateService } from './work-website-repository-state.service';
import { WorksConfigImportApplierService } from '@src/works-config/services/works-config-import-applier.service';
import { WorksConfigImportPlannerService } from '@src/works-config/services/works-config-import-planner.service';
import { WorksConfigProjectionService } from '@src/works-config/services/works-config-projection.service';
import { WorksConfigRepositorySyncService } from '@src/works-config/services/works-config-repository-sync.service';
import { WorksConfigRestoreService } from '@src/works-config/services/works-config-restore.service';
import { WorksConfigService } from '@src/works-config/services/works-config.service';
import { WorksConfigSyncListener } from '@src/works-config/services/works-config-sync.listener';
import { WorksConfigWriterService } from '@src/works-config/services/works-config-writer.service';
import { PlatformSyncSecretService } from './platform-sync-secret.service';
import { ZeroFrictionFunnelService } from './zero-friction-funnel.service';
import { DeployReadyPollerService } from './deploy-ready-poller.service';
import { ItemHealthService } from './item-health.service';
import { ItemSourceValidationSchedulerService } from './item-source-validation-scheduler.service';
import { PluginOperationsService } from '../plugins/services/plugin-operations.service';
import { SettingsSchemaValidatorService } from '../plugins/services/settings-schema-validator.service';
import { SubscriptionsModule } from '@src/subscriptions';
import { RepositoryManagementService } from './repository-management.service';
import { NotificationsModule } from '@src/notifications';
import {
    EVER_WORKS_DEPLOY_QUOTA_COUNTER,
    EverWorksDeployQuotaService,
    EverWorksGitProvider,
    EverWorksDnsService,
    type EverWorksDeployQuotaCounter,
} from '@src/ever-works-providers';
import { WorkRepository } from '@src/database/repositories/work.repository';

/**
 * Work module providing work-related services.
 *
 * Note: This module relies on PluginsModule being registered globally via forRoot()
 * at the application root level. Do not import PluginsModule directly here.
 */
@Module({
    imports: [
        DatabaseModule,
        DataGeneratorModule,
        ItemsGeneratorModule,
        FacadesModule,
        MarkdownGeneratorModule,
        WebsiteGeneratorModule,
        ImportModule,
        SubscriptionsModule,
        NotificationsModule,
        CommunityPrModule,
        ComparisonGeneratorModule,
        TemplateCatalogModule,
    ],
    providers: [
        WorkOwnershipService,
        WorkWebsiteRepositoryStateService,
        WorkQueryService,
        WorkLifecycleService,
        WorkGenerationService,
        WorkDetailService,
        WorkScheduleService,
        WorkScheduleDispatcherService,
        AnonymousUserCleanupService,
        WorkMemberService,
        WorkInvitationService,
        WorkImportService,
        WorkAdvancedPromptsService,
        WorkTaxonomyService,
        ItemHealthService,
        ItemSourceValidationSchedulerService,
        RepositoryManagementService,
        GeneratorFormSchemaService,
        WorksConfigImportPlannerService,
        WorksConfigImportApplierService,
        WorksConfigRestoreService,
        WorksConfigService,
        WorksConfigWriterService,
        WorksConfigProjectionService,
        WorksConfigRepositorySyncService,
        WorksConfigSyncListener,
        PluginOperationsService,
        SettingsSchemaValidatorService,
        EverWorksDeployQuotaService,
        PlatformSyncSecretService,
        ZeroFrictionFunnelService,
        DeployReadyPollerService,
        // EW-614 — `EverWorksGitProvider` creates the per-Work repository in
        // the platform GitHub org (`ever-works-cloud`) using a server-held
        // PAT, so users picking "Ever Works Git" don't need to bring their
        // own GitHub. Consumed by `WorkLifecycleService.createWork`.
        EverWorksGitProvider,
        EverWorksDnsService,
        {
            // The Ever Works Deploy quota service is repo-agnostic — it
            // takes a small `EverWorksDeployQuotaCounter` it can consult.
            // This factory binds that counter to the live `WorkRepository`
            // so the quota check runs against the real DB.
            provide: EVER_WORKS_DEPLOY_QUOTA_COUNTER,
            useFactory: (workRepository: WorkRepository): EverWorksDeployQuotaCounter => ({
                countActiveDeploys: (userId) =>
                    workRepository.countActiveByDeployProvider(userId, 'ever-works'),
            }),
            inject: [WorkRepository],
        },
    ],
    exports: [
        WorkOwnershipService,
        WorkWebsiteRepositoryStateService,
        WorkQueryService,
        WorkLifecycleService,
        WorkGenerationService,
        WorkDetailService,
        WorkScheduleService,
        WorkScheduleDispatcherService,
        AnonymousUserCleanupService,
        WorkMemberService,
        WorkInvitationService,
        WorkImportService,
        WorkAdvancedPromptsService,
        WorkTaxonomyService,
        ItemHealthService,
        ItemSourceValidationSchedulerService,
        RepositoryManagementService,
        GeneratorFormSchemaService,
        WorksConfigImportPlannerService,
        WorksConfigImportApplierService,
        WorksConfigRestoreService,
        WorksConfigService,
        WorksConfigWriterService,
        WorksConfigProjectionService,
        WorksConfigRepositorySyncService,
        PlatformSyncSecretService,
        ZeroFrictionFunnelService,
        DeployReadyPollerService,
        CommunityPrModule,
        ComparisonGeneratorModule,
        TemplateCatalogModule,
    ],
})
export class WorkModule {}
