import { randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ComposioTriggerSubscription } from '@ever-works/agent/entities';
import type { CreateComposioTriggerDto } from './dto/composio-trigger.dto';

/**
 * CRUD + delivery-bookkeeping service for `composio_trigger_subscriptions`.
 *
 * Triggers are enabled upstream on Composio (via the SDK in
 * `ComposioService`) and stored here keyed by the returned `tg_*` id.
 * Webhook deliveries arrive at `POST /api/plugins/composio/webhook`; the
 * controller resolves the subscription by trigger id and verifies the
 * delivery via the official Composio SDK against the project webhook
 * secret (see `ComposioService.verifyWebhook`). This service then records
 * the accepted/rejected outcome.
 */
@Injectable()
export class ComposioTriggersService {
    constructor(
        @InjectRepository(ComposioTriggerSubscription)
        private readonly repo: Repository<ComposioTriggerSubscription>,
    ) {}

    async list(userId: string): Promise<ComposioTriggerSubscription[]> {
        return this.repo.find({
            where: { userId },
            order: { createdAt: 'DESC' as const },
        });
    }

    /**
     * Persist a trigger subscription row keyed by the real Composio
     * `tg_*` id (the controller enables the trigger upstream via the SDK
     * first and passes the returned id here).
     *
     * `webhookSecret` is retained as an internal random value only to
     * satisfy the column's NOT NULL constraint — it is **no longer** the
     * verification secret. Composio signs deliveries with the project
     * webhook secret (resolved from plugin settings at verify time), so
     * the per-subscription value is vestigial and never surfaced.
     */
    async create(
        userId: string,
        composioTriggerId: string,
        body: CreateComposioTriggerDto,
    ): Promise<ComposioTriggerSubscription> {
        const webhookSecret = randomBytes(32).toString('hex');
        const entity = this.repo.create({
            userId,
            toolkitSlug: body.toolkitSlug.toUpperCase(),
            triggerSlug: body.triggerSlug.toUpperCase(),
            composioTriggerId,
            composioConnectedAccountId: body.composioConnectedAccountId,
            webhookSecret,
            config: body.config ?? null,
            enabled: true,
            deliveriesReceived: 0,
            deliveriesRejected: 0,
        });
        return this.repo.save(entity);
    }

    /**
     * Remove the local subscription row and return its Composio `tg_*` id
     * so the caller can tear the trigger down upstream (best-effort).
     */
    async remove(userId: string, id: string): Promise<string> {
        const subscription = await this.repo.findOne({ where: { id, userId } });
        if (!subscription) throw new NotFoundException('Trigger subscription not found');
        await this.repo.delete({ id });
        return subscription.composioTriggerId;
    }

    async findByComposioTriggerId(
        composioTriggerId: string,
    ): Promise<ComposioTriggerSubscription | null> {
        return this.repo.findOne({ where: { composioTriggerId } });
    }

    async recordDelivery(subscriptionId: string, outcome: 'accepted' | 'rejected'): Promise<void> {
        const column = outcome === 'accepted' ? 'deliveriesReceived' : 'deliveriesRejected';
        const updates: Partial<ComposioTriggerSubscription> = {};
        if (outcome === 'accepted') updates.lastFiredAt = new Date();
        await this.repo.increment({ id: subscriptionId }, column, 1);
        if (Object.keys(updates).length > 0) {
            await this.repo.update({ id: subscriptionId }, updates);
        }
    }
}
