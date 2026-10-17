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
import { Task, type TaskAuthorType, type TaskExternalAuthor } from './task.entity';
import { PortableDateColumn } from './_types';

export interface TaskChatMention {
    type: 'user' | 'agent' | 'kb';
    id?: string;
    slug?: string;
}

export interface TaskChatAttachmentRef {
    uploadId: string;
}

/**
 * Tasks feature — Phase 11.2. Per-Task chat thread. Edit window of
 * 5 minutes enforced at service layer (Phase 13). Mention parser
 * (server-side) populates `mentions` from `body` on insert; UI
 * renders mention chips by id+slug.
 */
@Entity({ name: 'task_chat_messages' })
@Index('idx_task_chat_task_created', ['taskId', 'createdAt'])
@Index('idx_task_chat_author', ['authorType', 'authorId'])
// Integration API v1 comment lists (migration 1795080300000).
@Index('idx_task_chat_task_updated', ['taskId', 'updatedAt', 'id'])
export class TaskChatMessage {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    @ManyToOne(() => Task, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'taskId' })
    task?: Task;

    // EW-P1-2: widened 8 → 16 (migration 1795060100000) for `'integration'`.
    @Column({ type: 'varchar', length: 16 })
    authorType: TaskAuthorType;

    @Column({ type: 'uuid' })
    authorId: string;

    @Column({ type: 'text' })
    body: string;

    @Column({ type: 'simple-json', nullable: true })
    mentions?: TaskChatMention[] | null;

    @Column({ type: 'simple-json', nullable: true })
    attachments?: TaskChatAttachmentRef[] | null;

    /**
     * EW-P1-2 — display attribution when an integration posts WITHOUT acting
     * as a user (`authorType = 'integration'`, `authorId` = the key id).
     */
    @Column({ type: 'simple-json', nullable: true })
    externalAuthor?: TaskExternalAuthor | null;

    @PortableDateColumn({ nullable: true })
    editedAt?: Date | null;

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
