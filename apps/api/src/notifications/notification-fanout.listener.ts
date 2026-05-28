import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    NOTIFICATION_FANOUT_EVENT,
    type NotificationFanoutEvent,
} from '@ever-works/agent/notifications';
import { NotificationChannelFacadeService } from '@ever-works/agent/facades';
import { NotificationPreferencesService } from './notification-preferences.service';

/**
 * EW-664 / EW-678 / T20 — Producer fanout listener.
 *
 * Subscribes to `NOTIFICATION_FANOUT_EVENT` (emitted by every v1
 * `notify*` producer in `packages/agent/src/notifications/notification.service.ts`)
 * and forwards the payload to the multi-channel facade.
 *
 * Channel resolution today uses the `user_notification_subscriptions`
 * table directly — a thin wrapper that returns the rows' `channelIds`
 * array. The full quiet-hours + category-mute + org-defaults resolver
 * lives in `UserNotificationSubscriptionService` and lands in T22; this
 * listener swaps to it without touching the v1 producers.
 *
 * Hard-rule additive: v1 in-app delivery via NotificationService.create
 * is untouched. Fanout is layered on top and failures here NEVER
 * propagate back to the originating producer.
 */
@Injectable()
export class NotificationFanoutListener {
    private readonly logger = new Logger(NotificationFanoutListener.name);

    constructor(
        @Optional() private readonly channelFacade?: NotificationChannelFacadeService,
        @Optional() private readonly preferences?: NotificationPreferencesService,
    ) {}

    @OnEvent(NOTIFICATION_FANOUT_EVENT, { async: true, suppressErrors: true })
    async handleFanout(payload: NotificationFanoutEvent): Promise<void> {
        if (!this.channelFacade) {
            this.logger.debug('Channel facade not configured; skipping multi-channel fanout');
            return;
        }
        try {
            const results = await this.channelFacade.send(
                payload.userId,
                payload.eventKey,
                {
                    text: `${payload.title}: ${payload.message}`,
                    messageRef: `${payload.eventKey}-${payload.userId}-${Date.now()}`,
                    eventType: payload.eventKey,
                },
                (userId, eventKey) => this.resolveChannelIds(userId, eventKey),
                { userId: payload.userId },
            );
            const delivered = results.filter((r) => r.status === 'delivered').length;
            const failed = results.length - delivered;
            this.logger.log(
                `Fanout for user=${payload.userId} event=${payload.eventKey}: ${delivered} delivered, ${failed} failed`,
            );
        } catch (err) {
            this.logger.error(
                `Fanout failed for user=${payload.userId} event=${payload.eventKey}`,
                err instanceof Error ? err.stack : String(err),
            );
        }
    }

    /**
     * Thin channel-resolver. Today: returns `user_notification_subscriptions.channelIds`
     * for the (user, event) row, or [] when no subscription is configured.
     * T22 will replace this with `UserNotificationSubscriptionService.resolveChannels`
     * which adds quiet-hours, category mutes, and organisation defaults.
     */
    private async resolveChannelIds(userId: string, eventKey: string): Promise<string[]> {
        if (!this.preferences) return [];
        try {
            const view = await this.preferences.getPreferences(userId);
            const sub = view.subscriptions.find((s) => s.eventTypeKey === eventKey);
            return sub?.channelIds ?? [];
        } catch (err) {
            this.logger.debug(
                `Subscription resolver fallback to [] for user=${userId} event=${eventKey}: ${String(err)}`,
            );
            return [];
        }
    }
}
