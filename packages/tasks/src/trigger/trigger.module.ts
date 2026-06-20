import { Global, Module } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import { TriggerJobRuntimeProvider } from './trigger-job-runtime.provider';
import {
    WORK_GENERATION_DISPATCHER,
    WORK_IMPORT_DISPATCHER,
    TEMPLATE_CUSTOMIZATION_DISPATCHER,
    WEBHOOK_DELIVERY_DISPATCHER,
    KB_MIRROR_DOCUMENT_DISPATCHER,
    KB_BACKFILL_SKELETON_DISPATCHER,
    KB_EMBED_DOCUMENT_DISPATCHER,
    KB_ORG_OVERLAY_FANOUT_DISPATCHER,
    JOB_RUNTIME_PROVIDER_REGISTRY,
    InMemoryJobRuntimeProviderRegistry,
    buildJobRuntimeProviders,
} from '@ever-works/agent/tasks';
import {
    NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER,
    type NotificationChannelDeliveryDispatcher,
    type NotificationChannelDeliveryPayload,
} from '@ever-works/agent/facades';

/**
 * EW-685 T4 cutover — the 8 dispatcher symbols TriggerModule owns. The
 * remaining 3 (`KB_NORMALIZE_MEDIA_DISPATCHER`, `KB_TRANSCRIBE_DISPATCHER`,
 * `KB_REEMBED_WORK_DISPATCHER`) are bound separately in
 * `apps/api/src/works/works.module.ts` under custom Trigger.dev SDK
 * adapters with soft-error contracts (each call returns `null` on
 * dispatch failure → the slice-5 reconciliation cron catches the drift).
 * Consolidating those 3 onto TriggerService.dispatchers — and thus
 * routing them through this same factory — is a follow-up PR; the partial
 * cutover here proves the architecture without touching the
 * soft-error path.
 */
const TRIGGER_OWNED_DISPATCHER_SYMBOLS = [
    WORK_GENERATION_DISPATCHER,
    WORK_IMPORT_DISPATCHER,
    TEMPLATE_CUSTOMIZATION_DISPATCHER,
    WEBHOOK_DELIVERY_DISPATCHER,
    KB_MIRROR_DOCUMENT_DISPATCHER,
    KB_BACKFILL_SKELETON_DISPATCHER,
    KB_EMBED_DOCUMENT_DISPATCHER,
    KB_ORG_OVERLAY_FANOUT_DISPATCHER,
] as const;

@Global()
@Module({
    providers: [
        TriggerService,
        // EW-686 P1 — adapter exposing TriggerService through the
        // pluggable IJobRuntimeProvider contract. The registry below
        // registers it as the active provider at boot.
        TriggerJobRuntimeProvider,
        // EW-685 T4 cutover — the in-memory registry + active-provider
        // registration. `JOB_RUNTIME_PROVIDER_REGISTRY` is the DI token
        // every `*_DISPATCHER` binding (below) injects through.
        //
        // Runtime no-op vs the old `useExisting: TriggerService` bindings:
        // `TriggerService.dispatchers` is literally `this as unknown as
        // JobRuntimeDispatchers` (see trigger.service.ts), so the
        // resolved injection is the same TriggerService instance. Every
        // existing `@Inject(WORK_GENERATION_DISPATCHER) dispatcher`
        // continues to receive the same object — no call-site changes.
        //
        // What the indirection BUYS: when the EW-742 P3 tenant-aware
        // resolver replaces `InMemoryJobRuntimeProviderRegistry` with a
        // per-request resolver, the binding sites stay identical. And
        // when the operator flips `EVER_WORKS_JOB_RUNTIME=bullmq`, the
        // registry hands out the BullMQ provider's dispatchers map
        // instead — without redeploying or editing this file.
        {
            provide: JOB_RUNTIME_PROVIDER_REGISTRY,
            useFactory: (adapter: TriggerJobRuntimeProvider) => {
                const registry = new InMemoryJobRuntimeProviderRegistry();
                registry.register(adapter);
                return registry;
            },
            inject: [TriggerJobRuntimeProvider],
        },
        // EW-685 T4 cutover — the 8 dispatcher symbols TriggerModule owns,
        // now bound via the registry. See TRIGGER_OWNED_DISPATCHER_SYMBOLS
        // header for the deferred 3.
        ...buildJobRuntimeProviders({ symbols: TRIGGER_OWNED_DISPATCHER_SYMBOLS }),
        // Notifications v2 (EW-663) — the facade's delivery dispatcher
        // contract is `enqueue(payload) → { runId }`, so a thin adapter
        // bridges to TriggerService.dispatchNotificationChannelDelivery
        // (which returns the run id, or null when Trigger is disabled →
        // the facade falls back to in-process delivery).
        //
        // NOT routed through the binding factory because its method
        // shape (`enqueue` returning `{ runId }`) differs from the
        // `JobRuntimeDispatchers` `dispatchXxx → string | null` shape
        // every other `*_DISPATCHER` symbol exposes. Migrating it
        // onto the registry would require either widening the contract
        // or adding a wrapper layer — neither is in scope here.
        {
            provide: NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER,
            useFactory: (trigger: TriggerService): NotificationChannelDeliveryDispatcher => ({
                async enqueue(payload: NotificationChannelDeliveryPayload) {
                    return { runId: await trigger.dispatchNotificationChannelDelivery(payload) };
                },
            }),
            inject: [TriggerService],
        },
    ],
    exports: [
        TriggerService,
        TriggerJobRuntimeProvider,
        // The registry is exported so EW-742 P3 (tenant-aware resolver)
        // can replace it without re-importing the whole TriggerModule.
        JOB_RUNTIME_PROVIDER_REGISTRY,
        WORK_GENERATION_DISPATCHER,
        WORK_IMPORT_DISPATCHER,
        TEMPLATE_CUSTOMIZATION_DISPATCHER,
        WEBHOOK_DELIVERY_DISPATCHER,
        KB_MIRROR_DOCUMENT_DISPATCHER,
        KB_BACKFILL_SKELETON_DISPATCHER,
        KB_EMBED_DOCUMENT_DISPATCHER,
        KB_ORG_OVERLAY_FANOUT_DISPATCHER,
        NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER,
    ],
})
export class TriggerModule {}
