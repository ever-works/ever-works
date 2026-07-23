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
import { PortableDateColumn } from './_types';

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
 * Owner columns (workId/missionId/ideaId/teamId/agentId/goalId) are
 * deliberately nullable and additive — a Task may be unscoped (tenant
 * Inbox) or filed against any COMBINATION of them. They are not mutually
 * exclusive at the schema level, and no longer at the service level
 * either: a Task raised by a Mission, worked by an Agent and belonging to
 * a Work is one Task with three associations, not three Tasks. Each owner
 * is independently filterable via `ListTasksFilter`.
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
// Review-fix C1: slug uniqueness is per-user (UserTaskCounter
// increments per user, so two users both produce `T-1`). Global
// unique would deadlock the platform after the second user creates a Task.
@Index('uq_tasks_slug', ['userId', 'slug'], { unique: true })
@Index('idx_tasks_user_status', ['userId', 'status'])
@Index('idx_tasks_work', ['workId', 'status'])
@Index('idx_tasks_mission', ['missionId', 'status'])
@Index('idx_tasks_idea', ['ideaId', 'status'])
// Same (owner, status) shape as the three above — every owner tab lists
// "open tasks for X", so status is always the second predicate.
@Index('idx_tasks_team', ['teamId', 'status'])
@Index('idx_tasks_agent', ['agentId', 'status'])
@Index('idx_tasks_goal', ['goalId', 'status'])
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

    @Column({ type: 'varchar', length: 16 })
    slug: string;

    @Column({ type: 'varchar', length: 200 })
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

    /**
     * Additional optional owners a Task can hang off.
     *
     * A Task is not exclusively owned by any one of these — the same Task
     * may belong to a Work AND be assigned to a Team AND have been raised
     * by a Mission. They are therefore independent nullable columns rather
     * than a polymorphic `(subjectType, subjectId)` pair: every one of them
     * has to be independently filterable ("tasks for this Work",
     * "tasks for this Team"), which a single discriminated pair cannot do.
     *
     * Deliberately NO `@ManyToOne` — the Tier-A scope columns below carry
     * the same note. Adding relations here reintroduces the entities import
     * cycle that bit Phase 2; the FKs are enforced at the DB level by the
     * accompanying migration instead.
     */
    @Column({ type: 'uuid', nullable: true })
    teamId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    goalId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    parentTaskId?: string | null;

    @Column({ type: 'varchar', length: 16 })
    createdByType: TaskActorType;

    @Column({ type: 'uuid' })
    createdById: string;

    @Column({ type: 'boolean', default: true })
    requireAllApprovers: boolean;

    @PortableDateColumn({ nullable: true })
    startedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    completedAt?: Date | null;

    // Reserve-only column — populated in v2 when "promote Task → Idea" lands.
    @Column({ type: 'uuid', nullable: true })
    promotedToIdeaId?: string | null;

    // ── Recurring (F5 override) ────────────────────────────────────
    @Column({ type: 'boolean', default: false })
    isRecurring: boolean;

    @Column({ type: 'varchar', length: 200, nullable: true })
    recurrenceRule?: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true, default: 'UTC' })
    recurrenceTimezone?: string | null;

    @PortableDateColumn({ nullable: true })
    nextOccurrenceAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    recurrenceEndsAt?: Date | null;

    @Column({ type: 'int', nullable: true })
    recurrenceMaxOccurrences?: number | null;

    @Column({ type: 'int', default: 0 })
    recurrenceOccurredCount: number;

    @Column({ type: 'uuid', nullable: true })
    parentRecurringTaskId?: string | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs.
    // Both NULL until the owning user creates their first Organization
    // (Phase 6 lazy backfill). FK + index enforced at DB level by
    // migration 1779991006000-AddTenantIdAndOrganizationIdToTierA.
    // No @ManyToOne to avoid the entities import cycle that bit Phase 2 —
    // see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
