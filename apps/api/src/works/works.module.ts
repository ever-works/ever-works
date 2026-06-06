import { Module, Logger } from '@nestjs/common';
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
import {
    KB_NORMALIZE_MEDIA_DISPATCHER,
    KB_TRANSCRIBE_DISPATCHER,
    type KbNormalizeMediaDispatcher,
    type KbNormalizeMediaPayload,
    type KbTranscribeDispatcher,
    type KbTranscribePayload,
} from '@ever-works/agent/tasks';

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
        // EW-643 Phase 3 slice 2c — bind the two KB media-pipeline
        // dispatcher tokens (`KB_NORMALIZE_MEDIA_DISPATCHER` +
        // `KB_TRANSCRIBE_DISPATCHER`) so `KnowledgeBaseService` (which
        // injects them `@Optional()`) actually receives a live
        // dispatcher in this deployment. We use a `useFactory` that
        // dynamically imports `@trigger.dev/sdk` and the matching
        // task module, calls `tasks.trigger(<id>, payload)`, and
        // returns the Trigger.dev run id — mirroring the
        // `agentTaskExecuteTriggerAdapter` style used by the
        // platform's `TasksModule` (apps/api/src/tasks/tasks.module.ts).
        //
        // The dynamic import keeps `@trigger.dev/sdk` out of the
        // import graph at module-load time, so unit tests that
        // construct `WorksModule` without Trigger.dev configured do
        // not crash on a missing peer. Each adapter swallows its
        // dispatch errors + returns `null`, matching the existing
        // `KbNormalizeMediaDispatcher` / `KbTranscribeDispatcher`
        // contracts (a `null` is a soft failure the slice-5
        // reconciliation job catches).
        {
            provide: KB_NORMALIZE_MEDIA_DISPATCHER,
            useFactory: (): KbNormalizeMediaDispatcher => {
                const logger = new Logger('KbNormalizeMediaDispatcher');
                return {
                    async dispatchKbNormalizeMedia(
                        payload: KbNormalizeMediaPayload,
                    ): Promise<string | null> {
                        try {
                            const { tasks } = await import('@trigger.dev/sdk');
                            const taskId =
                                payload.mediaKind === 'video'
                                    ? 'kb-normalize-video'
                                    : 'kb-normalize-audio';
                            const handle = await tasks.trigger(taskId, payload);
                            return handle.id;
                        } catch (error) {
                            logger.warn(
                                `Failed to dispatch kb-normalize-${payload.mediaKind} for upload ${payload.uploadId}: ${(error as Error).message}`,
                            );
                            return null;
                        }
                    },
                };
            },
        },
        {
            provide: KB_TRANSCRIBE_DISPATCHER,
            useFactory: (): KbTranscribeDispatcher => {
                const logger = new Logger('KbTranscribeDispatcher');
                return {
                    async dispatchKbTranscribe(
                        payload: KbTranscribePayload,
                    ): Promise<string | null> {
                        try {
                            const { tasks } = await import('@trigger.dev/sdk');
                            const handle = await tasks.trigger('kb-transcribe', payload);
                            return handle.id;
                        } catch (error) {
                            logger.warn(
                                `Failed to dispatch kb-transcribe for upload ${payload.uploadId}: ${(error as Error).message}`,
                            );
                            return null;
                        }
                    },
                };
            },
        },
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
