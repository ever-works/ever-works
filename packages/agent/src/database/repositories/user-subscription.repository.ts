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
     * The user's CURRENT subscription — active or trialing.
     *
     * Additive sibling of {@link findActiveByUser}, which matches only
     * `ACTIVE` and is left untouched because other callers depend on that
     * exact meaning. A trialing customer is entitled to what they are
     * trialing, so the monthly credit grant reads THIS.
     *
     * Deliberately excludes `PAST_DUE`: a subscription in dunning must not
     * keep drawing a paid allowance while Stripe retries the invoice.
     */
    async findCurrentByUser(userId: string): Promise<UserSubscription | null> {
        return this.repository.findOne({
            where: [
                { userId, status: SubscriptionStatus.ACTIVE },
                { userId, status: SubscriptionStatus.TRIALING },
            ],
            relations: ['plan'],
            order: { createdAt: 'DESC' },
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
