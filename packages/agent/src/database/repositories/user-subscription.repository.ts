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

    /**
     * Persist the seats the provider subscription bills for (billing spec
     * FR-26). Written from the provider snapshot on webhooks and after a
     * seat purchase — never inferred locally.
     */
    async updateSeats(
        id: string,
        data: { seats: number | null; providerSeatItemId: string | null },
    ): Promise<void> {
        await this.repository.update(id, {
            seats: data.seats,
            providerSeatItemId: data.providerSeatItemId,
        });
    }

    async cancel(id: string): Promise<void> {
        await this.repository.update(id, { status: SubscriptionStatus.CANCELED });
    }
}
