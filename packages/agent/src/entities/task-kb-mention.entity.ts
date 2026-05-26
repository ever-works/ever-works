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

/**
 * Tasks feature — Phase 11.2. Materialized KB references for the
 * "Related" panel on the Task detail page. Built from the mention
 * parser at insert time so the panel is cheap to render without a
 * full-text join over chat messages.
 */
@Entity({ name: 'task_kb_mentions' })
@Index('uq_task_kb_mention', ['taskId', 'kbDocumentId'], { unique: true })
@Index('idx_task_kb_mention_doc', ['kbDocumentId'])
export class TaskKbMention {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    @ManyToOne(() => Task, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'taskId' })
    task?: Task;

    @Column({ type: 'uuid' })
    kbDocumentId: string;

    @CreateDateColumn()
    createdAt: Date;
}
