import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DIRECTORY_OPERATIONS } from '@packages/agent/directory-operations';
import { NOTIFICATION_OPERATIONS } from '@packages/agent/notification-operations';
import { DataGeneratorService } from '@packages/agent/generators';
import { MarkdownGeneratorService } from '@packages/agent/generators';
import { WebsiteGeneratorService } from '@packages/agent/generators';
import {
    SourceRepoAnalyzerService,
    AwesomeReadmeParserService,
    ImportExecutorService,
} from '@packages/agent/import';
import { FacadesModule } from '@packages/agent/facades';
import { TriggerItemsGeneratorModule } from './trigger-items-generator.module';
import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerAiModule } from './trigger-ai.module';
import { RemoteDirectoryOperationsService } from './remote-directory-operations.service';
import { RemoteNotificationOperationsService } from './remote-notification-operations.service';
import { TriggerGenerationOrchestrator } from './trigger-generation.orchestrator';
import { TriggerImportOrchestrator } from './trigger-import.orchestrator';
import { TriggerCacheFactory } from './cache/cache.factory';

@Module({
    imports: [
        TriggerItemsGeneratorModule,
        TriggerAiModule,
        FacadesModule,
        EventEmitterModule.forRoot(),
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
        SourceRepoAnalyzerService,
        AwesomeReadmeParserService,
        ImportExecutorService,
        TriggerGenerationOrchestrator,
        TriggerImportOrchestrator,
    ],
    exports: [TriggerGenerationOrchestrator, TriggerImportOrchestrator, TriggerInternalModule],
})
export class TriggerWorkerModule {}
