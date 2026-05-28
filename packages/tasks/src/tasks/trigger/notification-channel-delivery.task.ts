import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import {
    NotificationChannelFacadeService,
    type NotificationChannelDeliveryPayload,
} from '@ever-works/agent/facades';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * Notifications v2 (EW-663) — per-channel notification delivery worker.
 *
 * One run per (channel, event) pair. The producer-side dispatcher
 * (`NotificationChannelFacadeService.send` → the bound
 * `NotificationChannelDeliveryDispatcher` adapter →
 * `TriggerService.dispatchNotificationChannelDelivery`) enqueues this
 * task; quiet-hours-deferred sends are enqueued with a `delay` so the
 * run fires at end-of-window (item D).
 *
 * The run boots the lightweight {@link TriggerInternalModule} and calls
 * the RPC-proxied {@link NotificationChannelFacadeService.deliverToChannelOrThrow}
 * on the live API (where the channel plugins are already loaded). That
 * method THROWS on a failed attempt, which surfaces here so the
 * Trigger.dev retry policy below re-runs it. When attempts exhaust, the
 * `notification_channel_delivery_log` row left by the facade is the
 * dead-letter.
 *
 * Backoff: 30s → 2m → 8m → 32m → 2h (maxAttempts 5, factor 4) — shorter
 * tail than webhook delivery; a chat/email notification has little value
 * a full day late.
 */
export const notificationChannelDeliveryTask = task<
    'notification-channel-delivery',
    NotificationChannelDeliveryPayload
>({
    id: 'notification-channel-delivery',
    maxDuration: 5 * 60,
    retry: {
        maxAttempts: 5,
        minTimeoutInMs: 30_000, // 30s
        maxTimeoutInMs: 6 * 60 * 60 * 1000, // 6h cap
        factor: 4,
        randomize: true,
    },
    run: async (payload: NotificationChannelDeliveryPayload) => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('NotificationChannelDelivery'));

        try {
            const facade = appContext.get(NotificationChannelFacadeService);
            const result = await facade.deliverToChannelOrThrow(
                payload.channelId,
                {
                    text: payload.text,
                    rich: payload.rich,
                    messageRef: payload.messageRef,
                    eventType: payload.eventType,
                },
                payload.options,
                payload.eventType,
            );
            return {
                channelId: payload.channelId,
                status: result.status,
                pluginId: result.pluginId,
                providerMessageId: result.providerMessageId ?? null,
            };
        } finally {
            await appContext.close();
        }
    },
});
