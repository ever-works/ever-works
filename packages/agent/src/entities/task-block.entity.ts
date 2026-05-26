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
 * Tasks feature — Phase 11.2. Hard dependency: `taskId` cannot
 * transition past TODO while `blockedByTaskId` is not DONE/CANCELLED.
 * Cycle detection happens server-side on every insert (TaskService).
 */
@Entity({ name: 'task_blocks' })
@Index('uq_task_block', ['taskId', 'blockedByTaskId'], { unique: true })
@Index('idx_task_blocked_by', ['blockedByTaskId'])
export class TaskBlock {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    @ManyToOne(() => Task, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'taskId' })
    task?: Task;

    @Column({ type: 'uuid' })
    blockedByTaskId: string;

    @CreateDateColumn()
    createdAt: Date;
}
