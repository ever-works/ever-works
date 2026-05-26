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
import { Task, type TaskActorType } from './task.entity';

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
export class TaskChatMessage {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	taskId: string;

	@ManyToOne(() => Task, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'taskId' })
	task?: Task;

	@Column({ length: 8 })
	authorType: TaskActorType;

	@Column({ type: 'uuid' })
	authorId: string;

	@Column({ type: 'text' })
	body: string;

	@Column({ type: 'simple-json', nullable: true })
	mentions?: TaskChatMention[] | null;

	@Column({ type: 'simple-json', nullable: true })
	attachments?: TaskChatAttachmentRef[] | null;

	@Column({ type: 'timestamp', nullable: true })
	editedAt?: Date | null;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
