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
    KB_REEMBED_WORK_DISPATCHER,
    KB_TRANSCRIBE_DISPATCHER,
    RuntimeBindingStamperService,
    type KbNormalizeMediaDispatcher,
    type KbNormalizeMediaPayload,
    type KbReembedWorkDispatcher,
    type KbReembedWorkPayload,
    type KbTranscribeDispatcher,
    type KbTranscribePayload,
} from '@ever-works/agent/tasks';
import { WorkRepository } from '@ever-works/agent/database';
import { TenantJobRuntimeModule } from '../account/tenant-job-runtime/tenant-job-runtime.module';

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
        // EW-742 P3.2 T22 — RuntimeBindingStamperService for the
        // KB_REEMBED_WORK_DISPATCHER factory's enqueue-site stamping.
        TenantJobRuntimeModule,
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
        // EW-642 D7 — bind the `kb-reembed-work` dispatcher. Same
        // dynamic-import shape as the two KB media dispatchers above,
        // but unlike them this dispatcher does NOT swallow errors and
        // return `null` — a re-embed sweep that silently fails to
        // dispatch would leave a Work permanently on the old embedding
        // model with no signal to the operator. Errors propagate so
        // the caller (typically the pgvector settings-change hook, see
        // TODO in `packages/plugins/pgvector/src/pgvector.plugin.ts`)
        // can surface them as a workbench banner.
        {
            provide: KB_REEMBED_WORK_DISPATCHER,
            // EW-742 P3.2 T22 — stamp `(providerId, credentialVersion)`
            // onto the payload before forwarding to Trigger.dev. The
            // pgvector plugin call site has no tenant context (it's a
            // vendor-agnostic vector store), so the stamping happens
            // here in the host adapter where the WorkRepository +
            // stamper are reachable. Fail-open per FR-5.
            inject: [WorkRepository, RuntimeBindingStamperService],
            useFactory: (
                workRepository: WorkRepository,
                stamper: RuntimeBindingStamperService,
            ): KbReembedWorkDispatcher => {
                const factoryLogger = new Logger('KbReembedWorkDispatcher');
                return {
                    async dispatchKbReembedWork(payload: KbReembedWorkPayload): Promise<string> {
                        let providerId = payload.providerId ?? null;
                        let credentialVersion = payload.credentialVersion ?? null;
                        if (providerId === null && credentialVersion === null) {
                            try {
                                const work = await workRepository.findById(payload.workId);
                                const binding = await stamper.stamp(work?.tenantId ?? null);
                                providerId = binding.providerId;
                                credentialVersion = binding.credentialVersion;
                            } catch (err) {
                                factoryLogger.debug(
                                    `dispatchKbReembedWork: stamper lookup failed for work=${payload.workId} ` +
                                        `(${(err as Error).message}); falling back to instance default.`,
                                );
                            }
                        }
                        const stamped: KbReembedWorkPayload = {
                            ...payload,
                            providerId,
                            credentialVersion,
                        };
                        const { tasks } = await import('@trigger.dev/sdk');
                        const handle = await tasks.trigger('kb-reembed-work', stamped);
                        return handle.id;
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
