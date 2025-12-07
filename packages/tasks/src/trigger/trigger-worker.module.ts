import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DirectoryModule } from '@packages/agent/services';
import { DIRECTORY_OPERATIONS } from '@packages/agent/directory-operations';
import { DataGeneratorService } from '@packages/agent/data-generator';
import { MarkdownGeneratorService } from '@packages/agent/markdown-generator';
import { WebsiteGeneratorService } from '@packages/agent/website-generator';
import { GitModule } from '@packages/agent/git';
import { TriggerItemsGeneratorModule } from './trigger-items-generator.module';
import { TriggerInternalModule } from './trigger-internal.module';
import { RemoteDirectoryOperationsService } from './remote-directory-operations.service';
import { TriggerGenerationOrchestrator } from './trigger-generation.orchestrator';
import { TriggerCacheFactory } from './cache/cache.factory';

@Module({
    imports: [
        TriggerItemsGeneratorModule,
        GitModule,
        DirectoryModule,
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
        DataGeneratorService,
        MarkdownGeneratorService,
        WebsiteGeneratorService,
        TriggerGenerationOrchestrator,
    ],
    exports: [TriggerGenerationOrchestrator, TriggerInternalModule],
})
export class TriggerWorkerModule {}
