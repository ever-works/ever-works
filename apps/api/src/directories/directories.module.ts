import { Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DirectoryModule } from '@ever-works/agent/services';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '@src/auth';
import { CacheEntryRepository } from '@ever-works/agent/cache';
import { TriggerModule as TasksTriggerModule } from '@ever-works/trigger-tasks';
import { WebsiteGeneratorModule } from '@ever-works/agent/generators';
import { FacadesModule } from '@ever-works/agent/facades';
import { SubscriptionsModule } from '@ever-works/agent/subscriptions';
import { ActivityLogModule } from '@ever-works/agent/activity-log';

// Controllers
import { DirectoriesController } from './directories.controller';
import { MembersController } from './members.controller';

// Tasks
import { DirectoryCleanupService } from './tasks/directory-cleanup.service';
import { WebsiteTemplateSchedulerService } from './tasks/website-template-scheduler.service';
import { CommunityPrSchedulerService } from './tasks/community-pr-scheduler.service';
import { ComparisonSchedulerService } from './tasks/comparison-scheduler.service';
import { ItemSourceValidationCronService } from './tasks/item-source-validation-scheduler.service';
import { DirectoryCacheWarmupService } from './tasks/directory-cache-warmup.service';
import { DirectoryScheduleDispatcherCronService } from './tasks/directory-schedule-dispatcher-cron.service';

@Module({
    imports: [
        DirectoryModule,
        DatabaseModule,
        AuthModule,
        TasksTriggerModule,
        WebsiteGeneratorModule,
        FacadesModule,
        SubscriptionsModule,
        ActivityLogModule,
    ],
    providers: [
        CacheEntryRepository,
        DirectoryCleanupService,
        WebsiteTemplateSchedulerService,
        CommunityPrSchedulerService,
        ComparisonSchedulerService,
        ItemSourceValidationCronService,
        DirectoryCacheWarmupService,
        DirectoryScheduleDispatcherCronService,
        DistributedTaskLockService,
    ],
    controllers: [DirectoriesController, MembersController],
})
export class DirectoriesModule {}
