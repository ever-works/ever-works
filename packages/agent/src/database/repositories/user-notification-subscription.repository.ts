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

    /**
     * Store the channel list for one event.
     *
     * `origin` (AW-13) records where this write came from and is replaced on
     * every write, so it always describes the latest one: the notification
     * matrix passes `'matrix'`; every other caller leaves it out, which stores
     * NULL and keeps the row's pre-AW-13 meaning (see `notification-choice.ts`).
     */
    async upsert(
        userId: string,
        eventTypeKey: string,
        channelIds: string[],
        origin: string | null = null,
    ): Promise<void> {
        const existing = await this.repository.findOne({ where: { userId, eventTypeKey } });
        if (existing) {
            await this.repository.update({ id: existing.id }, { channelIds, origin });
        } else {
            await this.repository.save(
                this.repository.create({ userId, eventTypeKey, channelIds, origin }),
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
