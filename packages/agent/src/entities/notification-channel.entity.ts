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
import { EncryptedJsonColumn } from './_secret-json-column';

/**
 * Notifications v2 — Notification Channels.
 *
 * Per-tenant connection to a chat / messaging surface.
 * `pluginId` identifies which channel plugin handles delivery
 * (`discord-channel`, `slack-channel`, `telegram-channel`,
 * `whatsapp-channel`, `novu-channel`, or built-in `in-app`).
 *
 * `targetConfig` carries the per-plugin shape (webhook URL,
 * channel id, bot token reference, novu workflow id, …) and is
 * handed back to the plugin on every send. It carries live
 * credentials (Telegram `botToken`, WhatsApp `accessToken`, Novu
 * `apiKey`, Slack/Discord `webhookUrl`), so it is envelope-encrypted
 * at rest via `@EncryptedJsonColumn` (EW-716 #22) — transparent to
 * every reader; the DB never holds plaintext.
 *
 * See `docs/specs/features/notification-channels/spec.md` §4.1.
 */
@Entity({ name: 'notification_channels' })
@Index('uq_notification_channel', ['userId', 'pluginId', 'name'], { unique: true })
@Index('idx_notification_channel_plugin', ['pluginId'])
export class NotificationChannel {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 64 })
    pluginId: string;

    @Column({ type: 'varchar', length: 120 })
    name: string;

    // EW-716 #22: envelope-encrypted at rest (AES-256-GCM, `enc::v1::`).
    // Transparent transformer — readers get plaintext, the DB holds ciphertext.
    @EncryptedJsonColumn()
    targetConfig: Record<string, unknown>;

    @Column({ type: 'boolean', default: false })
    verified: boolean;

    @PortableDateColumn({ nullable: true })
    disabledAt?: Date | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
