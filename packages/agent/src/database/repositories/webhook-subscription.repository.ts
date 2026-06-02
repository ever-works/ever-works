import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookSubscription } from '../../entities';

@Injectable()
export class WebhookSubscriptionRepository {
    constructor(
        @InjectRepository(WebhookSubscription)
        private readonly repository: Repository<WebhookSubscription>,
    ) {}

    async createForAccount(data: {
        accountId: string;
        workId?: string | null;
        url: string;
        secretEncrypted: string;
    }): Promise<WebhookSubscription> {
        const row = this.repository.create({
            accountId: data.accountId,
            workId: data.workId ?? null,
            url: data.url,
            secretEncrypted: data.secretEncrypted,
            status: 'active',
            consecutiveFailures: 0,
        });
        return this.repository.save(row);
    }

    async listActiveForWork(workId: string, accountId?: string): Promise<WebhookSubscription[]> {
        // Security: when an accountId is supplied, scope BOTH arms of the OR to
        // that account so the account-wide (workId IS NULL) branch can no longer
        // pull every tenant's active subscriptions into memory. Callers that pass
        // accountId get tenant isolation enforced at the DB instead of relying on
        // a fragile post-query filter. Omitting accountId preserves the legacy
        // behaviour (and exact query shape) for existing callers.
        if (accountId) {
            return this.repository.find({
                where: [
                    { workId, accountId, status: 'active' },
                    { workId: null as unknown as string, accountId, status: 'active' },
                ],
            });
        }
        return this.repository.find({
            where: [
                { workId, status: 'active' },
                { workId: null as unknown as string, status: 'active' },
            ],
        });
    }

    async listActiveForAccount(accountId: string): Promise<WebhookSubscription[]> {
        return this.repository.find({ where: { accountId, status: 'active' } });
    }

    async markSuccess(id: string): Promise<void> {
        await this.repository.update(id, {
            consecutiveFailures: 0,
            lastDeliveryAt: new Date(),
        });
    }

    async incrementFailure(id: string): Promise<number> {
        await this.repository.increment({ id }, 'consecutiveFailures', 1);
        const row = await this.repository.findOne({ where: { id } });
        return row?.consecutiveFailures ?? 0;
    }

    async markFailed(id: string): Promise<void> {
        await this.repository.update(id, { status: 'failed', lastDeliveryAt: new Date() });
    }

    async pause(id: string): Promise<void> {
        await this.repository.update(id, { status: 'paused' });
    }

    async updateSecret(id: string, secretEncrypted: string): Promise<void> {
        await this.repository.update(id, { secretEncrypted });
    }

    async delete(id: string, accountId?: string): Promise<void> {
        // Security: defence-in-depth ownership guard. When an accountId is
        // supplied the delete is scoped to { id, accountId } so a caller can
        // never remove another tenant's subscription by supplying an arbitrary
        // UUID, even if the service-layer ownership check is bypassed. Omitting
        // accountId preserves the existing by-id behaviour for current callers.
        await this.repository.delete(accountId ? { id, accountId } : id);
    }

    async findById(id: string): Promise<WebhookSubscription | null> {
        return this.repository.findOne({ where: { id } });
    }
}
