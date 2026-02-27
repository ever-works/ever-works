import { Module } from '@nestjs/common';
import { DirectoryModule } from '@ever-works/agent/services';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '@src/auth';
import { CacheEntryRepository } from '@ever-works/agent/cache';
import { TriggerModule as TasksTriggerModule } from '@ever-works/trigger-tasks';
import { WebsiteGeneratorModule } from '@ever-works/agent/generators';
import { FacadesModule } from '@ever-works/agent/facades';

// Controllers
import { DirectoriesController } from './directories.controller';
import { MembersController } from './members.controller';

// Tasks
import { DirectoryCleanupService } from './tasks/directory-cleanup.service';
import { WebsiteTemplateSchedulerService } from './tasks/website-template-scheduler.service';
import { CommunityPrSchedulerService } from './tasks/community-pr-scheduler.service';
import { ComparisonSchedulerService } from './tasks/comparison-scheduler.service';

@Module({
    imports: [
        DirectoryModule,
        DatabaseModule,
        AuthModule,
        TasksTriggerModule,
        WebsiteGeneratorModule,
        FacadesModule,
    ],
    providers: [
        CacheEntryRepository,
        DirectoryCleanupService,
        WebsiteTemplateSchedulerService,
        CommunityPrSchedulerService,
        ComparisonSchedulerService,
    ],
    controllers: [DirectoriesController, MembersController],
})
export class DirectoriesModule {}
