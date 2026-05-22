import { Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { KnowledgeBaseModule, WorkModule } from '@ever-works/agent/services';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '@src/auth';
import { CacheEntryRepository } from '@ever-works/agent/cache';
import { TriggerModule as TasksTriggerModule } from '@ever-works/trigger-tasks';
import { WebsiteGeneratorModule } from '@ever-works/agent/generators';
import { FacadesModule } from '@ever-works/agent/facades';
import { SubscriptionsModule } from '@ever-works/agent/subscriptions';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { ItemsGeneratorModule } from '@ever-works/agent/items-generator';
import { ActivityFeedModule } from './activity-feed/activity-feed.module';

// Controllers
import { WorksController } from './works.controller';
import { MembersController } from './members.controller';
import { InvitationsController } from './invitations.controller';
import { BulkItemsController } from './bulk-items.controller';
import { KbController } from './kb.controller';
import { OrgKbController } from './org-kb.controller';

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
        ActivityFeedModule,
        KnowledgeBaseModule,
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
        // EW-641 1B/b — the KB upload pipeline's storage plugin token
        // (`KB_STORAGE_PLUGIN`) is now provided by the `@Global()`
        // `KbStorageModule` (apps/api/src/uploads/kb-storage.module.ts),
        // imported once at the api.module.ts level. The original
        // in-module provider here only bound the token within
        // `WorksModule`'s scope, which `KnowledgeBaseModule` (imported,
        // not consumer) couldn't see — so `KnowledgeBaseService.storage`
        // silently injected `undefined` and every upload returned 503.
        // See the docstring on `KbStorageModule` for the DI walk.
    ],
    controllers: [
        WorksController,
        MembersController,
        InvitationsController,
        BulkItemsController,
        KbController,
        OrgKbController,
    ],
})
export class WorksModule {}
