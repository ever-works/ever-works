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
import { User } from './user.entity';
import { ConversationMessage } from './conversation-message.entity';
import { ClassToObject } from './types';

@Entity({ name: 'conversations' })
@Index(['userId', 'updatedAt'])
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

    @Column({ type: 'varchar', length: 100, nullable: true })
    model?: string;

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

    @OneToMany(() => ConversationMessage, (msg) => msg.conversation, { cascade: true })
    messages: ClassToObject<ConversationMessage>[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
