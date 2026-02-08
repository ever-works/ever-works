import { Global, Module, DynamicModule } from '@nestjs/common';
import { DirectoryOperationsService } from '@ever-works/agent/directory-operations';
import { DirectoryRepository } from '@ever-works/agent/database';
import { NotificationService } from '@ever-works/agent/notifications';
import { CACHE_MANAGER } from '@ever-works/agent/cache';
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

/**
 * Global module that provides CACHE_MANAGER via remote proxy to the API.
 * Replaces TriggerCacheFactory + InternalAPIAdapter with the generic remote-call mechanism.
 */
@Global()
@Module({})
class TriggerRemoteCacheModule {
    static forRoot(): DynamicModule {
        return {
            module: TriggerRemoteCacheModule,
            global: true,
            imports: [TriggerInternalModule],
            providers: [
                {
                    provide: CACHE_MANAGER,
                    useFactory: (apiClient: TriggerInternalApiClient) =>
                        createRemoteProxy(apiClient, 'CacheManager'),
                    inject: [TriggerInternalApiClient],
                },
            ],
            exports: [CACHE_MANAGER],
        };
    }
}

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
        AwesomeReadmeParserService,
        ImportExecutorService,
        TriggerGenerationOrchestrator,
        TriggerImportOrchestrator,
    ],
    exports: [TriggerGenerationOrchestrator, TriggerImportOrchestrator, TriggerInternalModule],
})
export class TriggerWorkerModule {}
