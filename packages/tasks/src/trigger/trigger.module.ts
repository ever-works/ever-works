import { Global, Module } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import {
    WORK_GENERATION_DISPATCHER,
    WORK_IMPORT_DISPATCHER,
    TEMPLATE_CUSTOMIZATION_DISPATCHER,
    WEBHOOK_DELIVERY_DISPATCHER,
    KB_MIRROR_DOCUMENT_DISPATCHER,
    KB_BACKFILL_SKELETON_DISPATCHER,
    KB_EMBED_DOCUMENT_DISPATCHER,
    KB_ORG_OVERLAY_FANOUT_DISPATCHER,
} from '@ever-works/agent/tasks';
import {
    NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER,
    type NotificationChannelDeliveryDispatcher,
    type NotificationChannelDeliveryPayload,
} from '@ever-works/agent/facades';

@Global()
@Module({
    providers: [
        TriggerService,
        {
            provide: WORK_GENERATION_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: WORK_IMPORT_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: TEMPLATE_CUSTOMIZATION_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: WEBHOOK_DELIVERY_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: KB_MIRROR_DOCUMENT_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: KB_BACKFILL_SKELETON_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: KB_EMBED_DOCUMENT_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: KB_ORG_OVERLAY_FANOUT_DISPATCHER,
            useExisting: TriggerService,
        },
        // Notifications v2 (EW-663) — the facade's delivery dispatcher
        // contract is `enqueue(payload) → { runId }`, so a thin adapter
        // bridges to TriggerService.dispatchNotificationChannelDelivery
        // (which returns the run id, or null when Trigger is disabled →
        // the facade falls back to in-process delivery).
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
