import { ScheduleModule } from '@nestjs/schedule';
import { Module } from '@nestjs/common';
import { DirectoryModule } from '@packages/agent/services';
import { DatabaseModule } from '@packages/agent/database';
import { AuthModule } from '@src/auth';
import { AiModule } from '@packages/agent/ai';
import { CacheEntryRepository } from '@packages/agent/cache';
import { TriggerModule as TasksTriggerModule } from '@packages/tasks';
import { WebsiteGeneratorModule } from '@packages/agent/generators';
import { FacadesModule } from '@packages/agent/facades';

// Controllers
import { DirectoriesController } from './directories.controller';
import { MembersController } from './members.controller';

// Tasks
import { DirectoryCleanupService } from './tasks/directory-cleanup.service';
import { WebsiteTemplateSchedulerService } from './tasks/website-template-scheduler.service';

@Module({
    imports: [
        DirectoryModule,
        DatabaseModule,
        AuthModule,
        AiModule,
        TasksTriggerModule,
        WebsiteGeneratorModule,
        FacadesModule,
        ScheduleModule.forRoot(),
    ],
    providers: [CacheEntryRepository, DirectoryCleanupService, WebsiteTemplateSchedulerService],
    controllers: [DirectoriesController, MembersController],
})
export class DirectoriesModule {}
