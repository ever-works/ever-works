import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    NotificationChannelDeliveryLog,
    NotificationChannelDeliveryStatus,
} from '../../entities/notification-channel-delivery-log.entity';

/**
 * Notifications v2 — Notification Channels.
 *
 * Repository for `notification_channel_delivery_log`. Idempotency
 * lookup by `messageRef` is the hot path — the facade checks here
 * before invoking the plugin to skip duplicate fanouts from BullMQ
 * retries.
 */
@Injectable()
export class NotificationChannelDeliveryLogRepository {
    constructor(
        @InjectRepository(NotificationChannelDeliveryLog)
        private readonly repository: Repository<NotificationChannelDeliveryLog>,
    ) {}

    create(entry: Partial<NotificationChannelDeliveryLog>): NotificationChannelDeliveryLog {
        return this.repository.create(entry);
    }

    async save(entry: NotificationChannelDeliveryLog): Promise<NotificationChannelDeliveryLog> {
        return this.repository.save(entry);
    }

    async findByMessageRef(
        messageRef: string,
        channelId?: string,
    ): Promise<NotificationChannelDeliveryLog | null> {
        const where: Record<string, unknown> = { messageRef };
        if (channelId) where.channelId = channelId;
        return this.repository.findOne({ where });
    }

    async findRecentByChannel(
        channelId: string,
        limit = 50,
    ): Promise<NotificationChannelDeliveryLog[]> {
        return this.repository.find({
            where: { channelId },
            order: { createdAt: 'DESC' },
            take: Math.min(limit, 200),
        });
    }

    async updateStatus(
        id: string,
        status: NotificationChannelDeliveryStatus,
        patch: Partial<NotificationChannelDeliveryLog> = {},
    ): Promise<void> {
        await this.repository.update({ id }, { status, ...patch });
    }
}
