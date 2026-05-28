import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { Organization } from './organization.entity';

/**
 * Per-event-key map: `eventTypeKey → [channelId | 'in-app']`.
 *
 * `channelId` here is a UUID from `notification_channels` — typically
 * a shared organisation-owned channel (e.g. the team Discord
 * webhook). New users in this organisation inherit this map on
 * first save of their preferences.
 */
export type OrganizationNotificationDefaults = Record<string, string[]>;

/**
 * Notifications v2 — Event Subscriptions.
 *
 * Per-organization default subscription map. PK = organizationId,
 * so this is a single-row-per-org table.
 *
 * See `docs/specs/features/event-subscriptions/spec.md` §5.1.
 */
@Entity({ name: 'organization_notification_defaults' })
export class OrganizationNotificationDefault {
    @PrimaryColumn({ type: 'uuid' })
    organizationId: string;

    @OneToOne(() => Organization, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'organizationId' })
    organization?: Organization;

    @Column({ type: 'simple-json' })
    defaults: OrganizationNotificationDefaults;

    @UpdateDateColumn()
    updatedAt: Date;
}
