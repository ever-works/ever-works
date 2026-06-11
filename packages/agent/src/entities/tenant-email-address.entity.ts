import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { PortableDateColumn } from './_types';

/**
 * Notifications v2 — Email Providers (EW-650, EW-667).
 *
 * Direction discriminator for tenant-managed email addresses.
 * `both` means the same physical address handles inbound webhooks
 * AND outbound sends (most providers support this — Postmark inbound
 * stream + transactional, Mailgun routes + send, etc.).
 *
 * See `docs/specs/features/email-providers/spec.md` §4.1.
 */
export type EmailAddressDirection = 'outbound' | 'inbound' | 'both';

/**
 * Per-tenant email address registry. The operator registers e.g.
 * `pm@acme.com` and binds it to a provider plugin (`postmark`,
 * `resend`, `mailgun`, …). Verified addresses can be assigned to
 * one or more Agents via `agent_email_assignments`.
 *
 * No @ManyToOne to `User` is needed for queries; we keep one for
 * easier eager-loading. Cycle-avoidance: this entity sits at the
 * leaf of the email graph, so a back-ref from `User` is not added.
 */
@Entity({ name: 'tenant_email_addresses' })
@Index('uq_tenant_email_address_user_direction', ['userId', 'address', 'direction'], {
    unique: true,
})
@Index('idx_tenant_email_address_plugin', ['pluginId'])
export class TenantEmailAddress {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    /** RFC 5321 mailbox max (254 chars). */
    @Column({ type: 'varchar', length: 254 })
    address: string;

    @Column({ type: 'varchar', length: 16 })
    direction: EmailAddressDirection;

    @Column({ type: 'varchar', length: 64 })
    pluginId: string;

    /** Per-plugin shape — from-name, routing-tag, webhook secret, etc. */
    @Column({ type: 'simple-json' })
    providerSettings: Record<string, unknown>;

    @Column({ type: 'boolean', default: false })
    verified: boolean;

    @Column({ type: 'varchar', length: 64, nullable: true })
    verificationToken?: string | null;

    /**
     * EW-711 #44 — verification tokens are time-boxed (24h, stamped by
     * `EmailService.createAddress`). NULL = no pending token, or a legacy
     * token issued before this column existed (treated as non-expiring).
     */
    @PortableDateColumn({ nullable: true })
    verificationTokenExpiresAt?: Date | null;

    @Column({ type: 'boolean', default: false })
    defaultForReplies: boolean;

    /** Soft-disable marker. NULL = enabled. */
    @PortableDateColumn({ nullable: true })
    disabledAt?: Date | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
