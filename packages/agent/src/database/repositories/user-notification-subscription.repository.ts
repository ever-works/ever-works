import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserNotificationSubscription } from '../../entities/user-notification-subscription.entity';

/**
 * Notifications v2 — Event Subscriptions.
 *
 * Repository for `user_notification_subscriptions` — the resolver's
 * primary data source for `(userId, eventType) → channels`.
 */
@Injectable()
export class UserNotificationSubscriptionRepository {
    constructor(
        @InjectRepository(UserNotificationSubscription)
        private readonly repository: Repository<UserNotificationSubscription>,
    ) {}

    async upsert(userId: string, eventTypeKey: string, channelIds: string[]): Promise<void> {
        const existing = await this.repository.findOne({ where: { userId, eventTypeKey } });
        if (existing) {
            await this.repository.update({ id: existing.id }, { channelIds });
        } else {
            await this.repository.save(
                this.repository.create({ userId, eventTypeKey, channelIds }),
            );
        }
    }

    async findByUser(userId: string): Promise<UserNotificationSubscription[]> {
        return this.repository.find({ where: { userId } });
    }

    async findForEvent(
        userId: string,
        eventTypeKey: string,
    ): Promise<UserNotificationSubscription | null> {
        return this.repository.findOne({ where: { userId, eventTypeKey } });
    }

    async deleteForEvent(userId: string, eventTypeKey: string): Promise<void> {
        await this.repository.delete({ userId, eventTypeKey });
    }

    /**
     * Attention controls (AW-13) — remove this user's stored choices so the
     * events follow their defaults again. Limited to `eventTypeKeys` when
     * given, every event otherwise. Always scoped to `userId`: a key that
     * only another user has a row for removes nothing. Returns the number of
     * rows removed.
     */
    async deleteForUser(userId: string, eventTypeKeys?: readonly string[]): Promise<number> {
        const rows = await this.repository.find({ where: { userId } });
        const wanted = eventTypeKeys ? new Set(eventTypeKeys) : null;
        const ids = rows.filter((r) => !wanted || wanted.has(r.eventTypeKey)).map((r) => r.id);
        if (ids.length === 0) return 0;
        await this.repository.delete({ userId, id: In(ids) });
        return ids.length;
    }
}
