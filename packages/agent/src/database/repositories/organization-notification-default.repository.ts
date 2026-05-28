import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    OrganizationNotificationDefault,
    OrganizationNotificationDefaults,
} from '../../entities/organization-notification-default.entity';

/**
 * Notifications v2 — Event Subscriptions.
 *
 * Repository for `organization_notification_defaults`. Single row
 * per organization; consumed by the resolver as the level-2 fallback
 * after the user's own subscriptions and before the built-in
 * `['in-app']` default.
 */
@Injectable()
export class OrganizationNotificationDefaultRepository {
    constructor(
        @InjectRepository(OrganizationNotificationDefault)
        private readonly repository: Repository<OrganizationNotificationDefault>,
    ) {}

    async findByOrg(organizationId: string): Promise<OrganizationNotificationDefault | null> {
        return this.repository.findOne({ where: { organizationId } });
    }

    async upsert(
        organizationId: string,
        defaults: OrganizationNotificationDefaults,
    ): Promise<OrganizationNotificationDefault> {
        const existing = await this.findByOrg(organizationId);
        if (existing) {
            await this.repository.update({ organizationId }, { defaults });
            return (await this.findByOrg(organizationId)) as OrganizationNotificationDefault;
        }
        const created = this.repository.create({ organizationId, defaults });
        return this.repository.save(created);
    }
}
