import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    WebhookDeliveryRepository,
    WebhookSubscriptionRepository,
} from '@ever-works/agent/database';
import { WebhookSubscriptionDeliveryService } from '@ever-works/agent/services';
import {
    WebhookDeliveryPayload,
    WebhookDeliveryDispatcher,
    WEBHOOK_DELIVERY_DISPATCHER,
} from '@ever-works/agent/tasks';
import {
    WorkCreatedEvent,
    WorkGenerationCompletedEvent,
    DeploymentDispatchedEvent,
    DeploymentCompletedEvent,
    DeploymentFailedEvent,
} from '@ever-works/agent/events';
import { Work } from '@ever-works/agent/entities';

/**
 * Producer-side fanout for outbound webhook subscriptions.
 *
 * Listens to the platform's existing EventEmitter2 events, looks up the
 * active subscriptions for the owning account (scoped to the affected
 * Work when applicable), creates a `webhook_deliveries` pending row per
 * subscription, then enqueues a Trigger.dev `webhook-delivery` task — or
 * runs the orchestrator in-process when Trigger.dev is not configured
 * (single-instance dev environment).
 *
 * Each handler is wrapped in a top-level try/catch: webhook fanout MUST
 * NEVER reject an upstream event (would block activity-log writes, kill
 * deploy flows, etc.). Failures are logged and swallowed.
 */
@Injectable()
export class WebhookEventDispatcherService {
    private readonly logger = new Logger(WebhookEventDispatcherService.name);

    constructor(
        private readonly subscriptions: WebhookSubscriptionRepository,
        private readonly deliveries: WebhookDeliveryRepository,
        private readonly orchestrator: WebhookSubscriptionDeliveryService,
        @Optional()
        @Inject(WEBHOOK_DELIVERY_DISPATCHER)
        private readonly remoteDispatcher: WebhookDeliveryDispatcher | null = null,
    ) {}

    @OnEvent(WorkCreatedEvent.EVENT_NAME)
    async onWorkCreated(event: WorkCreatedEvent): Promise<void> {
        await this.fanoutWorkEvent('work.created', event.work, {
            workId: event.work.id,
            workName: event.work.name,
        });
    }

    @OnEvent(WorkGenerationCompletedEvent.EVENT_NAME)
    async onGenerationCompleted(event: WorkGenerationCompletedEvent): Promise<void> {
        await this.fanoutWorkEvent('work.generation.completed', event.work, {
            workId: event.work.id,
            workName: event.work.name,
            itemsCount: event.work.itemsCount ?? 0,
            generateStatus: event.work.generateStatus,
        });
    }

    @OnEvent(DeploymentDispatchedEvent.EVENT_NAME)
    async onDeploymentDispatched(event: DeploymentDispatchedEvent): Promise<void> {
        const { work, providerId, providerName } = event.payload;
        await this.fanoutWorkEvent('deployment.dispatched', work, {
            workId: work.id,
            providerId,
            providerName,
        });
    }

    @OnEvent(DeploymentCompletedEvent.EVENT_NAME)
    async onDeploymentCompleted(event: DeploymentCompletedEvent): Promise<void> {
        const { work, providerId, providerName, url } = event.payload;
        await this.fanoutWorkEvent('deployment.completed', work, {
            workId: work.id,
            providerId,
            providerName,
            url,
        });
    }

    @OnEvent(DeploymentFailedEvent.EVENT_NAME)
    async onDeploymentFailed(event: DeploymentFailedEvent): Promise<void> {
        const { work, providerId, providerName, terminalState, error } = event.payload;
        await this.fanoutWorkEvent('deployment.failed', work, {
            workId: work.id,
            providerId,
            providerName,
            terminalState,
            error,
        });
    }

    /**
     * Synchronous test-fire used by `POST /api/webhooks/:id/test`. Bypasses
     * the EventEmitter so the customer gets back the immediate delivery
     * result without waiting on Trigger.dev. Still records a delivery row
     * so the test attempt shows up in `GET /api/webhooks/deliveries`.
     */
    async dispatchTestFire(input: {
        readonly subscriptionId: string;
        readonly accountId: string;
    }): Promise<{ deliveryId: string; outcome: string; status: number | null; ok: boolean }> {
        const event = 'webhook.test';
        const payload = {
            event,
            sentAt: new Date().toISOString(),
            note: 'This is a test delivery. Receivers should respond 2xx to confirm the URL is reachable.',
        };

        const delivery = await this.deliveries.createPending({
            subscriptionId: input.subscriptionId,
            accountId: input.accountId,
            event,
            payload,
        });
        const dispatch = await this.orchestrator.dispatch({
            deliveryId: delivery.id,
            subscriptionId: input.subscriptionId,
            event,
            payload,
        });
        return {
            deliveryId: delivery.id,
            outcome: dispatch.result.outcome,
            status: dispatch.result.status ?? null,
            ok: dispatch.result.ok,
        };
    }

    /**
     * Re-enqueue an existing delivery row. Used by
     * `POST /api/webhooks/deliveries/:id/redeliver`. Reuses the originally
     * signed payload (NOT the freshly-emitted producer-side event) so the
     * receiver sees exactly what it would have seen the first time.
     */
    async redeliver(input: {
        readonly originalDeliveryId: string;
        readonly accountId: string;
    }): Promise<{ deliveryId: string; enqueued: boolean; runId: string | null }> {
        const row = await this.deliveries.findById(input.originalDeliveryId);
        if (!row || row.accountId !== input.accountId) {
            // 404 cover for cross-account snooping (mirrors WebhooksService).
            return { deliveryId: input.originalDeliveryId, enqueued: false, runId: null };
        }
        const fresh = await this.deliveries.createPending({
            subscriptionId: row.subscriptionId,
            accountId: row.accountId,
            event: row.event,
            payload: row.payload,
        });
        const runId = await this.enqueue({
            deliveryId: fresh.id,
            subscriptionId: row.subscriptionId,
            eventName: row.event,
            payload: row.payload,
        });
        return { deliveryId: fresh.id, enqueued: true, runId };
    }

    private async fanoutWorkEvent(
        eventName: string,
        work: Work,
        payload: Record<string, unknown>,
    ): Promise<void> {
        try {
            // Subscriptions can be account-scoped (workId NULL) or
            // Work-scoped (workId = the affected work). listActiveForWork
            // returns both rows in a single query (see repository).
            const subs = await this.subscriptions.listActiveForWork(work.id);
            // listActiveForWork doesn't filter by accountId — the account
            // scope is "your subscriptions for any of your works". Filter
            // here so a Work shared across accounts doesn't accidentally
            // ping a different account's account-scoped subscription.
            const ownerSubs = subs.filter((s) => s.accountId === work.userId);
            if (ownerSubs.length === 0) {
                return;
            }

            await Promise.allSettled(
                ownerSubs.map((sub) =>
                    this.enqueueOne(sub.id, sub.accountId, eventName, {
                        event: eventName,
                        sentAt: new Date().toISOString(),
                        accountId: sub.accountId,
                        ...payload,
                    }),
                ),
            );
        } catch (err) {
            this.logger.error(
                `webhook.fanout_failed event=${eventName} work=${work.id} reason=${(err as Error).message}`,
                err as Error,
            );
        }
    }

    private async enqueueOne(
        subscriptionId: string,
        accountId: string,
        eventName: string,
        payload: Record<string, unknown>,
    ): Promise<void> {
        const delivery = await this.deliveries.createPending({
            subscriptionId,
            accountId,
            event: eventName,
            payload,
        });
        await this.enqueue({
            deliveryId: delivery.id,
            subscriptionId,
            eventName,
            payload,
        });
    }

    /**
     * Common path used by both the event-driven fanout AND the explicit
     * redeliver / test-fire endpoints. Tries Trigger.dev first; falls
     * back to running the orchestrator in-process if Trigger is not
     * configured (or the dispatch threw).
     */
    private async enqueue(payload: WebhookDeliveryPayload): Promise<string | null> {
        if (this.remoteDispatcher) {
            const runId = await this.remoteDispatcher.dispatchWebhookDelivery(payload);
            if (runId) return runId;
        }
        // In-process fallback. Fire-and-forget — the orchestrator records
        // its own delivery row updates. We do NOT await here when invoked
        // from a high-rate emitter (deployment flow) because each delivery
        // can block on a slow receiver up to the 10s per-attempt timeout.
        this.orchestrator
            .dispatch({
                deliveryId: payload.deliveryId,
                subscriptionId: payload.subscriptionId,
                event: payload.eventName,
                payload: payload.payload,
            })
            .catch((err) => {
                this.logger.error(
                    `webhook.inline_dispatch_failed delivery=${payload.deliveryId} reason=${(err as Error).message}`,
                    err as Error,
                );
            });
        return null;
    }
}
