import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { UserNotificationCategoryMute } from '../../entities/user-notification-category-mute.entity';

/**
 * Notifications v2 — Event Subscriptions.
 *
 * Repository for `user_notification_category_mutes`. The resolver
 * checks for an active mute on every fanout — index on `(userId,
 * category)` keeps it cheap.
 */
@Injectable()
export class UserNotificationCategoryMuteRepository {
    constructor(
        @InjectRepository(UserNotificationCategoryMute)
        private readonly repository: Repository<UserNotificationCategoryMute>,
    ) {}

    /**
     * True if the user has an active mute for the category right now.
     * `mutedUntil = NULL` ⇒ indefinite.
     */
    async isMuted(userId: string, category: string): Promise<boolean> {
        const now = new Date();
        const row = await this.repository.findOne({ where: { userId, category } });
        if (!row) return false;
        if (!row.mutedUntil) return true;
        return row.mutedUntil.getTime() > now.getTime();
    }

    async upsert(
        userId: string,
        category: string,
        mutedUntil?: Date | null,
    ): Promise<UserNotificationCategoryMute> {
        const existing = await this.repository.findOne({ where: { userId, category } });
        if (existing) {
            await this.repository.update({ id: existing.id }, { mutedUntil: mutedUntil ?? null });
            return (await this.repository.findOne({
                where: { id: existing.id },
            })) as UserNotificationCategoryMute;
        }
        return this.repository.save(
            this.repository.create({ userId, category, mutedUntil: mutedUntil ?? null }),
        );
    }

    async findActiveByUser(userId: string): Promise<UserNotificationCategoryMute[]> {
        const now = new Date();
        return this.repository.find({
            where: [
                { userId, mutedUntil: undefined },
                { userId, mutedUntil: MoreThan(now) },
            ],
        });
    }

    async delete(userId: string, category: string): Promise<void> {
        await this.repository.delete({ userId, category });
    }
}
