import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';
import { TenantEmailAddress } from './tenant-email-address.entity';
import { EmailConversation } from './email-conversation.entity';
import { PortableDateColumn } from './_types';

export type EmailMessageDirection = 'outbound' | 'inbound';

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
 */
@Entity({ name: 'email_messages' })
@Index('idx_email_messages_user_agent_created', ['userId', 'agentId', 'createdAt'])
@Index('idx_email_messages_task_created', ['taskId', 'createdAt'])
@Index('idx_email_messages_conversation_created', ['conversationId', 'createdAt'])
@Index('idx_email_messages_address_created', ['emailAddressId', 'createdAt'])
@Index('uq_email_messages_provider_message', ['pluginId', 'providerMessageId'], {
    unique: true,
})
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

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
