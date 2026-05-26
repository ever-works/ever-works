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

/**
 * Tasks feature — Phase 11.2. Many-to-many join between Tasks and
 * actors (users OR agents) who are assigned to do the work. Unique
 * on (taskId, assigneeType, assigneeId) — the same person/Agent
 * can only be assigned once.
 */
@Entity({ name: 'task_assignees' })
@Index('uq_task_assignee', ['taskId', 'assigneeType', 'assigneeId'], { unique: true })
@Index('idx_task_assignee_actor', ['assigneeType', 'assigneeId'])
export class TaskAssignee {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	taskId: string;

	@ManyToOne(() => Task, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'taskId' })
	task?: Task;

	@Column({ length: 8 })
	assigneeType: TaskActorType;

	@Column({ type: 'uuid' })
	assigneeId: string;

	@CreateDateColumn()
	createdAt: Date;
}
