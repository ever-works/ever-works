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
import { Agent } from './agent.entity';
import { PortableDateColumn } from './_types';

export interface EmailConversationParticipant {
    address: string;
    displayName?: string;
}

/**
 * Notifications v2 — Email Providers (EW-650, EW-667).
 *
 * Per-Agent EmailConversation thread (spec §12.2 / §12.3, v1.1).
 *
 * Threading key: derived from `In-Reply-To` headers when present,
 * else normalized subject. Service layer handles derivation — this
 * entity just stores the resolved key + participant list.
 *
 * `EmailMessage.conversationId` points here when the message landed
 * via `conversation` dispatch mode; mutually exclusive with
 * `EmailMessage.taskId`.
 */
@Entity({ name: 'email_conversations' })
@Index('uq_email_conversation_agent_thread', ['agentId', 'threadKey'], { unique: true })
export class EmailConversation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    agentId: string;

    @ManyToOne(() => Agent, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'agentId' })
    agent?: Agent;

    @Column({ type: 'varchar', length: 200 })
    threadKey: string;

    @Column({ type: 'simple-json' })
    participants: EmailConversationParticipant[];

    @PortableDateColumn({ nullable: true })
    lastMessageAt?: Date | null;

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
