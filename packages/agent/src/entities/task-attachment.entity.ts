import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Task } from './task.entity';

/** Attachment role — see the `role` column note below. */
export type TaskAttachmentRole = 'initial' | 'result';

/**
 * Tasks feature — Phase 11.2. FK pointer to a row in
 * `work_knowledge_uploads` (the existing upload pipeline). Storage
 * + dedup are reused; this row is just the Task→Upload edge.
 */
@Entity({ name: 'task_attachments' })
@Index('uq_task_attachment', ['taskId', 'uploadId'], { unique: true })
@Index('idx_task_attachment_upload', ['uploadId'])
export class TaskAttachment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    @ManyToOne(() => Task, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'taskId' })
    task?: Task;

    @Column({ type: 'uuid' })
    uploadId: string;

    /**
     * What the attachment IS to the Task: `initial` = input material the
     * requester attached; `result` = output an agent (or a human) attached
     * after working the Task. Default keeps every pre-existing row and
     * every plain add on the input side.
     */
    @Column({ type: 'varchar', length: 16, default: 'initial' })
    role: TaskAttachmentRole;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
