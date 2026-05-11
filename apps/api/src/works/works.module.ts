import { Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { WorkModule } from '@ever-works/agent/services';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '@src/auth';
import { CacheEntryRepository } from '@ever-works/agent/cache';
import { TriggerModule as TasksTriggerModule } from '@ever-works/trigger-tasks';
import { WebsiteGeneratorModule } from '@ever-works/agent/generators';
import { FacadesModule } from '@ever-works/agent/facades';
import { SubscriptionsModule } from '@ever-works/agent/subscriptions';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { ItemsGeneratorModule } from '@ever-works/agent/items-generator';

// Controllers
import { WorksController } from './works.controller';
import { MembersController } from './members.controller';

// Tasks
import { WorkCleanupService } from './tasks/work-cleanup.service';
import { WebsiteTemplateSchedulerService } from './tasks/website-template-scheduler.service';
import { CommunityPrSchedulerService } from './tasks/community-pr-scheduler.service';
import { ComparisonSchedulerService } from './tasks/comparison-scheduler.service';
import { ItemSourceValidationCronService } from './tasks/item-source-validation-scheduler.service';
import { WorkCacheWarmupService } from './tasks/work-cache-warmup.service';
import { WorkScheduleDispatcherCronService } from './tasks/work-schedule-dispatcher-cron.service';

@Module({
    imports: [
        WorkModule,
        DatabaseModule,
        AuthModule,
        TasksTriggerModule,
        WebsiteGeneratorModule,
        FacadesModule,
        SubscriptionsModule,
        ActivityLogModule,
        ItemsGeneratorModule,
    ],
    providers: [
        CacheEntryRepository,
        WorkCleanupService,
        WebsiteTemplateSchedulerService,
        CommunityPrSchedulerService,
        ComparisonSchedulerService,
        ItemSourceValidationCronService,
        WorkCacheWarmupService,
        WorkScheduleDispatcherCronService,
        DistributedTaskLockService,
    ],
    controllers: [WorksController, MembersController],
})
export class WorksModule {}
