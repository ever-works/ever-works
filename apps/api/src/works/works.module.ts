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
import { OrganizationsModule } from '../organizations/organizations.module';

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
        // Provides OrganizationMembershipService — the reusable
        // tenant-ownership guard OrgKbController uses to authorize its
        // raw `/api/organizations/:orgId/...` routes.
        OrganizationsModule,
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
        //
        // EW-685 T4 full cutover — the three KB dispatcher tokens
        // (`KB_NORMALIZE_MEDIA_DISPATCHER`, `KB_TRANSCRIBE_DISPATCHER`,
        // `KB_REEMBED_WORK_DISPATCHER`) that used to live here as
        // custom Trigger.dev SDK adapters are now bound through the
        // EW-685 binding factory in
        // `packages/tasks/src/trigger/trigger.module.ts` — every
        // `*_DISPATCHER` symbol resolves uniformly through the
        // `JOB_RUNTIME_PROVIDER_REGISTRY`, so a future
        // `EVER_WORKS_JOB_RUNTIME` flip (BullMQ / pg-boss / Temporal)
        // swaps these three the same way it swaps the other eight.
        //
        // The previous KB_REEMBED adapter ran an enqueue-site stamping
        // pass (`RuntimeBindingStamperService.stamp(work.tenantId)`)
        // because the pgvector plugin call site has no tenant context;
        // the worker task's `TenantRuntimeBindingResolverService
        // .resolveForWork` already re-resolves the tenant from
        // `payload.workId`, so dropping the enqueue-side stamping only
        // downgrades graceful-drain detection (ADR-017 §3) for this
        // dispatcher from "fail loudly when rotated past this version"
        // to "run against current credentials" — and the re-embed task
        // is idempotent on `embedding_model` so an operator can
        // re-fire the model flip from the pgvector settings UI to
        // pick up fresh creds if drain ever bit them.
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
