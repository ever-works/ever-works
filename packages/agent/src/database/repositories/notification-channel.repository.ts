import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { NotificationChannel } from '../../entities/notification-channel.entity';

/**
 * Notifications v2 — Notification Channels.
 *
 * Repository for `notification_channels`. The
 * `NotificationChannelFacadeService` reads `targetConfig` from here
 * and hands it to the plugin's `send`.
 */
@Injectable()
export class NotificationChannelRepository {
    constructor(
        @InjectRepository(NotificationChannel)
        private readonly repository: Repository<NotificationChannel>,
    ) {}

    create(entry: Partial<NotificationChannel>): NotificationChannel {
        return this.repository.create(entry);
    }

    async save(entry: NotificationChannel): Promise<NotificationChannel> {
        return this.repository.save(entry);
    }

    /**
     * Security: PRIVILEGED — no userId scope. Use only from system-level
     * background tasks (e.g. Trigger.dev delivery retries) where the channelId
     * originates from a previously-validated, system-owned payload — never from
     * user-supplied input. For any user-initiated lookup, use
     * {@link findByIdForUser} instead to prevent IDOR across tenants.
     */
    async findById(id: string): Promise<NotificationChannel | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdForUser(id: string, userId: string): Promise<NotificationChannel | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findActiveByUser(userId: string): Promise<NotificationChannel[]> {
        return this.repository.find({
            where: { userId, disabledAt: IsNull() },
            order: { createdAt: 'ASC' },
        });
    }

    async update(id: string, patch: Partial<NotificationChannel>): Promise<void> {
        await this.repository.update({ id }, patch);
    }

    async delete(id: string, userId: string): Promise<void> {
        await this.repository.delete({ id, userId });
    }
}
