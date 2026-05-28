import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationEventType } from '../../entities/notification-event-type.entity';

/**
 * Notifications v2 — Event Subscriptions.
 *
 * Repository for `notification_event_types`. Used at startup to seed
 * core events + when a plugin contributes new event types via its
 * manifest.
 */
@Injectable()
export class NotificationEventTypeRepository {
    constructor(
        @InjectRepository(NotificationEventType)
        private readonly repository: Repository<NotificationEventType>,
    ) {}

    create(entry: Partial<NotificationEventType>): NotificationEventType {
        return this.repository.create(entry);
    }

    async upsert(entry: Partial<NotificationEventType> & { key: string }): Promise<void> {
        await this.repository.upsert(entry as NotificationEventType, ['key']);
    }

    async findByKey(key: string): Promise<NotificationEventType | null> {
        return this.repository.findOne({ where: { key } });
    }

    async findAll(): Promise<NotificationEventType[]> {
        return this.repository.find({ order: { category: 'ASC', key: 'ASC' } });
    }

    async findByPlugin(pluginId: string): Promise<NotificationEventType[]> {
        return this.repository.find({ where: { pluginId } });
    }

    async delete(key: string): Promise<void> {
        await this.repository.delete({ key });
    }
}
