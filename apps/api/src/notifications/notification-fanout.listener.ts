import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    NOTIFICATION_FANOUT_EVENT,
    type NotificationFanoutEvent,
    UserNotificationSubscriptionService,
} from '@ever-works/agent/notifications';
import {
    NotificationChannelFacadeService,
    type ResolvedChannelTarget,
} from '@ever-works/agent/facades';

/**
 * EW-664 / EW-678 / T20 + T22 — Producer fanout listener.
 *
 * Subscribes to `NOTIFICATION_FANOUT_EVENT` (emitted by every v1
 * `notify*` producer in `packages/agent/src/notifications/notification.service.ts`)
 * and forwards the payload to the multi-channel facade.
 *
 * Channel resolution delegates to `UserNotificationSubscriptionService.resolveChannels`
 * (T22) — full fallback chain (subscription → event defaults → in-app)
 * plus category-mute + quiet-hours filtering.
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
        @Optional() private readonly subscriptions?: UserNotificationSubscriptionService,
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
     * Delegates to the full resolver (T22): subscription → event
     * defaults → in-app fallback, with category-mute + quiet-hours
     * filtering applied. Returns ['in-app'] as a safe default if the
     * resolver isn't wired (in-app is already covered by v1's
     * NotificationService.create, so the channel facade treats it as a
     * no-op sentinel).
     */
    private async resolveChannelIds(
        userId: string,
        eventKey: string,
    ): Promise<ResolvedChannelTarget[]> {
        if (!this.subscriptions) return [];
        try {
            const plan = await this.subscriptions.resolvePlan(userId, eventKey);
            // Drop the 'in-app' sentinel before fanout — in-app delivery
            // already happened in the v1 producer's create() call; the
            // channel facade only handles the external channels. Deferred
            // (quiet-hours) channels carry `deferUntil` so the facade
            // enqueues them on the Trigger.dev delivery task with that delay.
            const immediate = plan.immediate
                .filter((c) => c !== 'in-app')
                .map((channelId) => ({ channelId }));
            const deferred = plan.deferred
                .filter((c) => c !== 'in-app')
                .map((channelId) => ({ channelId, deferUntil: plan.deferUntil }));
            return [...immediate, ...deferred];
        } catch (err) {
            this.logger.debug(
                `Subscription resolver fallback to [] for user=${userId} event=${eventKey}: ${String(err)}`,
            );
            return [];
        }
    }
}
