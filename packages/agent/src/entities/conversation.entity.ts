import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToMany,
    JoinColumn,
    Index,
} from 'typeorm';
import type {
    ConversationContextType,
    ConversationKind,
    ConversationTitleSource,
} from '@ever-works/contracts';
import { User } from './user.entity';
import { ConversationMessage } from './conversation-message.entity';
import { PortableDateColumn } from './_types';
import { ClassToObject } from './types';

@Entity({ name: 'conversations' })
@Index(['userId', 'updatedAt'])
// Named Conversations — one person's list for one kind, newest activity first.
@Index('idx_conversations_user_kind_activity', ['userId', 'kind', 'lastMessageAt'])
// "Which Conversations is this Agent addressed in" — the per-Agent list.
@Index('idx_conversations_agent_activity', ['agentId', 'lastMessageAt'])
export class Conversation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    @Index()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column({ type: 'varchar', length: 200, nullable: true })
    title?: string;

    @Column({ type: 'varchar', length: 100, nullable: true })
    providerId?: string;

    // `string | null` rather than just optional: clearing the model pin back to
    // "provider default" has to persist as a real NULL, and TypeORM skips
    // `undefined` on update. The column is already nullable — this only makes
    // the TS type tell the truth about it. No schema change, no migration.
    @Column({ type: 'varchar', length: 100, nullable: true })
    model?: string | null;

    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, unknown>;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs.
    // Both NULL until the owning user creates their first Organization
    // (Phase 6 lazy backfill). FK + index enforced at DB level by
    // migration 1779991006000-AddTenantIdAndOrganizationIdToTierA.
    // No @ManyToOne to avoid the entities import cycle that bit Phase 2 —
    // see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    // ── Named Conversations with Agents. All additive: every pre-existing row
    // reads as the assistant thread it always was — a `direct` Conversation
    // with no Agent, no context and no recorded name source. Migration:
    // `1791120000000-AddConversationKindAndParticipants`.

    /**
     * `direct` | `group` | `organization_channel` | `agent_pair`. Defaults to
     * `direct`, which is what every Conversation created before this column
     * already was.
     */
    @Column({ type: 'varchar', length: 24, default: 'direct' })
    kind: ConversationKind;

    /**
     * The Agent a `direct` Conversation is addressed at. Fixed for the life of
     * the Conversation. NULL for the assistant thread. Raw uuid, no relation
     * (entity-cycle rule above); the migration adds the `ON DELETE SET NULL`
     * key so deleting an Agent never deletes the Conversations it was in.
     */
    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    /**
     * Who set `title`: `user` or `auto`. `user` permanently disables the
     * automatic titling in `conversation-title.service.ts` — a name a person
     * chose is never overwritten by a model. Clearing the name resets this to
     * NULL, which lets automatic titling run again.
     */
    @Column({ type: 'varchar', length: 8, nullable: true })
    titleSource?: ConversationTitleSource | null;

    /** `mission` | `task` | `work` | `idea` | `agent` — set at creation, immutable. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    contextType?: ConversationContextType | null;

    /** No key: the table it points into depends on `contextType`. Checked at write time. */
    @Column({ type: 'uuid', nullable: true })
    contextId?: string | null;

    /** Newest message time — orders lists without a correlated subquery. */
    @PortableDateColumn({ nullable: true })
    lastMessageAt?: Date | null;

    @OneToMany(() => ConversationMessage, (msg) => msg.conversation, { cascade: true })
    messages: ClassToObject<ConversationMessage>[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
