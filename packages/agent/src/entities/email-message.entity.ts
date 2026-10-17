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
import { TenantEmailAddress } from './tenant-email-address.entity';
import { EmailConversation } from './email-conversation.entity';
import type { EmailMessageStatus } from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

export type EmailMessageDirection = 'outbound' | 'inbound';

/**
 * EW-P4-3 — one inbound attachment as recorded on its message. `uploadId` is
 * the `user_uploads` content id when the bytes were stored (`stored: true`);
 * an attachment the upload pipeline refused (type not allowed, too large,
 * over the per-message limits) is still listed, with `stored: false` and the
 * reason, so nobody is left wondering where it went.
 */
export interface EmailMessageAttachmentRecord {
    filename: string;
    mimeType: string;
    size: number;
    cid?: string | null;
    stored: boolean;
    uploadId?: string | null;
    url?: string | null;
    reason?: string | null;
}

/**
 * Notifications v2 — Email Providers (EW-650, EW-667).
 *
 * Per-message audit row. Outbound messages are inserted by the
 * EmailFacade after the provider plugin's `sendEmail` returns; inbound
 * messages are inserted by the inbound-webhook controller after the
 * plugin's `parseInboundWebhook` returns.
 *
 * Either `taskId` OR `conversationId` is set (never both) — v1.1
 * spec §12.3. NULL indicates an ad-hoc message not bound to either
 * surface yet (rare; happens during the inbound dispatcher's brief
 * window before it resolves the destination Task).
 *
 * No @ManyToOne to `Agent` / `Task` — keeps the entity at the leaf
 * of the graph and avoids the entities import cycle that has bitten
 * us before. The `agentId` / `taskId` columns are queryable via raw
 * `userId`+`agentId` indices.
 *
 * Agent email (AW-05) — `status` is where a message is in its life
 * (see `EmailMessageStatus` in `@ever-works/contracts`). An outbound row
 * is no longer only written after the provider accepted it: a message an
 * Agent writes while its inbox is in `draft-review` is persisted first as
 * `draft`, and only a person's approval (`approvedById` / `approvedAt`,
 * mirrored to the linked `agent_action_proposals` row in `approvalId`)
 * moves it on to `sending` and then `sent`. The send path refuses to
 * release an Agent's draft that does not carry that approval.
 * `deliveryStatus` stays what it was: post-send provider telemetry.
 */
@Entity({ name: 'email_messages' })
@Index('idx_email_messages_user_agent_created', ['userId', 'agentId', 'createdAt'])
@Index('idx_email_messages_task_created', ['taskId', 'createdAt'])
@Index('idx_email_messages_conversation_created', ['conversationId', 'createdAt'])
@Index('idx_email_messages_address_created', ['emailAddressId', 'createdAt'])
@Index('uq_email_messages_provider_message', ['pluginId', 'providerMessageId'], {
    unique: true,
})
// AW-05 — the send-ceiling windows: "how much has this Agent / this account
// sent since T?". Both are read on every send.
@Index('idx_email_messages_agent_direction_sent', ['agentId', 'direction', 'sentAt'])
@Index('idx_email_messages_user_direction_sent', ['userId', 'direction', 'sentAt'])
// EW-P4-3 — RFC threading: "which of this owner's messages has Message-ID X?"
// is asked for every id of an inbound reply's In-Reply-To / References.
@Index('idx_email_messages_user_message_id_header', ['userId', 'messageIdHeader'])
// EW-P4-2 — the integration list `GET /api/integrations/v1/email/messages`: one
// organization's messages ordered by `(updatedAt, id)` (migration 1795130300000).
@Index('idx_email_messages_org_updated', ['organizationId', 'updatedAt', 'id'])
export class EmailMessage {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    /** Attribution: Agent that authored / received this message. */
    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    /** Mutually exclusive with `conversationId`. */
    @Column({ type: 'uuid', nullable: true })
    taskId?: string | null;

    /** Mutually exclusive with `taskId`. Set when the inbound dispatcher
     *  routed this message into an EmailConversation thread. */
    @Column({ type: 'uuid', nullable: true })
    conversationId?: string | null;

    @ManyToOne(() => EmailConversation, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'conversationId' })
    conversation?: EmailConversation | null;

    @Column({ type: 'uuid' })
    emailAddressId: string;

    @ManyToOne(() => TenantEmailAddress, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'emailAddressId' })
    emailAddress?: TenantEmailAddress;

    @Column({ type: 'varchar', length: 16 })
    direction: EmailMessageDirection;

    /** Which plugin handled the send/receive (denormalized for fast
     *  filtering when a tenant has multiple providers configured). */
    @Column({ type: 'varchar', length: 64 })
    pluginId: string;

    @Column({ type: 'varchar', length: 200, nullable: true })
    providerMessageId?: string | null;

    /**
     * EW-P4-3 — RFC 5322 `Message-ID` of this message, bare (no angle
     * brackets; `normalizeMessageId` in `@ever-works/plugin`). Outbound: the
     * id the platform set on the send. Inbound: the sender's, when the
     * provider surfaced it. Distinct from `providerMessageId`, the provider's
     * own handle. NULL when unknown, or longer than 255 characters.
     */
    @Column({ type: 'varchar', length: 255, nullable: true })
    messageIdHeader?: string | null;

    /** EW-P4-3 — first id of `In-Reply-To`, bare. */
    @Column({ type: 'varchar', length: 255, nullable: true })
    inReplyTo?: string | null;

    /** EW-P4-3 — ids of `References`, bare, oldest first (at most 50). */
    @Column({ type: 'simple-json', nullable: true })
    references?: string[] | null;

    @Column({ type: 'varchar', length: 254 })
    from: string;

    @Column({ type: 'simple-json' })
    toAddresses: string[];

    @Column({ type: 'simple-json', nullable: true })
    ccAddresses?: string[] | null;

    @Column({ type: 'simple-json', nullable: true })
    bccAddresses?: string[] | null;

    /** RFC 5322 line max. */
    @Column({ type: 'varchar', length: 998 })
    subject: string;

    @Column({ type: 'text' })
    bodyText: string;

    @Column({ type: 'text', nullable: true })
    bodyHtml?: string | null;

    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, unknown> | null;

    /**
     * EW-P4-3 — attachments of an inbound message (metadata + where the bytes
     * went). NULL for a message without attachments, and for outbound rows.
     */
    @Column({ type: 'simple-json', nullable: true })
    attachments?: EmailMessageAttachmentRecord[] | null;

    /** Caller-supplied idempotency key (`EmailSendInput.messageRef`). */
    @Column({ type: 'varchar', length: 120, nullable: true })
    messageRef?: string | null;

    @PortableDateColumn({ nullable: true })
    sentAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    receivedAt?: Date | null;

    /** Latest known status: accepted | delivered | bounced | complained
     *  | open | click. NULL until the provider's delivery webhook fires. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    deliveryStatus?: string | null;

    /**
     * AW-05 — lifecycle status. Backfilled for existing rows (`sent` for
     * outbound, `received` for inbound); nullable only so a row written by
     * a producer that predates the column still inserts.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    status?: EmailMessageStatus | null;

    /** AW-05 — the `agent_action_proposals` row that mirrors this draft. */
    @Column({ type: 'uuid', nullable: true })
    approvalId?: string | null;

    /** AW-05 — the person who released this draft. NULL until approved. */
    @Column({ type: 'uuid', nullable: true })
    approvedById?: string | null;

    @PortableDateColumn({ nullable: true })
    approvedAt?: Date | null;

    /** AW-05 — why the last send attempt did not go out (provider error or a refused ceiling). */
    @Column({ type: 'varchar', length: 500, nullable: true })
    failureReason?: string | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    /**
     * EW-P4-2 — moves on every write to the row (status, delivery status, the
     * Task link), so `GET /api/integrations/v1/email/messages?updatedSince=`
     * catches every change. Existing rows start at their `createdAt`
     * (migration 1795130300000).
     */
    @UpdateDateColumn()
    updatedAt: Date;

    /**
     * EW-P4-2 — aggregate version of `email.message.*` domain events and the
     * `ETag` of `GET /api/integrations/v1/email/messages/:id`; bumped by
     * `bumpAggregateVersion` on every recorded change. A plain column, NOT
     * `@VersionColumn`.
     */
    @Column({ type: 'int', default: 1 })
    version: number;
}
