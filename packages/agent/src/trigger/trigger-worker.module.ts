import { Module } from '@nestjs/common';
import { TriggerItemsGeneratorModule } from './trigger-items-generator.module';
import { TriggerInternalApiClient } from './trigger-internal-api.client';
import { RemoteDirectoryOperationsService } from './remote-directory-operations.service';
import { DIRECTORY_OPERATIONS } from '@src/directory-operations';
import { DataGeneratorService } from '@src/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/website-generator/website-generator.service';
import { GitModule } from '@src/git/git.module';
import { TriggerGenerationOrchestrator } from './trigger-generation.orchestrator';
import { DirectoryModule } from '@src/services';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
    imports: [
        TriggerItemsGeneratorModule,
        GitModule,
        DirectoryModule,
        EventEmitterModule.forRoot(),
    ],
    providers: [
        TriggerInternalApiClient,
        RemoteDirectoryOperationsService,
        {
            provide: DIRECTORY_OPERATIONS,
            useExisting: RemoteDirectoryOperationsService,
        },
        DataGeneratorService,
        MarkdownGeneratorService,
        WebsiteGeneratorService,
        TriggerGenerationOrchestrator,
    ],
    exports: [TriggerGenerationOrchestrator, TriggerInternalApiClient],
})
export class TriggerWorkerModule {}
