import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ComposioTriggerSubscription } from '@ever-works/agent/entities';
import type { CreateComposioTriggerDto } from './dto/composio-trigger.dto';

/**
 * CRUD + webhook-verification service for `composio_trigger_subscriptions`.
 *
 * Triggers are created via `POST /api/plugins/composio/triggers`. The
 * service generates a per-subscription HMAC secret server-side and
 * returns it ONCE in the create response. Subsequent reads never
 * include the secret.
 *
 * Webhook deliveries arrive at `POST /api/plugins/composio/webhook`
 * with the Composio trigger id in the JSON body (`tg_*`) plus an
 * `x-composio-signature` header — the controller resolves the
 * subscription by trigger id, then `verifyDelivery` HMAC-checks the
 * raw request body against the stored secret in constant time.
 */
@Injectable()
export class ComposioTriggersService {
    private readonly logger = new Logger(ComposioTriggersService.name);

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
     * Creates a trigger subscription row. In a follow-up PR this will
     * also call Composio's `POST /triggers` to enable the trigger
     * upstream — for now the controller layer wires the upstream call
     * and passes us the resulting `composioTriggerId`.
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

    async remove(userId: string, id: string): Promise<void> {
        const subscription = await this.repo.findOne({ where: { id, userId } });
        if (!subscription) throw new NotFoundException('Trigger subscription not found');
        await this.repo.delete({ id });
    }

    async findByComposioTriggerId(
        composioTriggerId: string,
    ): Promise<ComposioTriggerSubscription | null> {
        return this.repo.findOne({ where: { composioTriggerId } });
    }

    /**
     * Verifies an inbound Composio webhook delivery against the stored
     * per-subscription HMAC secret. Composio signs deliveries with
     * HMAC-SHA256 of the raw JSON body; the signature is sent as the
     * hex digest in the `x-composio-signature` header.
     *
     * Uses `crypto.timingSafeEqual` to defeat timing attacks. Throws
     * `UnauthorizedException` on mismatch.
     */
    verifyDelivery(
        subscription: Pick<ComposioTriggerSubscription, 'webhookSecret'>,
        rawBody: string,
        signature: string | undefined,
    ): void {
        if (!signature || typeof signature !== 'string') {
            throw new UnauthorizedException('Missing x-composio-signature header');
        }

        const computed = createHmac('sha256', subscription.webhookSecret)
            .update(rawBody)
            .digest('hex');

        const provided = signature
            .trim()
            .toLowerCase()
            .replace(/^sha256=/, '');
        if (provided.length !== computed.length) {
            throw new UnauthorizedException('Invalid Composio webhook signature');
        }

        let equal = false;
        try {
            equal = timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(computed, 'hex'));
        } catch {
            equal = false;
        }
        if (!equal) {
            throw new UnauthorizedException('Invalid Composio webhook signature');
        }
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
