import { Module } from '@nestjs/common';
import { DIRECTORY_OPERATIONS } from '@ever-works/agent/directory-operations';
import { NOTIFICATION_OPERATIONS } from '@ever-works/agent/notification-operations';
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
import { RemoteDirectoryOperationsService } from './remote-directory-operations.service';
import { RemoteNotificationOperationsService } from './remote-notification-operations.service';
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
        RemoteDirectoryOperationsService,
        {
            provide: DIRECTORY_OPERATIONS,
            useExisting: RemoteDirectoryOperationsService,
        },
        RemoteNotificationOperationsService,
        {
            provide: NOTIFICATION_OPERATIONS,
            useExisting: RemoteNotificationOperationsService,
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
