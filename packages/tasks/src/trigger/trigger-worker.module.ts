import { Module } from '@nestjs/common';
import { DirectoryOperationsService } from '@ever-works/agent/directory-operations';
import { NotificationService } from '@ever-works/agent/notifications';
import { DataGeneratorService } from '@ever-works/agent/generators';
import { MarkdownGeneratorService } from '@ever-works/agent/generators';
import { WebsiteGeneratorService, BranchSyncService } from '@ever-works/agent/generators';
import {
    SourceRepoAnalyzerService,
    AwesomeReadmeParserService,
    ImportExecutorService,
} from '@ever-works/agent/import';
import { TriggerPluginsModule } from './plugins/trigger-plugins.module';
import { TriggerFacadesModule } from './plugins/trigger-facades.module';
import { TriggerPipelineModule } from './plugins/trigger-pipeline.module';
import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerInternalApiClient } from './trigger-internal-api.client';
import { createRemoteProxy } from './plugins/remote-proxy';
import { TriggerGenerationOrchestrator } from './trigger-generation.orchestrator';
import { TriggerImportOrchestrator } from './trigger-import.orchestrator';
import { TriggerCacheFactory } from './cache/cache.factory';

@Module({
    imports: [
        TriggerPluginsModule.forRoot(),
        TriggerFacadesModule,
        TriggerPipelineModule,
        TriggerInternalModule,
        TriggerCacheFactory.register({ isGlobal: true }),
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
        DataGeneratorService,
        MarkdownGeneratorService,
        WebsiteGeneratorService,
        BranchSyncService,
        SourceRepoAnalyzerService,
        AwesomeReadmeParserService,
        ImportExecutorService,
        TriggerGenerationOrchestrator,
        TriggerImportOrchestrator,
    ],
    exports: [TriggerGenerationOrchestrator, TriggerImportOrchestrator, TriggerInternalModule],
})
export class TriggerWorkerModule {}
