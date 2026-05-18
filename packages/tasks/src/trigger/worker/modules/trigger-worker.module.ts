import { Module } from '@nestjs/common';
import { WorkOperationsService } from '@ever-works/agent/work-operations';
import {
    TemplateRepository,
    TemplateCustomizationRepository,
    UserRepository,
    UserTemplatePreferenceRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import { NotificationService } from '@ever-works/agent/notifications';
import { DataGeneratorService } from '@ever-works/agent/generators';
import { MarkdownGeneratorService } from '@ever-works/agent/generators';
import {
    WebsiteGeneratorService,
    BranchSyncService,
    WebsiteTemplateResolverService,
} from '@ever-works/agent/generators';
import { SourceRepoAnalyzerService, ImportExecutorService } from '@ever-works/agent/import';
import { WorksConfigService, WorksConfigWriterService } from '@ever-works/agent/works-config';
import { TemplateCustomizationService } from '@ever-works/agent/template-catalog';
import { CategoryIconService } from '@ever-works/agent/services';
import { TriggerPluginsModule } from './trigger-plugins.module';
import { TriggerFacadesModule } from './trigger-facades.module';
import { TriggerPipelineModule } from './trigger-pipeline.module';
import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerRemoteCacheModule } from './trigger-remote-cache.module';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { createRemoteProxy } from '../remote-proxy';
import { TriggerGenerationOrchestrator } from '../orchestrators/trigger-generation.orchestrator';
import { TriggerImportOrchestrator } from '../orchestrators/trigger-import.orchestrator';

@Module({
    imports: [
        TriggerPluginsModule.forRoot(),
        TriggerFacadesModule,
        TriggerPipelineModule,
        TriggerInternalModule,
        TriggerRemoteCacheModule.forRoot(),
    ],
    providers: [
        {
            provide: WorkOperationsService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkOperationsService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: NotificationService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'NotificationService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: WorkRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkRepository'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: TemplateRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TemplateRepository'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: UserTemplatePreferenceRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'UserTemplatePreferenceRepository'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: TemplateCustomizationRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TemplateCustomizationRepository'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: UserRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'UserRepository'),
            inject: [TriggerInternalApiClient],
        },
        // DataGeneratorService consumes CategoryIconService for icon enrichment (EW-357).
        // CACHE_MANAGER is provided globally via TriggerRemoteCacheModule; AiFacadeService
        // comes from TriggerFacadesModule — both deps reachable in worker scope.
        CategoryIconService,
        DataGeneratorService,
        MarkdownGeneratorService,
        WebsiteGeneratorService,
        BranchSyncService,
        WebsiteTemplateResolverService,
        WorksConfigService,
        WorksConfigWriterService,
        SourceRepoAnalyzerService,
        ImportExecutorService,
        TriggerGenerationOrchestrator,
        TriggerImportOrchestrator,
        TemplateCustomizationService,
    ],
    exports: [
        TriggerGenerationOrchestrator,
        TriggerImportOrchestrator,
        TemplateCustomizationService,
        TriggerInternalModule,
    ],
})
export class TriggerWorkerModule {}
