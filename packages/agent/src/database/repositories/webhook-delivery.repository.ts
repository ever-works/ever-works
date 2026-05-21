import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { WebhookDelivery, type WebhookDeliveryStatus } from '../../entities';

export interface RecordAttemptInput {
    readonly status: WebhookDeliveryStatus;
    readonly lastResponseStatus?: number | null;
    readonly lastOutcome?: string | null;
    readonly lastError?: string | null;
    readonly durationMs?: number | null;
    readonly triggerRunId?: string | null;
}

@Injectable()
export class WebhookDeliveryRepository {
    constructor(
        @InjectRepository(WebhookDelivery)
        private readonly repository: Repository<WebhookDelivery>,
    ) {}

    async createPending(input: {
        readonly id?: string;
        readonly subscriptionId: string;
        readonly accountId: string;
        readonly event: string;
        readonly payload: Record<string, unknown>;
    }): Promise<WebhookDelivery> {
        const row = this.repository.create({
            ...(input.id ? { id: input.id } : {}),
            subscriptionId: input.subscriptionId,
            accountId: input.accountId,
            event: input.event,
            payload: input.payload,
            status: 'pending',
            attempts: 0,
        });
        return this.repository.save(row);
    }

    async recordAttempt(id: string, attempt: RecordAttemptInput): Promise<void> {
        await this.repository.increment({ id }, 'attempts', 1);
        await this.repository.update(id, {
            status: attempt.status,
            lastResponseStatus: attempt.lastResponseStatus ?? null,
            lastOutcome: attempt.lastOutcome ?? null,
            lastError: attempt.lastError ?? null,
            durationMs: attempt.durationMs ?? null,
            triggerRunId: attempt.triggerRunId ?? null,
            lastAttemptAt: new Date(),
        });
    }

    async findById(id: string): Promise<WebhookDelivery | null> {
        return this.repository.findOne({ where: { id } });
    }

    /**
     * Most-recent-first listing for the deliveries endpoint. The default
     * caller is `GET /api/webhooks/deliveries`, which scopes by the caller's
     * accountId so cross-account snooping is impossible at the repository
     * layer, not just the controller.
     */
    async listForAccount(
        accountId: string,
        opts: { limit?: number; subscriptionId?: string } = {},
    ): Promise<WebhookDelivery[]> {
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
        return this.repository.find({
            where: opts.subscriptionId
                ? { accountId, subscriptionId: opts.subscriptionId }
                : { accountId },
            order: { createdAt: 'DESC' },
            take: limit,
        });
    }

    /**
     * Prune delivery rows older than `olderThan`. Called from a periodic
     * cleanup job (out of scope for EW-634; ticket lives in the backlog).
     * Kept here so the table doesn't have to grow unbounded once the
     * janitor lands.
     */
    async pruneOlderThan(olderThan: Date): Promise<number> {
        const res = await this.repository.delete({ createdAt: LessThan(olderThan) });
        return res.affected ?? 0;
    }
}
