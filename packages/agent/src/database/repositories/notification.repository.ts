import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, CreateNotificationDto, NotificationQueryOptions } from '../../entities';

@Injectable()
export class NotificationRepository {
    constructor(
        @InjectRepository(Notification)
        private readonly repository: Repository<Notification>,
    ) {}

    async create(dto: CreateNotificationDto): Promise<Notification> {
        const notification = this.repository.create({
            userId: dto.userId,
            type: dto.type,
            category: dto.category,
            title: dto.title,
            message: dto.message,
            actionUrl: dto.actionUrl,
            actionLabel: dto.actionLabel,
            metadata: dto.metadata,
            isPersistent: dto.isPersistent ?? false,
            expiresAt: dto.expiresAt,
            deduplicationKey: dto.deduplicationKey,
            isRead: false,
            isDismissed: false,
        });
        return await this.repository.save(notification);
    }

    async findByUserId(
        userId: string,
        options: NotificationQueryOptions = {},
    ): Promise<Notification[]> {
        const { unreadOnly, undismissedOnly = true, limit = 50, offset = 0, category } = options;

        const queryBuilder = this.repository
            .createQueryBuilder('notification')
            .where('notification.userId = :userId', { userId });

        if (unreadOnly) {
            queryBuilder.andWhere('notification.isRead = :isRead', { isRead: false });
        }

        if (undismissedOnly) {
            queryBuilder.andWhere('notification.isDismissed = :isDismissed', {
                isDismissed: false,
            });
        }

        if (category) {
            queryBuilder.andWhere('notification.category = :category', { category });
        }

        // Exclude expired notifications (expiresAt is stored as bigint timestamp)
        queryBuilder.andWhere('(notification.expiresAt IS NULL OR notification.expiresAt > :now)', {
            now: Date.now(),
        });

        queryBuilder.orderBy('notification.createdAt', 'DESC').skip(offset).take(limit);

        return await queryBuilder.getMany();
    }

    async findById(id: string): Promise<Notification | null> {
        return await this.repository.findOne({ where: { id } });
    }

    async findByIdAndUserId(id: string, userId: string): Promise<Notification | null> {
        return await this.repository.findOne({ where: { id, userId } });
    }

    async markAsRead(id: string): Promise<void> {
        await this.repository.update(id, { isRead: true });
    }

    async markAllAsRead(userId: string): Promise<void> {
        await this.repository.update(
            { userId, isRead: false, isDismissed: false },
            { isRead: true },
        );
    }

    async dismiss(id: string): Promise<void> {
        await this.repository.update(id, { isDismissed: true, isRead: true });
    }

    async findByDeduplicationKey(
        userId: string,
        deduplicationKey: string,
    ): Promise<Notification | null> {
        return await this.repository.findOne({
            where: { userId, deduplicationKey },
        });
    }

    async getUnreadCount(userId: string): Promise<number> {
        // Use query builder to filter expired notifications (expiresAt is bigint)
        return await this.repository
            .createQueryBuilder('notification')
            .where('notification.userId = :userId', { userId })
            .andWhere('notification.isRead = :isRead', { isRead: false })
            .andWhere('notification.isDismissed = :isDismissed', { isDismissed: false })
            .andWhere('(notification.expiresAt IS NULL OR notification.expiresAt > :now)', {
                now: Date.now(),
            })
            .getCount();
    }

    async deleteExpired(): Promise<number> {
        // expiresAt is stored as bigint timestamp, so use Date.now()
        const result = await this.repository
            .createQueryBuilder()
            .delete()
            .where('expiresAt IS NOT NULL AND expiresAt < :now', { now: Date.now() })
            .execute();
        return result.affected || 0;
    }

    async deleteOlderThan(options: {
        olderThanDays: number;
        isDismissed?: boolean;
    }): Promise<number> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - options.olderThanDays);

        const queryBuilder = this.repository
            .createQueryBuilder()
            .delete()
            .where('createdAt < :cutoffDate', { cutoffDate });

        if (options.isDismissed !== undefined) {
            queryBuilder.andWhere('isDismissed = :isDismissed', {
                isDismissed: options.isDismissed,
            });
        }

        const result = await queryBuilder.execute();
        return result.affected || 0;
    }

    async getPersistentNotifications(userId: string): Promise<Notification[]> {
        // Use query builder to filter expired notifications (expiresAt is bigint)
        return await this.repository
            .createQueryBuilder('notification')
            .where('notification.userId = :userId', { userId })
            .andWhere('notification.isPersistent = :isPersistent', { isPersistent: true })
            .andWhere('notification.isDismissed = :isDismissed', { isDismissed: false })
            .andWhere('(notification.expiresAt IS NULL OR notification.expiresAt > :now)', {
                now: Date.now(),
            })
            .orderBy('notification.createdAt', 'DESC')
            .getMany();
    }

    async clearDeduplicationKey(userId: string, deduplicationKey: string): Promise<void> {
        await this.repository.update({ userId, deduplicationKey }, { isDismissed: true });
    }
}
