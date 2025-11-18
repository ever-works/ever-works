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
