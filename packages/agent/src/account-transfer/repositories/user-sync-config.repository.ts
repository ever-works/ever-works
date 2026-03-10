import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserSyncConfig } from '../entities/user-sync-config.entity';

@Injectable()
export class UserSyncConfigRepository {
    constructor(
        @InjectRepository(UserSyncConfig)
        private readonly repository: Repository<UserSyncConfig>,
    ) {}

    async findByUser(userId: string): Promise<UserSyncConfig | null> {
        return this.repository.findOne({ where: { userId } });
    }

    async upsert(userId: string, data: Partial<UserSyncConfig>): Promise<UserSyncConfig | null> {
        const existing = await this.findByUser(userId);
        if (existing) {
            await this.repository.update({ userId }, data);
            return this.findByUser(userId);
        }
        const record = this.repository.create({ userId, ...data });
        return this.repository.save(record);
    }

    async delete(userId: string): Promise<boolean> {
        const result = await this.repository.delete({ userId });
        return (result.affected ?? 0) > 0;
    }

    async updateLastPush(userId: string): Promise<void> {
        await this.repository.update({ userId }, { lastPushAt: new Date(), lastSyncError: null });
    }

    async updateLastPull(userId: string): Promise<void> {
        await this.repository.update({ userId }, { lastPullAt: new Date(), lastSyncError: null });
    }

    async updateError(userId: string, error: string): Promise<void> {
        await this.repository.update({ userId }, { lastSyncError: error });
    }
}
