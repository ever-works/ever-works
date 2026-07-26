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
import type { TaskAcceptanceCheck } from '@ever-works/contracts';

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
@Index('idx_tasks_branch_state', ['workId', 'branchState'])
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

    // ── Task isolation (worktree-per-Task, Wave 2 M1) ────────────────

    /** Per-Task override of the Work's `taskIsolation` setting:
     *  NULL = inherit; `'on' | 'off'` force it. Resolution lives in
     *  `tasks-domain/task-isolation.ts` (one function, unit-tested). */
    @Column({ type: 'varchar', length: 8, nullable: true })
    isolationMode?: string | null;

    /** The Task's branch (e.g. `task/t-42-9f3c1a2b`). AUTHORITATIVE once
     *  written — never recomputed, so a slug edit can't orphan it. The
     *  branch is the durable workspace identity in cloud mode. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    branchRef?: string | null;

    /** Branch lifecycle: `none | created | pushed | pr-open | conflict |
     *  merged | discarded`. NULL = isolation never engaged. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    branchState?: string | null;

    /** SHA of the fetched base commit the branch was cut from. */
    @Column({ type: 'varchar', length: 40, nullable: true })
    baseSha?: string | null;

    /** PR opened from the Task branch (community-PR flow). */
    @Column({ type: 'int', nullable: true })
    prNumber?: number | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    prUrl?: string | null;

    /** Named conflicting paths when `branchState='conflict'` — surfaced
     *  verbatim in the blocked banner and the task-chat system message. */
    @Column({ type: 'simple-json', nullable: true })
    conflictPaths?: string[] | null;

    // ── PR insights (kanban run cockpit M5) ──────────────────────────
    // Cache written by `TaskPrStatusService` (on-demand refresh + the
    // `task-pr-status-sync` cron). They live on Task beside `prNumber` /
    // `prUrl` rather than on AgentRun for the SAME reason those do
    // (agent-run.entity.ts: "branchRef/prUrl/prNumber are NOT duplicated
    // here") — the pull request belongs to the Task's branch, which
    // outlives any single run, and a Task accretes many runs against one
    // PR. Plan 04 §4.1 put them on AgentRun; this is the same documented
    // deviation Wave 2 already made, kept consistent on purpose.

    /** `open | draft | closed | merged` as last observed from the provider. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    prState?: string | null;

    /** Rolled-up CI verdict for the PR head: `passing|failing|pending|unknown`. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    ciState?: string | null;

    /** When the PR status was last refreshed — drives the sync throttle. */
    @PortableDateColumn({ nullable: true })
    ciCheckedAt?: Date | null;

    /** Bounded check summary for the pill tooltip (plain text names only). */
    @Column({ type: 'simple-json', nullable: true })
    prChecks?: Array<{
        name: string;
        status: string;
        conclusion?: string | null;
        detailsUrl?: string;
    }> | null;

    // ── Latest-run denorm (kanban run cockpit, Wave 2) ───────────────
    // Maintained by `TaskRunDenormService` on queued creation, claim and
    // terminal transition of task-kind AgentRuns. Denormalized so the
    // board list can batch-embed the latest run per card (single IN
    // query on `latestRunId`) without a per-task latest-run subquery.
    // No `@ManyToOne` — same entities-import-cycle rule as the owner
    // columns above; the pointer is best-effort telemetry, not a FK.

    /** Id of the most recent AgentRun dispatched for this Task. */
    @Column({ type: 'uuid', nullable: true })
    latestRunId?: string | null;

    /** Status mirror of that run (`queued|running|completed|failed|
     *  cancelled`) so list filters/chips don't need the runs table. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    latestRunStatus?: string | null;

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

    // ── Quality gates ──────────────────────────────────────────────
    /**
     * Acceptance checks declared on this Task. `null` = inherit the Work's
     * `checkDefaults` untouched. Merge semantics (a same-id entry replaces
     * the Work default; `disabled: true` suppresses it) live in
     * `tasks-domain/task-gates.ts#resolveAcceptanceChecks` — executors must
     * read the resolved list, never this column directly, or suppression
     * entries would be run as commands.
     */
    @Column({ type: 'simple-json', nullable: true })
    acceptanceChecks?: TaskAcceptanceCheck[] | null;

    /**
     * Gate-attempt budget for this Task. `null` = inherit the Work's value
     * (whose column default is 2). Clamped to 1..5 at resolve time so a
     * hand-edited row can never grant an unbounded retry loop.
     */
    @Column({ type: 'int', nullable: true })
    maxGateAttempts?: number | null;

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
