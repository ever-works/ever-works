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
import type {
    ConversationParticipantRole,
    ConversationParticipantType,
} from '@ever-works/contracts';
import { PortableDateColumn } from './_types';
import { Conversation } from './conversation.entity';
import { ClassToObject } from './types';

/**
 * A person or an Agent taking part in a Conversation.
 *
 * Before this row a Conversation had exactly one user and no way to name a
 * second party. Everything that is not strictly one-to-one needs it: the Agent
 * a direct Conversation is addressed at, group membership, read position and
 * mute state.
 *
 * `participantId` is a raw uuid with NO `@ManyToOne` to `User` or `Agent`: the
 * target table depends on `participantType`, and relations from this entity to
 * either would re-open the entities import cycle documented on
 * `conversation.entity.ts` (see the EW-654 note on `user.entity.ts`).
 *
 * A participant leaves by `leftAt`, never by deletion, so the messages an
 * Agent already wrote keep an author after it is removed or deleted.
 *
 * `uq_conversation_participants` is the mechanism that makes concurrent
 * group creation safe: two requests that try to add the same Agent to the
 * same Conversation both reach the insert, and exactly one wins the unique
 * constraint. The loser's repository call catches the violation and returns
 * the winning row instead of failing, so both callers see one participant.
 *
 * Foreign key and indexes: migration `1791120000000-AddConversationKindAndParticipants`.
 */
@Entity({ name: 'conversation_participants' })
@Index('uq_conversation_participants', ['conversationId', 'participantType', 'participantId'], {
    unique: true,
})
@Index('idx_conversation_participants_target', [
    'participantType',
    'participantId',
    'conversationId',
])
export class ConversationParticipant {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    conversationId: string;

    @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'conversationId' })
    conversation?: ClassToObject<Conversation>;

    @Column({ type: 'varchar', length: 8 })
    participantType: ConversationParticipantType;

    /** A user id or an Agent id, depending on `participantType`. */
    @Column({ type: 'uuid' })
    participantId: string;

    @Column({ type: 'varchar', length: 12, default: 'member' })
    role: ConversationParticipantRole;

    @PortableDateColumn()
    joinedAt: Date;

    /** Departure. The row is kept so authored messages keep their author. */
    @PortableDateColumn({ nullable: true })
    leftAt?: Date | null;

    /** Newest message this participant has read; drives the unread marker. */
    @Column({ type: 'uuid', nullable: true })
    lastReadMessageId?: string | null;

    @PortableDateColumn({ nullable: true })
    lastReadAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    mutedAt?: Date | null;

    // Tenant + Organization scope (Tier C denormalization). No @ManyToOne —
    // cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
