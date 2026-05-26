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
 * Tasks feature — Phase 11.2. FK pointer to a row in
 * `work_knowledge_upload` (the existing upload pipeline). Storage
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

	@CreateDateColumn()
	createdAt: Date;
}
