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
import { WorkMemberService } from './work-member.service';
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
import { ItemHealthService } from './item-health.service';
import { ItemSourceValidationSchedulerService } from './item-source-validation-scheduler.service';
import { PluginOperationsService } from '../plugins/services/plugin-operations.service';
import { SettingsSchemaValidatorService } from '../plugins/services/settings-schema-validator.service';
import { SubscriptionsModule } from '@src/subscriptions';
import { RepositoryManagementService } from './repository-management.service';
import { NotificationsModule } from '@src/notifications';

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
        WorkMemberService,
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
        WorkMemberService,
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
        CommunityPrModule,
        ComparisonGeneratorModule,
        TemplateCatalogModule,
    ],
})
export class WorkModule {}
