import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import type {
    ConversationAttachmentRef,
    ConversationAuthorType,
    ConversationFailureCode,
    ConversationMention,
    ConversationMessageStatus,
} from '@ever-works/contracts';
import { Conversation } from './conversation.entity';
import { ClassToObject } from './types';

export type ConversationMessageRole = 'user' | 'assistant' | 'system' | 'tool';

@Entity({ name: 'conversation_messages' })
@Index(['conversationId', 'createdAt'])
// Failed sends in one Conversation — the retry surface reads exactly these.
@Index('idx_conversation_messages_status', ['conversationId', 'status'])
// Retry idempotency: a client id is stored at most once per Conversation, so a
// double-tapped Retry is refused by the database, not by a race in the service.
@Index('uq_conversation_messages_client_id', ['conversationId', 'clientMessageId'], {
    unique: true,
    where: '"clientMessageId" IS NOT NULL',
})
export class ConversationMessage {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    @Index()
    conversationId: string;

    @ManyToOne(() => Conversation, (conv) => conv.messages, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'conversationId' })
    conversation: ClassToObject<Conversation>;

    /**
     * What the MODEL sees this message as. Unchanged in meaning; still written
     * on every insert. `authorType` below says who actually wrote it — a
     * person's message and an Agent's reply can both be relayed to a model.
     */
    @Column({ type: 'varchar', length: 20 })
    role: ConversationMessageRole;

    @Column({ type: 'text' })
    content: string;

    /** Full UIMessage parts array — preserves tool calls, results, and all part types */
    @Column({ type: 'simple-json', nullable: true })
    parts?: unknown[];

    @Column({ type: 'varchar', length: 100, nullable: true })
    model?: string;

    @Column({ type: 'simple-json', nullable: true })
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };

    // ── Named Conversations with Agents. All additive; every pre-existing row
    // reads as a sent, person-authored message with no mentions.

    /** Who wrote it: `user`, `agent` or `system`. Defaults to `user`. */
    @Column({ type: 'varchar', length: 8, default: 'user' })
    authorType: ConversationAuthorType;

    /** The user id or Agent id of the author. NULL for `system` and legacy rows. */
    @Column({ type: 'uuid', nullable: true })
    authorId?: string | null;

    /** Resolved mentions only — the same shape Task comments store. */
    @Column({ type: 'simple-json', nullable: true })
    mentions?: ConversationMention[] | null;

    @Column({ type: 'simple-json', nullable: true })
    attachments?: ConversationAttachmentRef[] | null;

    /** `sending` | `sent` | `failed`. Defaults to `sent`. */
    @Column({ type: 'varchar', length: 8, default: 'sent' })
    status: ConversationMessageStatus;

    /** Why a `failed` message did not send, as a stable machine token. */
    @Column({ type: 'varchar', length: 40, nullable: true })
    failureCode?: ConversationFailureCode | null;

    /** Client-generated id that makes a retry of the same message idempotent. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    clientMessageId?: string | null;

    /** The message an Agent reply answers. */
    @Column({ type: 'uuid', nullable: true })
    replyToMessageId?: string | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
