import { Injectable, NotFoundException } from '@nestjs/common';
import { WebhookDeliveryRepository } from '@ever-works/agent/database';
import { WebhookEventDispatcherService } from './webhook-event-dispatcher.service';
import { WebhooksService } from './webhooks.service';

export interface WebhookDeliveryView {
    readonly id: string;
    readonly subscriptionId: string;
    readonly event: string;
    readonly status: 'pending' | 'delivered' | 'failed' | 'retrying';
    readonly attempts: number;
    readonly lastResponseStatus: number | null;
    readonly lastOutcome: string | null;
    readonly lastError: string | null;
    readonly durationMs: number | null;
    readonly triggerRunId: string | null;
    readonly lastAttemptAt: Date | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/**
 * Read + replay surface for `webhook_deliveries`.
 *
 *  - `list(accountId, opts)` powers `GET /api/webhooks/deliveries`.
 *  - `testFire(accountId, subscriptionId)` powers `POST /api/webhooks/:id/test`.
 *  - `redeliver(accountId, deliveryId)` powers `POST /api/webhooks/deliveries/:id/redeliver`.
 *
 * The list / redeliver paths scope by `accountId` at the repository call
 * site so a controller bug couldn't accidentally leak another account's
 * delivery rows.
 */
@Injectable()
export class WebhooksDeliveriesService {
    constructor(
        private readonly deliveries: WebhookDeliveryRepository,
        private readonly dispatcher: WebhookEventDispatcherService,
        private readonly subscriptions: WebhooksService,
    ) {}

    async list(
        accountId: string,
        opts: { limit?: number; subscriptionId?: string } = {},
    ): Promise<WebhookDeliveryView[]> {
        const rows = await this.deliveries.listForAccount(accountId, opts);
        return rows.map((row) => ({
            id: row.id,
            subscriptionId: row.subscriptionId,
            event: row.event,
            status: row.status,
            attempts: row.attempts,
            lastResponseStatus: row.lastResponseStatus,
            lastOutcome: row.lastOutcome,
            lastError: row.lastError,
            durationMs: row.durationMs,
            triggerRunId: row.triggerRunId,
            lastAttemptAt: row.lastAttemptAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        }));
    }

    async testFire(accountId: string, subscriptionId: string) {
        // Resolve via WebhooksService so the cross-account check + 404-cover
        // happens at the canonical place.
        await this.subscriptions.findOwnEntity(accountId, subscriptionId);
        return this.dispatcher.dispatchTestFire({ subscriptionId, accountId });
    }

    async redeliver(accountId: string, originalDeliveryId: string) {
        const res = await this.dispatcher.redeliver({ originalDeliveryId, accountId });
        if (!res.enqueued) {
            throw new NotFoundException('Webhook delivery not found');
        }
        return res;
    }
}
