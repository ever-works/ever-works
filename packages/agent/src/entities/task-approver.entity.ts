import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Task, type TaskActorType } from './task.entity';

export type TaskApprovalState = 'pending' | 'approved' | 'rejected';

/**
 * Tasks feature — Phase 11.2. Approvers gate the
 * `in_review → done` transition (via `Task.requireAllApprovers`).
 */
@Entity({ name: 'task_approvers' })
@Index('uq_task_approver', ['taskId', 'approverType', 'approverId'], { unique: true })
@Index('idx_task_approver_actor', ['approverType', 'approverId'])
export class TaskApprover {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    @ManyToOne(() => Task, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'taskId' })
    task?: Task;

    @Column({ length: 8 })
    approverType: TaskActorType;

    @Column({ type: 'uuid' })
    approverId: string;

    @Column({ type: 'varchar', length: 16, default: "'pending'" })
    approvalState: TaskApprovalState;

    @Column({ type: 'timestamp', nullable: true })
    approvedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
