import { Module } from '@nestjs/common';
import { DirectoryOperationsService } from '@ever-works/agent/directory-operations';
import { DirectoryRepository } from '@ever-works/agent/database';
import { NotificationService } from '@ever-works/agent/notifications';
import { DataGeneratorService } from '@ever-works/agent/generators';
import { MarkdownGeneratorService } from '@ever-works/agent/generators';
import { WebsiteGeneratorService, BranchSyncService } from '@ever-works/agent/generators';
import { SourceRepoAnalyzerService, ImportExecutorService } from '@ever-works/agent/import';
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
            provide: DirectoryOperationsService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'DirectoryOperationsService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: NotificationService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'NotificationService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: DirectoryRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'DirectoryRepository'),
            inject: [TriggerInternalApiClient],
        },
        DataGeneratorService,
        MarkdownGeneratorService,
        WebsiteGeneratorService,
        BranchSyncService,
        SourceRepoAnalyzerService,
        ImportExecutorService,
        TriggerGenerationOrchestrator,
        TriggerImportOrchestrator,
    ],
    exports: [TriggerGenerationOrchestrator, TriggerImportOrchestrator, TriggerInternalModule],
})
export class TriggerWorkerModule {}
