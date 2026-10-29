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
 * APW-08 T54 — who wrote a chat message. {@link TaskAuthorType} plus `'system'`: a platform post
 * (a delivery-chain progress line) on a Task with no Agent to speak for it, stored with
 * `authorId = null`. Kept out of `TaskAuthorType` on purpose: that type is also who CREATED a
 * Task, and the platform never creates one as `'system'`.
 */
export type TaskChatAuthorType = TaskAuthorType | 'system';

/** APW-08 T54 — the values of a keyed post's copy (`{ number: 3 }`, `{ url }`). */
export type TaskChatMessageParams = Record<string, string | number>;

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
    // APW-08 T54: also `'system'` (no DDL — 6 characters fit either width).
    @Column({ type: 'varchar', length: 16 })
    authorType: TaskChatAuthorType;

    // APW-08 T54: nullable (migration 1792330000000) — only ever null on a `'system'` post.
    @Column({ type: 'uuid', nullable: true })
    authorId: string | null;

    /**
     * Always present. For a keyed post (`messageKey` set) it is the pre-rendered ENGLISH copy, so
     * every reader that does not know the key (the integration API, exports, an agent's thread
     * context) reads the same text it always did.
     */
    @Column({ type: 'text' })
    body: string;

    /**
     * APW-08 T54 (FR-43) — the copy key of a platform post, relative to the web's
     * `dashboard.tasksPage` messages (`deliveryPosts.live`), so the Task page renders it in the
     * READER's locale. Null on every message a person, an agent or an integration wrote.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    messageKey?: string | null;

    /** APW-08 T54 — the values `messageKey`'s copy takes. Null when it takes none. */
    @Column({ type: 'simple-json', nullable: true })
    messageParams?: TaskChatMessageParams | null;

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
