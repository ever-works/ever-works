import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserSubscription, SubscriptionStatus } from '@src/entities/user-subscription.entity';

@Injectable()
export class UserSubscriptionRepository {
    constructor(
        @InjectRepository(UserSubscription)
        private readonly repository: Repository<UserSubscription>,
    ) {}

    async findActiveByUser(userId: string): Promise<UserSubscription | null> {
        return this.repository.findOne({
            where: { userId, status: SubscriptionStatus.ACTIVE },
            relations: ['plan'],
        });
    }

    /**
     * Look a subscription up by the PROVIDER's id (audit B24 — plan
     * checkout). This is how a later `customer.subscription.*` delivery
     * finds exactly the row the hosted checkout created, without
     * trusting anything the browser could have supplied.
     */
    async findByProviderSubscriptionId(
        providerSubscriptionId: string,
    ): Promise<UserSubscription | null> {
        return this.repository.findOne({
            where: { providerSubscriptionId },
            relations: ['plan'],
        });
    }

    /**
     * Active subscriptions in stable (createdAt, id) order for the daily
     * plan-allowance sweep (billing spec FR-5). `plan` is eager on the
     * entity; loaded explicitly anyway so the batch never depends on that.
     */
    async findActiveBatch(skip: number, take: number): Promise<UserSubscription[]> {
        return this.repository.find({
            where: { status: SubscriptionStatus.ACTIVE },
            order: { createdAt: 'ASC', id: 'ASC' },
            relations: ['plan'],
            skip,
            take,
        });
    }

    async listByUser(userId: string): Promise<UserSubscription[]> {
        return this.repository.find({
            where: { userId },
            order: { createdAt: 'DESC' },
            relations: ['plan'],
        });
    }

    async createOrUpdate(
        userId: string,
        data: Partial<UserSubscription>,
    ): Promise<UserSubscription> {
        const existing = await this.findActiveByUser(userId);

        if (existing) {
            await this.repository.update(existing.id, data);
            return this.repository.findOne({ where: { id: existing.id }, relations: ['plan'] });
        }

        const record = this.repository.create({ ...data, userId });
        return this.repository.save(record);
    }

    async cancel(id: string): Promise<void> {
        await this.repository.update(id, { status: SubscriptionStatus.CANCELED });
    }
}
