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
import { User } from './user.entity';

/**
 * Tasks feature — Phase 11.1 (`features/task-tracking/plan.md §3.1` +
 * recurring columns per operator F5 override §3.3).
 *
 * A `Task` is a trackable work item assigned to people or Agents. It
 * lives in a scope (tenant by default, or scoped to Mission/Idea/Work)
 * and can be a sub-task of another Task. When `isRecurring=true`, the
 * row is a template; the `task-recurrence-dispatcher` cron clones
 * instances from it and points them back via `parentRecurringTaskId`.
 *
 * Scope columns (missionId/ideaId/workId) are deliberately nullable
 * and additive — a Task may be unscoped (tenant Inbox), or pinned to
 * any one of the three. They are NOT mutually exclusive at the schema
 * level; service-layer validation enforces the "exactly zero or one"
 * rule.
 */
export enum TaskStatus {
	BACKLOG = 'backlog',
	TODO = 'todo',
	IN_PROGRESS = 'in_progress',
	IN_REVIEW = 'in_review',
	BLOCKED = 'blocked',
	DONE = 'done',
	CANCELLED = 'cancelled',
}

export enum TaskPriority {
	P0 = 'p0',
	P1 = 'p1',
	P2 = 'p2',
	P3 = 'p3',
	P4 = 'p4',
}

export type TaskActorType = 'user' | 'agent';

@Entity({ name: 'tasks' })
@Index('uq_tasks_slug', ['slug'], { unique: true })
@Index('idx_tasks_user_status', ['userId', 'status'])
@Index('idx_tasks_work', ['workId', 'status'])
@Index('idx_tasks_mission', ['missionId', 'status'])
@Index('idx_tasks_idea', ['ideaId', 'status'])
@Index('idx_tasks_parent', ['parentTaskId'])
// Phase 17 hot path — dispatcher walks rows where (isRecurring, nextOccurrenceAt <= now).
@Index('idx_tasks_recurrence_due', ['isRecurring', 'nextOccurrenceAt'])
export class Task {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	userId: string;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'userId' })
	user?: User;

	@Column({ length: 16 })
	slug: string;

	@Column({ length: 200 })
	title: string;

	@Column({ type: 'text', nullable: true })
	description?: string | null;

	@Column({ type: 'varchar', length: 16, default: TaskStatus.BACKLOG })
	status: TaskStatus;

	@Column({ type: 'varchar', length: 16, nullable: true })
	previousStatus?: TaskStatus | null;

	@Column({ type: 'varchar', length: 4, default: TaskPriority.P3 })
	priority: TaskPriority;

	@Column({ type: 'simple-json', nullable: true })
	labels?: string[] | null;

	@Column({ type: 'uuid', nullable: true })
	missionId?: string | null;

	@Column({ type: 'uuid', nullable: true })
	ideaId?: string | null;

	@Column({ type: 'uuid', nullable: true })
	workId?: string | null;

	@Column({ type: 'uuid', nullable: true })
	parentTaskId?: string | null;

	@Column({ length: 16 })
	createdByType: TaskActorType;

	@Column({ type: 'uuid' })
	createdById: string;

	@Column({ type: 'boolean', default: true })
	requireAllApprovers: boolean;

	@Column({ type: 'timestamp', nullable: true })
	startedAt?: Date | null;

	@Column({ type: 'timestamp', nullable: true })
	completedAt?: Date | null;

	// Reserve-only column — populated in v2 when "promote Task → Idea" lands.
	@Column({ type: 'uuid', nullable: true })
	promotedToIdeaId?: string | null;

	// ── Recurring (F5 override) ────────────────────────────────────
	@Column({ type: 'boolean', default: false })
	isRecurring: boolean;

	@Column({ type: 'varchar', length: 200, nullable: true })
	recurrenceRule?: string | null;

	@Column({ type: 'varchar', length: 64, nullable: true, default: "'UTC'" })
	recurrenceTimezone?: string | null;

	@Column({ type: 'timestamp', nullable: true })
	nextOccurrenceAt?: Date | null;

	@Column({ type: 'timestamp', nullable: true })
	recurrenceEndsAt?: Date | null;

	@Column({ type: 'int', nullable: true })
	recurrenceMaxOccurrences?: number | null;

	@Column({ type: 'int', default: 0 })
	recurrenceOccurredCount: number;

	@Column({ type: 'uuid', nullable: true })
	parentRecurringTaskId?: string | null;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
