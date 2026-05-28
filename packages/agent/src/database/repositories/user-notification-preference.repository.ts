import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserNotificationPreference } from '../../entities/user-notification-preference.entity';

/**
 * Notifications v2 — Event Subscriptions.
 *
 * Repository for `user_notification_preferences`. One row per user;
 * `findOrInitialize` returns an empty (non-persisted) entity for
 * users who haven't set quiet hours yet.
 */
@Injectable()
export class UserNotificationPreferenceRepository {
    constructor(
        @InjectRepository(UserNotificationPreference)
        private readonly repository: Repository<UserNotificationPreference>,
    ) {}

    async findByUser(userId: string): Promise<UserNotificationPreference | null> {
        return this.repository.findOne({ where: { userId } });
    }

    async upsert(
        userId: string,
        patch: Partial<UserNotificationPreference>,
    ): Promise<UserNotificationPreference> {
        const existing = await this.findByUser(userId);
        if (existing) {
            await this.repository.update({ userId }, patch);
            return (await this.findByUser(userId)) as UserNotificationPreference;
        }
        const created = this.repository.create({ userId, ...patch });
        return this.repository.save(created);
    }
}
