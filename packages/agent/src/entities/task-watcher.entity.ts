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
import { User } from './user.entity';

/**
 * Tasks feature — Phase 11.2. Explicit subscriptions. A watcher
 * gets notifications for state-machine transitions on the watched
 * Task without being assigned/reviewer/approver.
 */
@Entity({ name: 'task_watchers' })
@Index('uq_task_watcher', ['taskId', 'userId'], { unique: true })
@Index('idx_task_watcher_user', ['userId'])
export class TaskWatcher {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    @ManyToOne(() => Task, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'taskId' })
    task?: Task;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @CreateDateColumn()
    createdAt: Date;
}
