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

    async listActiveForWork(workId: string): Promise<WebhookSubscription[]> {
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

    async delete(id: string): Promise<void> {
        await this.repository.delete(id);
    }

    async findById(id: string): Promise<WebhookSubscription | null> {
        return this.repository.findOne({ where: { id } });
    }
}
