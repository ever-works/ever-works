import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import type { TaskIsolationMode } from './task-isolation';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { GateStatus, TaskAcceptanceCheck } from '@ever-works/contracts';
import { Task, TaskPriority, TaskStatus, type TaskActorType } from '../entities/task.entity';
import type { TaskApprover } from '../entities/task-approver.entity';
import { Mission } from '../entities/mission.entity';
import { Team } from '../entities/team.entity';
import { Goal } from '../entities/goal.entity';
import { TaskRepository, type ListTasksFilter } from '../database/repositories/task.repository';
import {
    TaskAssigneeRepository,
    TaskApproverRepository,
    TaskAttachmentRepository,
    TaskReviewerRepository,
    TaskBlockRepository,
    TaskRelationRepository,
    UserTaskCounterRepository,
} from '../database/repositories/task-side.repositories';
import { TaskTransitionService, type TransitionOptions } from './task-transition.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { assertNoSecrets } from '../utils/secret-scan';
import {
    computeNextTemplateOccurrence,
    validateRecurrenceCron,
    validateRecurrenceRule,
} from './recurrence';
import { AgentRepository } from '../database/repositories/agent.repository';
import type { Agent } from '../entities/agent.entity';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { OrganizationMemberRepository } from '../database/repositories/organization-member.repository';
import { TenantRepository } from '../database/repositories/tenant.repository';
import type { AgentRunStatus } from '../entities/agent-run.entity';
import { TaskNotificationService } from './task-notification.service';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkProposalRepository } from '../user-research/work-proposal.repository';
import {
    ownershipRelationScopeOf,
    ownershipScopeMatches,
    ownershipScopeOf,
    ownershipStamp,
    ownershipWhereWith,
    type OwnershipScope,
} from '../database/ownership-scope';

export interface CreateTaskInput {
    title: string;
    description?: string | null;
    status?: TaskStatus;
    priority?: TaskPriority;
    labels?: string[] | null;
    isolationMode?: TaskIsolationMode | null;
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
    teamId?: string | null;
    agentId?: string | null;
    goalId?: string | null;
    parentTaskId?: string | null;
    createdByType: TaskActorType;
    createdById: string;
    /** Schedule mode "Scheduled": run once at this instant (must be in
     *  the future). Omitted/null = not scheduled. */
    scheduledAt?: Date | null;
    requireAllApprovers?: boolean;
    /** Quality gates: `null` = inherit the Work's `checkDefaults` untouched. */
    acceptanceChecks?: TaskAcceptanceCheck[] | null;
    /** Quality gates: `null` = inherit the Work's budget (clamped 1..5 at resolve). */
    maxGateAttempts?: number | null;
    /**
     * Judgment layer G9 — sub-agent delegation depth.
     *
     * SERVER-WRITTEN ONLY. The delegation runner passes
     * `parent.delegationDepth + 1`; nothing else should set it, and it is
     * deliberately absent from `CreateTaskDto` so a client cannot declare
     * itself shallow and recurse past the cap.
     */
    delegationDepth?: number | null;
    /**
     * Keep the Task off the Kanban board and default lists.
     *
     * SERVER-WRITTEN ONLY, like `delegationDepth`: inbound triggers with
     * `showOnBoard: false` set it on the Tasks their fires produce, and
     * it is deliberately absent from `CreateTaskDto` so a client cannot
     * file work that is invisible to the humans who own the board.
     */
    hiddenFromBoard?: boolean;
}

export interface UpdateTaskInput {
    title?: string;
    description?: string | null;
    priority?: TaskPriority;
    labels?: string[] | null;
    isolationMode?: TaskIsolationMode | null;
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
    teamId?: string | null;
    agentId?: string | null;
    goalId?: string | null;
    parentTaskId?: string | null;
    requireAllApprovers?: boolean;
    /** Quality gates: `null` reverts to inheriting the Work's `checkDefaults`. */
    acceptanceChecks?: TaskAcceptanceCheck[] | null;
    /** Quality gates: `null` reverts to inheriting the Work's budget. */
    maxGateAttempts?: number | null;
    /**
     * Schedule mode "Scheduled": run once at this instant (must be in the
     * future). `null` clears the schedule — the same effect as
     * {@link TasksService.unscheduleTask}, so a form that edits the whole
     * Task does not need a second round-trip.
     */
    scheduledAt?: Date | null;
}

/**
 * The optional owners a Task can be filed against.
 *
 * Ownership is non-exclusive by design: a Task raised by a Mission, worked
 * by an Agent, and belonging to a Work is one Task with three associations,
 * not three Tasks. Each owner is independently filterable.
 */
export const TASK_OWNER_KEYS = [
    'workId',
    'missionId',
    'ideaId',
    'teamId',
    'agentId',
    'goalId',
] as const;

export type TaskOwnerKey = (typeof TASK_OWNER_KEYS)[number];

/**
 * Kanban run cockpit (Wave 2 M2) — compact latest-run embed attached to
 * list rows when the caller passes `includeRun=true`. Deliberately a
 * projection, not the AgentRun entity: the board chip needs exactly
 * these fields and nothing sensitive (no errorMessage/summary/
 * workspaceMeta) should ride along on every list response.
 */
export interface TaskRunEmbed {
    id: string;
    status: AgentRunStatus;
    currentActivity: string | null;
    totalTokens: number | null;
    /**
     * Cost telemetry (Wave 4 M7) - settled cost for this run in integer
     * cents. Sibling of `totalTokens`, which the board chip already
     * rendered; without it the cockpit could show how much the run
     * THOUGHT and not how much it COST. `null` for a run that has not
     * settled (or predates the column).
     */
    costCents: number | null;
    changedFilesCount: number | null;
    startedAt: Date | null;
    /** Quality gates (Wave 3 M6) — latest-run gate verdict for the board
     *  chip. `null` = the run never reached (or has no) gate step. */
    gateStatus: GateStatus | null;
}

export type TaskWithRun = Task & { run?: TaskRunEmbed | null };

// ── Sub-tasks projection (Tasks upgrades) ─────────────────────────

/**
 * Hard cap on the sub-tasks projection. A workflow template tops out at
 * `MAX_TEMPLATE_STEPS` (30) sub-tasks; 200 leaves headroom for
 * hand-built trees while keeping the two batched side-table queries
 * bounded. Deeper trees are worked from the Tasks list, not the
 * checklist.
 */
export const SUBTASKS_PAGE_SIZE = 200;

/** One row of the Task-detail Subtasks checklist. */
export type TaskSubtaskRow = Task & {
    /** Agent assignees on this sub-task — the row's agent chips. */
    agentAssigneeIds: string[];
    userAssigneeIds: string[];
    approverCount: number;
    approvedCount: number;
    /** True when the sub-task carries at least one approver row. */
    requiresApproval: boolean;
    /** Gate verdict under the row's own `requireAllApprovers` policy. */
    approvalCleared: boolean;
};

export interface TaskSubtasksProjection {
    rows: TaskSubtaskRow[];
    /** Total matching children (may exceed `rows.length` at the cap). */
    total: number;
    /** Checklist numerator — children already in `done`. */
    doneCount: number;
}

// ── Board dispatch (kanban M3 / M4) ───────────────────────────────

/**
 * Stable machine codes on the board-dispatch failures. The board keys
 * its behaviour off these, never off the message: `RUN_AGENT_AMBIGUOUS`
 * and `RUN_NO_AGENT` open the agent picker, `RUN_ALREADY_IN_FLIGHT`
 * points at the live run instead.
 */
export const RUN_ALREADY_IN_FLIGHT = 'RUN_ALREADY_IN_FLIGHT' as const;
export const RUN_AGENT_AMBIGUOUS = 'RUN_AGENT_AMBIGUOUS' as const;
export const RUN_NO_AGENT = 'RUN_NO_AGENT' as const;
export const RUN_AGENT_NOT_FOUND = 'RUN_AGENT_NOT_FOUND' as const;

/** Hard cap on `runTasksBatch` — a board action, not a bulk job runner. */
export const RUN_BATCH_MAX_TASKS = 20;

/** One row of the board's agent picker. */
export interface RunCandidateAgent {
    id: string;
    name: string;
    slug?: string;
    status?: string;
    /** Why this Agent is offered — drives the picker's grouping/labels. */
    source: 'assignee' | 'task' | 'work-default';
}

export interface RunTaskResult {
    taskId: string;
    agentId: string;
    runId: string | null;
    dispatched: boolean;
    parked: boolean;
    queuedReason?: string;
    error?: string;
}

export type RunBatchItemResult =
    | { taskId: string; ok: true; run: RunTaskResult }
    | { taskId: string; ok: false; error: { code: string; message: string } };

/**
 * Pull the machine code out of a thrown Nest exception whose response
 * body we shaped ourselves; anything else reports as `RUN_FAILED`. Used
 * only by the batch path, where per-item failures are DATA rather than
 * an aborted request.
 */
function extractErrorCode(err: unknown): string {
    const response = (err as { getResponse?: () => unknown })?.getResponse?.();
    if (response && typeof response === 'object') {
        const code = (response as { code?: unknown }).code;
        if (typeof code === 'string') return code;
    }
    return 'RUN_FAILED';
}

@Injectable()
export class TasksService {
    private readonly logger = new Logger(TasksService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly assignees: TaskAssigneeRepository,
        private readonly reviewers: TaskReviewerRepository,
        private readonly approvers: TaskApproverRepository,
        private readonly blocks: TaskBlockRepository,
        private readonly relations: TaskRelationRepository,
        private readonly counter: UserTaskCounterRepository,
        private readonly transitions: TaskTransitionService,
        @Optional() private readonly activityLog?: ActivityLogService,
        @Optional() private readonly attachments?: TaskAttachmentRepository,
        // Review-fix I4: validate Agent assignee existence. Optional()
        // keeps the unit-test surface that mocks TasksService without
        // the Agent graph working.
        @Optional() private readonly agents?: AgentRepository,
        // Review-fix I13: in-app notification emit on assign.
        @Optional() private readonly notifications?: TaskNotificationService,
        @Optional() private readonly workUploads?: WorkKnowledgeUploadRepository,
        @Optional() private readonly works?: WorkRepository,
        @Optional()
        @InjectRepository(Mission)
        private readonly missions?: Repository<Mission>,
        @Optional() private readonly ideas?: WorkProposalRepository,
        @Optional()
        @InjectRepository(Team)
        private readonly teams?: Repository<Team>,
        @Optional()
        @InjectRepository(Goal)
        private readonly goals?: Repository<Goal>,
        // Kanban run cockpit (Wave 2 M2) — batch latest-run embed for the
        // `includeRun` list option. Appended LAST + Optional so positional
        // test fixtures keep compiling and graphs without the Agents module
        // simply skip the embed.
        @Optional() private readonly agentRuns?: AgentRunRepository,
        @Optional() private readonly users?: UserRepository,
        @Optional() private readonly organizationMembers?: OrganizationMemberRepository,
        @Optional() private readonly tenants?: TenantRepository,
    ) {}

    /**
     * Review-fix I4: shared validator for assignee / reviewer / approver
     * add paths. The persisted Task scope is authoritative: an Agent must
     * exist in that exact scope, and a user actor must be an active member
     * of the exact Organization roster (or the Tenant owner). Personal
     * Tasks can only point back to their owner. Every mismatch shares one
     * response so a known UUID is not an Organization-roster oracle.
     */
    private async assertActorIsValid(
        userId: string,
        actorType: TaskActorType,
        actorId: string,
        task: Task,
    ): Promise<void> {
        if (!actorId || actorId.trim().length === 0) {
            throw new BadRequestException(`${actorType} id is required.`);
        }
        const taskScope = ownershipScopeOf(task);
        if (actorType === 'agent' && this.agents) {
            const agent = await this.agents
                .findByIdAndUser(actorId, userId, ownershipRelationScopeOf(task))
                .catch(() => null);
            if (!agent) {
                throw new BadRequestException('Task actor is not reachable in this Task scope.');
            }
            return;
        }

        if (actorType !== 'user') return;
        const actor = this.users ? await this.users.findById(actorId).catch(() => null) : null;
        let reachable = Boolean(actor?.isActive);

        if (reachable && taskScope.organizationId) {
            reachable = actor?.tenantId === taskScope.tenantId;
            if (reachable && taskScope.tenantId) {
                const member = this.organizationMembers
                    ? await this.organizationMembers
                          .findByOrgAndUser(taskScope.organizationId, actorId)
                          .catch(() => null)
                    : null;
                reachable = Boolean(
                    member?.organizationId === taskScope.organizationId &&
                    member?.tenantId === taskScope.tenantId &&
                    member?.userId === actorId,
                );
                if (!reachable) {
                    const tenant = this.tenants
                        ? await this.tenants.findById(taskScope.tenantId).catch(() => null)
                        : null;
                    reachable = tenant?.ownerUserId === actorId;
                }
            } else {
                reachable = false;
            }
        } else if (reachable) {
            reachable = actorId === task.userId;
        }

        if (!reachable) {
            throw new BadRequestException('Task actor is not reachable in this Task scope.');
        }
    }

    async list(
        userId: string,
        filter: ListTasksFilter = {},
        opts: { includeRun?: boolean } = {},
        ownershipScope?: OwnershipScope,
    ): Promise<{ rows: TaskWithRun[]; total: number }> {
        const { rows, total } = await this.tasks.findByUserIdFiltered(
            userId,
            filter,
            ownershipScope,
        );
        if (!opts.includeRun || rows.length === 0 || !this.agentRuns) {
            return { rows, total };
        }
        // Kanban run cockpit (Wave 2 M2) — batch-embed the latest AgentRun
        // per returned row via ONE IN query on the denormalized
        // `latestRunId` pointers. No N+1 by construction.
        //
        // Security: the batch is keyed exclusively on the `latestRunId`
        // values of rows `findByUserIdFiltered` already scoped to the
        // acting user — never on client input — so a foreign run id can
        // only enter this query if it was denormalized onto a task the
        // user owns, which only `TaskRunDenormService` (server-side, from
        // owner-validated dispatch paths) ever does. Cross-user runs are
        // therefore unreachable through this embed.
        const runIds = [
            ...new Set(
                rows
                    .map((row) => row.latestRunId)
                    .filter((id): id is string => typeof id === 'string' && id.length > 0),
            ),
        ];
        if (runIds.length === 0) {
            return { rows, total };
        }
        let runsById = new Map<string, TaskRunEmbed>();
        try {
            const runs = await this.agentRuns.findByIds(runIds, userId, ownershipScope);
            runsById = new Map(
                runs.map((run) => [
                    run.id,
                    {
                        id: run.id,
                        status: run.status,
                        currentActivity: run.currentActivity ?? null,
                        totalTokens: run.totalTokens ?? null,
                        costCents: run.costCents ?? null,
                        changedFilesCount: run.changedFilesCount ?? null,
                        startedAt: run.startedAt ?? null,
                        gateStatus: run.gateStatus ?? null,
                    },
                ]),
            );
        } catch (err) {
            // Best-effort embed: the list itself must not fail because the
            // runs table hiccuped — rows simply ship without `run`.
            this.logger.warn(`includeRun embed failed (${runIds.length} run ids): ${err}`);
            return { rows, total };
        }
        const withRuns: TaskWithRun[] = rows.map((row) => ({
            ...row,
            run: (row.latestRunId && runsById.get(row.latestRunId)) || null,
        }));
        return { rows: withRuns, total };
    }

    async getOne(userId: string, id: string, scope?: OwnershipScope): Promise<Task> {
        const task = await this.tasks.findByIdAndUser(id, userId, scope);
        if (!task || !ownershipScopeMatches(task, scope)) {
            throw new NotFoundException(`Task ${id} not found.`);
        }

        // A Work-scoped Task carries two authoritative scope rows. Both must
        // agree with the active request; accepting the Task row alone lets a
        // stale/malformed cross-Organization workId dispatch in the wrong
        // workspace. Fail closed when the Work repository is unavailable.
        if (scope && task.workId) {
            const work = this.works ? await this.works.findById(task.workId) : null;
            if (!work || work.userId !== userId || !ownershipScopeMatches(work, scope)) {
                throw new NotFoundException(`Task ${id} not found.`);
            }
        }
        return task;
    }

    /**
     * Tasks upgrades — the Subtasks section projection.
     *
     * The sub-task checklist needs three things per row that the plain
     * Task row does not carry: which Agents are on it, whether it is
     * approval-gated, and whether that gate has cleared. Fetching those
     * per row would be a 3N query storm on a template-instantiated tree
     * (nine steps = 27 queries), so both side tables are batched into ONE
     * `IN` query each and grouped in memory.
     *
     * Owner-scoped: the parent id is resolved through {@link getOne}
     * first, so a foreign parent 404s before any side row is read, and
     * the child rows come from the user-scoped list query.
     */
    async listSubtasks(
        userId: string,
        parentTaskId: string,
        ownershipScope?: OwnershipScope,
    ): Promise<TaskSubtasksProjection> {
        await this.getOne(userId, parentTaskId, ownershipScope);
        const { rows, total } = await this.tasks.findByUserIdFiltered(
            userId,
            {
                parentTaskId,
                limit: SUBTASKS_PAGE_SIZE,
            },
            ownershipScope,
        );

        const ids = rows.map((row) => row.id);
        const [assigneeRows, approverRows] = await Promise.all([
            this.assignees.findByTaskIds(ids).catch(() => []),
            this.approvers.findByTaskIds(ids).catch(() => []),
        ]);

        const agentsByTask = new Map<string, string[]>();
        const usersByTask = new Map<string, string[]>();
        for (const row of assigneeRows) {
            const bucket = row.assigneeType === 'agent' ? agentsByTask : usersByTask;
            const list = bucket.get(row.taskId) ?? [];
            list.push(row.assigneeId);
            bucket.set(row.taskId, list);
        }

        const approversByTask = new Map<string, TaskApprover[]>();
        for (const row of approverRows) {
            const list = approversByTask.get(row.taskId) ?? [];
            list.push(row);
            approversByTask.set(row.taskId, list);
        }

        const subtasks: TaskSubtaskRow[] = rows.map((row) => {
            const rowApprovers = approversByTask.get(row.id) ?? [];
            const approved = rowApprovers.filter((a) => a.approvalState === 'approved').length;
            return {
                ...row,
                agentAssigneeIds: agentsByTask.get(row.id) ?? [],
                userAssigneeIds: usersByTask.get(row.id) ?? [],
                approverCount: rowApprovers.length,
                approvedCount: approved,
                // The badge the checklist renders: gated at all, and
                // whether the gate has cleared under the Task's own
                // all-vs-any approver policy.
                requiresApproval: rowApprovers.length > 0,
                approvalCleared:
                    rowApprovers.length === 0
                        ? true
                        : row.requireAllApprovers
                          ? approved === rowApprovers.length
                          : approved > 0,
            };
        });

        return {
            rows: subtasks,
            total,
            doneCount: subtasks.filter((row) => row.status === TaskStatus.DONE).length,
        };
    }

    async create(
        userId: string,
        input: CreateTaskInput,
        ownershipScope?: OwnershipScope,
    ): Promise<Task> {
        // Ownership is deliberately NOT exclusive. A Task may belong to a
        // Work and a Team and have been raised by a Mission at the same
        // time; the previous "exactly zero or one of missionId/ideaId/workId"
        // rule made that impossible to express.
        await this.assertScopeReachable(userId, input, ownershipScope);
        this.assertTitle(input.title);
        if (input.description) assertNoSecrets(input.description, 'task.description');

        // Validate parent cycle (root task has no parent).
        // Review-fix C8: also walk the parent chain to bound depth +
        // detect existing-cyclic data before insertion. Self-cycle is
        // impossible for a brand-new id, but a malformed parent chain
        // pointing into existing-cyclic data would propagate downstream.
        if (input.parentTaskId) {
            const parent = await this.tasks.findByIdAndUser(
                input.parentTaskId,
                userId,
                ownershipScope,
            );
            if (!parent) {
                throw new BadRequestException(`Parent Task ${input.parentTaskId} not found.`);
            }
            this.assertParentScopeMatches(
                {
                    missionId: input.missionId ?? null,
                    ideaId: input.ideaId ?? null,
                    workId: input.workId ?? null,
                    teamId: input.teamId ?? null,
                    agentId: input.agentId ?? null,
                    goalId: input.goalId ?? null,
                },
                parent,
            );
            // Walk parent chain to detect pre-existing cyclic data.
            // PASS-4 fix: 64-hop cap now THROWS on overflow instead
            // of silent pass — a chain deeper than 64 is either
            // pathological or actually cyclic somewhere out of reach,
            // and either way we should refuse rather than silently
            // proceed (the previous behavior would have inserted into
            // a chain we couldn't fully validate).
            let cursor: string | null = parent.parentTaskId ?? null;
            const seen = new Set<string>([input.parentTaskId]);
            let hops = 0;
            while (cursor) {
                if (hops >= 64) {
                    throw new BadRequestException(
                        `Parent Task chain exceeds depth 64; refusing to add child for safety. Re-anchor the chain closer to the root before retrying.`,
                    );
                }
                if (seen.has(cursor)) {
                    throw new BadRequestException(
                        `Parent Task ${input.parentTaskId} is on an existing cycle; reparent it first.`,
                    );
                }
                seen.add(cursor);
                const ancestor = await this.tasks.findByIdAndUser(cursor, userId, ownershipScope);
                if (!ancestor) break;
                cursor = ancestor.parentTaskId ?? null;
                hops += 1;
            }
        }

        if (input.scheduledAt) this.assertFutureSchedule(input.scheduledAt);

        const nextNumber = await this.counter.nextSlug(userId);
        const slug = `T-${nextNumber}`;

        const created = await this.tasks.create({
            userId,
            ...ownershipStamp(ownershipScope),
            slug,
            title: input.title.trim(),
            description: input.description ?? null,
            status: input.status ?? TaskStatus.BACKLOG,
            priority: input.priority ?? TaskPriority.P3,
            labels: input.labels ?? null,
            isolationMode: input.isolationMode ?? null,
            missionId: input.missionId ?? null,
            ideaId: input.ideaId ?? null,
            workId: input.workId ?? null,
            teamId: input.teamId ?? null,
            agentId: input.agentId ?? null,
            goalId: input.goalId ?? null,
            parentTaskId: input.parentTaskId ?? null,
            createdByType: input.createdByType,
            createdById: input.createdById,
            requireAllApprovers: input.requireAllApprovers ?? true,
            acceptanceChecks: input.acceptanceChecks ?? null,
            maxGateAttempts: input.maxGateAttempts ?? null,
            delegationDepth: input.delegationDepth ?? null,
            scheduledAt: input.scheduledAt ?? null,
            scheduleClaimedAt: null,
            hiddenFromBoard: input.hiddenFromBoard ?? false,
        });

        await this.logActivity({
            userId,
            taskId: created.id,
            actionType: ActivityActionType.TASK_CREATED,
            details: { slug: created.slug, title: created.title },
        });
        return created;
    }

    async update(
        userId: string,
        id: string,
        input: UpdateTaskInput,
        ownershipScope?: OwnershipScope,
    ): Promise<Task> {
        const task = await this.getOne(userId, id, ownershipScope);
        const patch: Partial<Task> = {};

        if (input.title !== undefined) {
            this.assertTitle(input.title);
            patch.title = input.title.trim();
        }
        if (input.description !== undefined) {
            if (input.description) assertNoSecrets(input.description, 'task.description');
            patch.description = input.description;
        }
        if (input.priority !== undefined) patch.priority = input.priority;
        if (input.labels !== undefined) patch.labels = input.labels;
        if (input.isolationMode !== undefined) patch.isolationMode = input.isolationMode;
        if (input.acceptanceChecks !== undefined) patch.acceptanceChecks = input.acceptanceChecks;
        if (input.maxGateAttempts !== undefined) patch.maxGateAttempts = input.maxGateAttempts;
        if (input.requireAllApprovers !== undefined)
            patch.requireAllApprovers = input.requireAllApprovers;
        // Schedule mode "Scheduled" via the generic PATCH. Same rules as
        // the dedicated `scheduleTask` endpoint: future-only, never on a
        // recurring template, and any stale dispatcher claim is cleared so
        // the new slot actually fires.
        if (input.scheduledAt !== undefined) {
            if (input.scheduledAt === null) {
                patch.scheduledAt = null;
            } else {
                this.assertFutureSchedule(input.scheduledAt);
                if (task.isRecurring) {
                    throw new BadRequestException(
                        'This Task is a recurring template — stop the recurrence before scheduling a one-shot run.',
                    );
                }
                patch.scheduledAt = input.scheduledAt;
            }
            patch.scheduleClaimedAt = null;
        }

        // Re-filing a Task under different owners. Each owner is set
        // independently — passing `null` detaches just that one. Any newly
        // supplied owner is validated for reachability exactly as on create,
        // so a caller cannot attach a Task to something they cannot see.
        const ownerPatch: Partial<Record<TaskOwnerKey, string | null>> = {};
        for (const key of TASK_OWNER_KEYS) {
            if (input[key] !== undefined) {
                ownerPatch[key] = input[key] ?? null;
            }
        }
        // Only owners that actually CHANGE count. Re-sending the current
        // value (a full-object PATCH from a client) must be a no-op, not a
        // trigger for the sub-task guard below.
        for (const key of TASK_OWNER_KEYS) {
            if (key in ownerPatch && ownerPatch[key] === (task[key] ?? null)) {
                delete ownerPatch[key];
            }
        }

        // The owner tuple this row will hold AFTER the patch — every
        // hierarchy check below validates against this, never against the
        // stale pre-patch row.
        const nextOwners = { ...task, ...ownerPatch } as Pick<Task, TaskOwnerKey>;
        const ownersChanged = Object.keys(ownerPatch).length > 0;

        if (ownersChanged) {
            await this.assertScopeReachable(
                userId,
                {
                    ...ownerPatch,
                } as CreateTaskInput,
                ownershipScope,
            );

            // Re-filing a Task must not break the sub-task hierarchy. The
            // create path enforces "a child agrees with its parent on every
            // owner"; the same must hold against the parent this row will
            // ACTUALLY have after this request:
            //   - explicit `parentTaskId: null` detaches — no parent to
            //     agree with, so no check (`?? task.parentTaskId` here
            //     would wrongly validate against the parent being severed);
            //   - a new parentTaskId is validated in the parent block below
            //     against the same post-patch tuple.
            const effectiveParentId =
                input.parentTaskId !== undefined ? input.parentTaskId : task.parentTaskId;
            if (effectiveParentId) {
                const parent = await this.tasks.findByIdAndUser(
                    effectiveParentId,
                    userId,
                    ownershipScope,
                );
                if (parent) {
                    this.assertParentScopeMatches(nextOwners, parent);
                }
            }

            // The symmetric case: moving a PARENT would strand its children,
            // which cannot be fixed by validating this row alone. Refuse
            // rather than leave the tree inconsistent — the caller can move
            // the children first, or detach them.
            const { total: childCount } = await this.tasks.findByUserIdFiltered(
                userId,
                {
                    parentTaskId: id,
                    limit: 1,
                },
                ownershipScope,
            );
            if (childCount > 0) {
                throw new BadRequestException(
                    `Task ${id} has ${childCount} sub-task(s); re-file or detach them before changing its owners so parent and child scopes cannot diverge.`,
                );
            }

            Object.assign(patch, ownerPatch);
        }

        if (input.parentTaskId !== undefined) {
            if (input.parentTaskId === null) {
                patch.parentTaskId = null;
            } else {
                const parent = await this.tasks.findByIdAndUser(
                    input.parentTaskId,
                    userId,
                    ownershipScope,
                );
                if (!parent) {
                    throw new BadRequestException(`Parent Task ${input.parentTaskId} not found.`);
                }
                // Validate against the POST-patch owner tuple. Using the
                // stale row here rejected every coherent "move to Work B and
                // re-parent under a Work-B parent" in one PATCH: the owner
                // block approved the move, then this check compared the OLD
                // owners against the NEW parent and threw.
                this.assertParentScopeMatches(nextOwners, parent);
                const isCycle = await this.tasks.wouldCreateCycle(
                    id,
                    input.parentTaskId,
                    userId,
                    ownershipScope,
                );
                if (isCycle) {
                    throw new ConflictException(
                        `Cannot set parent — would create a sub-task cycle.`,
                    );
                }
                patch.parentTaskId = input.parentTaskId;
            }
        }

        await this.tasks.updateById(id, patch);
        const refreshed = await this.getOne(userId, id, ownershipScope);
        await this.logActivity({
            userId,
            taskId: id,
            actionType: ActivityActionType.TASK_UPDATED,
            details: this.diffFor(task, refreshed),
        });
        return refreshed;
    }

    async remove(
        userId: string,
        id: string,
        ownershipScope?: OwnershipScope,
    ): Promise<{ deleted: true }> {
        const task = await this.getOne(userId, id, ownershipScope);
        await this.tasks.deleteById(id);
        await this.logActivity({
            userId,
            taskId: id,
            actionType: ActivityActionType.TASK_DELETED,
            details: { slug: task.slug },
        });
        return { deleted: true };
    }

    /**
     * Phase 17.2 — make a Task recurring (or update its rule).
     *
     * Accepts EITHER an RFC 5545 RRULE (`recurrenceRule`) OR a 5-field
     * cron expression (`recurrenceCron`) — exactly one (XOR, service
     * validation). Computes the initial `nextOccurrenceAt` (RRULE via
     * the `rrule` package, cron via `cadence.ts#computeNextCronFire`)
     * and flips the recurring columns. The Task row stays as the
     * TEMPLATE; the dispatcher spawns instances pointing back via
     * `parentRecurringTaskId`.
     */
    async setRecurring(
        userId: string,
        id: string,
        input: {
            recurrenceRule?: string | null;
            recurrenceCron?: string | null;
            recurrenceTimezone?: string;
            recurrenceEndsAt?: Date | null;
            recurrenceMaxOccurrences?: number | null;
        },
        ownershipScope?: OwnershipScope,
    ): Promise<Task> {
        await this.getOne(userId, id, ownershipScope);
        const hasRule = !!input.recurrenceRule;
        const hasCron = !!input.recurrenceCron;
        if (hasRule === hasCron) {
            // XOR: both or neither is a caller error — the two cadence
            // dialects would disagree about the next fire.
            throw new BadRequestException(
                'Provide exactly one of recurrenceRule (RRULE) or recurrenceCron (cron expression).',
            );
        }
        if (hasRule) {
            const check = validateRecurrenceRule(input.recurrenceRule!);
            if (check.valid === false) {
                // Post-rebase narrowing fix: TS doesn't infer `reason` from
                // `!check.valid` alone on this discriminated union; explicit
                // equality narrowing surfaces the `false` branch correctly.
                throw new BadRequestException(check.reason);
            }
        } else {
            const check = validateRecurrenceCron(input.recurrenceCron!);
            if (check.valid === false) {
                throw new BadRequestException(check.reason);
            }
        }

        const next = computeNextTemplateOccurrence({
            rule: input.recurrenceRule ?? null,
            cron: input.recurrenceCron ?? null,
            from: new Date(),
            recurrenceEndsAt: input.recurrenceEndsAt ?? null,
            recurrenceMaxOccurrences: input.recurrenceMaxOccurrences ?? null,
            recurrenceOccurredCount: 0,
        });
        if (!next) {
            throw new BadRequestException(
                'Recurrence yields no future occurrences — refusing to mark as recurring.',
            );
        }

        await this.tasks.updateById(id, {
            isRecurring: true,
            recurrenceRule: input.recurrenceRule ?? null,
            recurrenceCron: input.recurrenceCron ?? null,
            recurrenceTimezone: input.recurrenceTimezone ?? 'UTC',
            nextOccurrenceAt: next,
            recurrenceEndsAt: input.recurrenceEndsAt ?? null,
            recurrenceMaxOccurrences: input.recurrenceMaxOccurrences ?? null,
        });
        return this.getOne(userId, id, ownershipScope);
    }

    /** Phase 17.2 — turn off recurrence on a template. Existing
     * spawned instances are untouched. */
    async clearRecurring(
        userId: string,
        id: string,
        ownershipScope?: OwnershipScope,
    ): Promise<Task> {
        await this.getOne(userId, id, ownershipScope);
        await this.tasks.updateById(id, {
            isRecurring: false,
            recurrenceRule: null,
            recurrenceCron: null,
            nextOccurrenceAt: null,
            recurrenceEndsAt: null,
            recurrenceMaxOccurrences: null,
        });
        return this.getOne(userId, id, ownershipScope);
    }

    // ── Schedule mode "Scheduled" (one-shot) ──────────────────────

    /**
     * Schedule this Task to run once at `runAt`. Re-scheduling an
     * already-scheduled Task moves the slot and clears any claim so
     * the dispatcher picks up the NEW time. Mutually exclusive with
     * recurrence — a recurring template already has a cadence.
     */
    async scheduleTask(
        userId: string,
        id: string,
        runAt: Date,
        ownershipScope?: OwnershipScope,
    ): Promise<Task> {
        const task = await this.getOne(userId, id, ownershipScope);
        this.assertFutureSchedule(runAt);
        if (task.isRecurring) {
            throw new BadRequestException(
                'This Task is a recurring template — stop the recurrence before scheduling a one-shot run.',
            );
        }
        await this.tasks.updateById(id, { scheduledAt: runAt, scheduleClaimedAt: null });
        await this.logActivity({
            userId,
            taskId: id,
            actionType: ActivityActionType.TASK_UPDATED,
            details: { scheduledAt: runAt.toISOString() },
        });
        return this.getOne(userId, id, ownershipScope);
    }

    /** Remove the one-shot schedule (mode back to Run Once). */
    async unscheduleTask(
        userId: string,
        id: string,
        ownershipScope?: OwnershipScope,
    ): Promise<Task> {
        await this.getOne(userId, id, ownershipScope);
        await this.tasks.updateById(id, { scheduledAt: null, scheduleClaimedAt: null });
        await this.logActivity({
            userId,
            taskId: id,
            actionType: ActivityActionType.TASK_UPDATED,
            details: { scheduledAt: null },
        });
        return this.getOne(userId, id, ownershipScope);
    }

    private assertFutureSchedule(runAt: Date): void {
        if (!(runAt instanceof Date) || Number.isNaN(runAt.getTime())) {
            throw new BadRequestException('runAt must be a valid datetime.');
        }
        if (runAt.getTime() <= Date.now()) {
            throw new BadRequestException('runAt must be in the future.');
        }
    }

    // ── Board dispatch (kanban M3/M4) ─────────────────────────────

    /**
     * Agents that could run this Task, most-specific first:
     *
     *   1. its Agent assignees (the fan-out set a drag-to-in-progress
     *      would dispatch), then
     *   2. its own `agentId` column, then
     *   3. the Works's Work-scoped Agents — "the Work's default agent".
     *
     * Deduped by id, owner-scoped throughout, never throws (a lookup
     * failure degrades to the candidates gathered so far, so the picker
     * still opens with whatever is knowable).
     */
    async listRunCandidates(
        userId: string,
        taskId: string,
        ownershipScope?: OwnershipScope,
    ): Promise<RunCandidateAgent[]> {
        const task = await this.getOne(userId, taskId, ownershipScope);
        const out = new Map<string, RunCandidateAgent>();

        const push = (id: string, source: RunCandidateAgent['source'], agent?: Agent | null) => {
            if (!id || out.has(id)) return;
            out.set(id, {
                id,
                name: agent?.name ?? agent?.slug ?? id,
                ...(agent?.slug ? { slug: agent.slug } : {}),
                ...(agent?.status ? { status: agent.status } : {}),
                source,
            });
        };

        try {
            const assigned = await this.assignees.findAgentAssignees(taskId);
            for (const row of assigned) {
                const agent = this.agents
                    ? await this.agents
                          .findByIdAndUser(row.assigneeId, userId, ownershipScope)
                          .catch(() => null)
                    : null;
                // An assignee row whose Agent is gone (or belongs to
                // someone else) is not a candidate — the picker must
                // never offer something dispatch would reject.
                if (agent) push(row.assigneeId, 'assignee', agent);
            }
        } catch (err) {
            this.logger.warn(`Run candidates: assignee lookup failed for task ${taskId}: ${err}`);
        }

        if (task.agentId && this.agents) {
            const agent = await this.agents
                .findByIdAndUser(task.agentId, userId, ownershipScope)
                .catch(() => null);
            if (agent) push(task.agentId, 'task', agent);
        }

        if (task.workId && this.agents) {
            try {
                const { rows } = await this.agents.findByUserIdScoped(
                    userId,
                    {
                        workId: task.workId,
                        limit: 25,
                    },
                    ownershipScope,
                );
                for (const agent of rows) push(agent.id, 'work-default', agent);
            } catch (err) {
                this.logger.warn(`Run candidates: Work-agent lookup failed for ${taskId}: ${err}`);
            }
        }

        return [...out.values()];
    }

    /**
     * Board dispatch (kanban M3) — run this Task now.
     *
     * Resolution order is `agentId` (explicit) → the Task's assigned
     * Agent → the Work's default Agent, and an AMBIGUOUS or EMPTY
     * resolution is a 400 carrying the candidate list, which is exactly
     * what the board's agent picker renders. Dispatch itself goes
     * through `TaskTransitionService.dispatchAgentRun` — the same path
     * the drag-to-in-progress fan-out uses — so the concurrency valve,
     * the credits precheck and the board denorm all apply unchanged.
     *
     * 409 `RUN_ALREADY_IN_FLIGHT` when this (Task, Agent) pair already
     * has a queued/running run: the answer to "run it again" while it is
     * still running is to steer the live run, never to race a second one.
     */
    async runTask(
        userId: string,
        taskId: string,
        opts: { agentId?: string | null } = {},
        ownershipScope?: OwnershipScope,
    ): Promise<RunTaskResult> {
        const task = await this.getOne(userId, taskId, ownershipScope);
        const agentId = await this.resolveRunAgentId(
            userId,
            taskId,
            opts.agentId ?? null,
            ownershipScope,
        );

        if (this.agentRuns) {
            const inFlight = await this.agentRuns
                .findInFlightForTaskAgent(taskId, agentId, userId, ownershipScope)
                .catch(() => null);
            if (inFlight) {
                throw new ConflictException({
                    code: RUN_ALREADY_IN_FLIGHT,
                    message:
                        'This Task already has a run in flight for that Agent. Steer or cancel it before starting another.',
                    runId: inFlight.id,
                    agentId,
                    status: inFlight.status,
                });
            }
        }

        // Board dispatch is an explicit, human "go" — discriminate the
        // dedup key by time so it can never collide with the generation
        // key a status transition would use for the same pair.
        const dispatch = await this.transitions.dispatchAgentRun(task, agentId, {
            dedupKey: `${taskId}:${agentId}:manual:${Date.now()}`,
        });

        await this.logActivity({
            userId,
            taskId,
            actionType: ActivityActionType.TASK_TRANSITIONED,
            details: {
                action: 'run',
                agentId,
                runId: dispatch.runId,
                dispatched: dispatch.dispatched,
                parked: dispatch.parked,
            },
        });

        return { taskId, agentId, ...dispatch };
    }

    /**
     * Board dispatch (kanban M4) — run up to
     * {@link RUN_BATCH_MAX_TASKS} Tasks in one call, each independently.
     *
     * Per-item results, never all-or-nothing: a Task with no agent, one
     * already running, and one that dispatches cleanly must all report
     * their own outcome. Nothing here bypasses `runTask`, so the
     * conflict rule and the dispatch gate hold identically per item.
     */
    async runTasksBatch(
        userId: string,
        items: { taskId: string; agentId?: string | null }[],
        ownershipScope?: OwnershipScope,
    ): Promise<{ results: RunBatchItemResult[] }> {
        if (!Array.isArray(items) || items.length === 0) {
            throw new BadRequestException('At least one task is required.');
        }
        if (items.length > RUN_BATCH_MAX_TASKS) {
            throw new BadRequestException(
                `At most ${RUN_BATCH_MAX_TASKS} tasks can be run in one batch (received ${items.length}).`,
            );
        }
        const results: RunBatchItemResult[] = [];
        for (const item of items) {
            try {
                const run = await this.runTask(
                    userId,
                    item.taskId,
                    { agentId: item.agentId },
                    ownershipScope,
                );
                results.push({ taskId: item.taskId, ok: true, run });
            } catch (err) {
                results.push({
                    taskId: item.taskId,
                    ok: false,
                    error: {
                        code: extractErrorCode(err),
                        message: err instanceof Error ? err.message : String(err),
                    },
                });
            }
        }
        return { results };
    }

    /** Explicit → assignee → Work default, with the picker-shaped 400s. */
    private async resolveRunAgentId(
        userId: string,
        taskId: string,
        explicitAgentId: string | null,
        ownershipScope?: OwnershipScope,
    ): Promise<string> {
        if (explicitAgentId) {
            if (!this.agents) {
                throw new BadRequestException('Agent repository not wired in this context.');
            }
            const agent = await this.agents.findByIdAndUser(
                explicitAgentId,
                userId,
                ownershipScope,
            );
            if (!agent || !ownershipScopeMatches(agent, ownershipScope)) {
                // 400 (not 404) and no existence leak: from the caller's
                // side an id they do not own and an id that never existed
                // are the same unusable input.
                throw new BadRequestException({
                    code: RUN_AGENT_NOT_FOUND,
                    message: `Agent ${explicitAgentId} not found.`,
                });
            }
            return explicitAgentId;
        }

        const candidates = await this.listRunCandidates(userId, taskId, ownershipScope);
        if (candidates.length === 1) return candidates[0].id;
        if (candidates.length === 0) {
            throw new BadRequestException({
                code: RUN_NO_AGENT,
                message:
                    'This Task has no Agent assigned and its Work has no Agent to fall back on. Assign an Agent, or pass agentId.',
                candidates,
            });
        }
        throw new BadRequestException({
            code: RUN_AGENT_AMBIGUOUS,
            message: `This Task has ${candidates.length} possible Agents — pass agentId to choose one.`,
            candidates,
        });
    }

    async transition(
        userId: string,
        id: string,
        to: TaskStatus,
        // `actorType: 'agent'` (quality gates, Wave 3 M8) activates the
        // red-gate review refusal in TaskTransitionService; human/API
        // callers omit it and are unaffected.
        opts: TransitionOptions = {},
        ownershipScope?: OwnershipScope,
    ): Promise<Task> {
        const task = await this.getOne(userId, id, ownershipScope);
        const from = task.status;
        const result = await this.transitions.transition(task, to, opts);
        await this.logActivity({
            userId,
            taskId: id,
            actionType: ActivityActionType.TASK_TRANSITIONED,
            details: { from, to, force: opts.force ?? false },
        });
        return result;
    }

    // ── Members ───────────────────────────────────────────────────

    /**
     * Wrap a sub-resource insert so a DB UNIQUE-violation surfaces as a clean
     * 409 Conflict instead of an unmapped 500. Mirrors the inline guard that
     * `addBlocker` / `addAttachment` already use — extracted so the assignee /
     * reviewer / approver / relation adds (which previously 500'd on a duplicate)
     * share one tested path.
     */
    private async insertOrConflict<T>(op: () => Promise<T>, conflictMessage: string): Promise<T> {
        try {
            return await op();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/unique|duplicate|UNIQUE/i.test(message)) {
                throw new ConflictException(conflictMessage);
            }
            throw err;
        }
    }

    async addAssignee(
        userId: string,
        taskId: string,
        assigneeType: TaskActorType,
        assigneeId: string,
        ownershipScope?: OwnershipScope,
    ) {
        const task = await this.getOne(userId, taskId, ownershipScope);
        // Review-fix I4: validate the actor exists / belongs to user.
        await this.assertActorIsValid(userId, assigneeType, assigneeId, task);
        const row = await this.insertOrConflict(
            () => this.assignees.add(taskId, assigneeType, assigneeId),
            `Task ${taskId} already has assignee ${assigneeId}.`,
        );
        await this.logActivity({
            userId,
            taskId,
            actionType: ActivityActionType.TASK_ASSIGNEE_ADDED,
            details: { assigneeType, assigneeId },
        });
        // Review-fix I13: in-app notification on assign. Best-effort —
        // failure inside emit logs there, doesn't bubble. Only fires
        // for user-type assignees (agent-type assignees get notified
        // via the dispatch hook in TaskTransitionService instead).
        if (assigneeType === 'user' && this.notifications) {
            void this.notifications
                .emit(
                    'task_assigned',
                    {
                        taskId,
                        taskSlug: task.slug,
                        taskTitle: task.title,
                        actorUserId: userId,
                    },
                    [assigneeId],
                )
                .catch(() => undefined);
        }
        return row;
    }

    async removeAssignee(
        userId: string,
        taskId: string,
        assigneeId: string,
        ownershipScope?: OwnershipScope,
    ) {
        await this.getOne(userId, taskId, ownershipScope);
        const removed = await this.assignees.removeForTask(taskId, assigneeId);
        if (!removed) {
            throw new NotFoundException(`Assignee ${assigneeId} not found.`);
        }
        await this.logActivity({
            userId,
            taskId,
            actionType: ActivityActionType.TASK_ASSIGNEE_REMOVED,
            details: { assigneeId },
        });
        return { deleted: true } as const;
    }

    async addReviewer(
        userId: string,
        taskId: string,
        reviewerType: TaskActorType,
        reviewerId: string,
        ownershipScope?: OwnershipScope,
    ) {
        const task = await this.getOne(userId, taskId, ownershipScope);
        // Review-fix I4: validate the actor exists / belongs to user.
        await this.assertActorIsValid(userId, reviewerType, reviewerId, task);
        return this.insertOrConflict(
            () => this.reviewers.add(taskId, reviewerType, reviewerId),
            `Task ${taskId} already has reviewer ${reviewerId}.`,
        );
    }

    async addApprover(
        userId: string,
        taskId: string,
        approverType: TaskActorType,
        approverId: string,
        ownershipScope?: OwnershipScope,
    ) {
        const task = await this.getOne(userId, taskId, ownershipScope);
        // Review-fix I4: validate the actor exists / belongs to user.
        await this.assertActorIsValid(userId, approverType, approverId, task);
        return this.insertOrConflict(
            () => this.approvers.add(taskId, approverType, approverId),
            `Task ${taskId} already has approver ${approverId}.`,
        );
    }

    async addBlocker(
        userId: string,
        taskId: string,
        blockedByTaskId: string,
        ownershipScope?: OwnershipScope,
    ) {
        await this.getOne(userId, taskId, ownershipScope);
        if (taskId === blockedByTaskId) {
            throw new BadRequestException('Task cannot block itself.');
        }
        const blocker = await this.tasks.findByIdAndUser(blockedByTaskId, userId, ownershipScope);
        if (!blocker) {
            throw new BadRequestException(`Blocking Task ${blockedByTaskId} not found.`);
        }
        // Third-pass fix: catch the unique-violation on
        // `(taskId, blockedByTaskId)` so a concurrent duplicate-add
        // surfaces as 409 instead of 500.
        let row;
        try {
            row = await this.blocks.add(taskId, blockedByTaskId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/unique|duplicate|UNIQUE/i.test(message)) {
                throw new ConflictException(
                    `Task ${taskId} is already blocked by ${blockedByTaskId}.`,
                );
            }
            throw err;
        }
        await this.logActivity({
            userId,
            taskId,
            actionType: ActivityActionType.TASK_BLOCKER_ADDED,
            details: { blockedByTaskId },
        });
        return row;
    }

    async removeBlocker(
        userId: string,
        taskId: string,
        blockId: string,
        ownershipScope?: OwnershipScope,
    ) {
        await this.getOne(userId, taskId, ownershipScope);
        const removed = await this.blocks.removeForTask(taskId, blockId);
        if (!removed) {
            throw new NotFoundException(`Blocker ${blockId} not found.`);
        }
        // Review-fix I1 (second-pass NEW-bug corrected): removing a
        // block row may unblock the DEPENDENT task (`taskId` itself).
        // The previous call used `autoUnblockResolvedTasks(taskId)`,
        // which interprets the arg as the BLOCKER and looks for tasks
        // blocked BY it — wrong direction. Now uses the dedicated
        // `recheckUnblockFor(taskId)` helper that handles the
        // single-task case correctly. Fire-and-forget — keeps the
        // `removeBlocker` response shape unchanged.
        void this.transitions.recheckUnblockFor(taskId).catch(() => undefined);
        return { deleted: true } as const;
    }

    async addRelation(
        userId: string,
        taskId: string,
        relatedTaskId: string,
        kind: 'related' | 'duplicates' | 'follow-up',
        ownershipScope?: OwnershipScope,
    ) {
        await this.getOne(userId, taskId, ownershipScope);
        // A task cannot relate to itself (mirrors the addBlocker self-guard).
        if (taskId === relatedTaskId) {
            throw new BadRequestException('Task cannot relate to itself.');
        }
        const related = await this.tasks.findByIdAndUser(relatedTaskId, userId, ownershipScope);
        if (!related) {
            throw new BadRequestException(`Related Task ${relatedTaskId} not found.`);
        }
        // The unique index is on (taskId, relatedTaskId) and EXCLUDES `kind`, so
        // a second relation on the same ordered pair (even with a different kind)
        // collides — surface that as 409, not an unmapped 500.
        return this.insertOrConflict(
            () => this.relations.add(taskId, relatedTaskId, kind),
            `Task ${taskId} already has a relation to ${relatedTaskId}.`,
        );
    }

    // ── Phase 13.5 — attachments ──────────────────────────────────

    async listAttachments(userId: string, taskId: string, ownershipScope?: OwnershipScope) {
        await this.getOne(userId, taskId, ownershipScope);
        if (!this.attachments) return [];
        return this.attachments.findByTaskId(taskId);
    }

    /**
     * Attach an existing `work_knowledge_upload` row to a Task. The
     * upload itself flows through the existing KB upload pipeline
     * (the user uploads once, then attaches the resulting uploadId
     * to a Task / KB doc / etc.). Cross-user 404 enforced on the
     * Task; the uploadId is taken as-is — ownership validation of
     * the upload row lives in the existing KB upload service.
     */
    async addAttachment(
        userId: string,
        taskId: string,
        uploadId: string,
        role: 'initial' | 'result' = 'initial',
        ownershipScope?: OwnershipScope,
    ) {
        const task = await this.getOne(userId, taskId, ownershipScope);
        if (!uploadId) throw new BadRequestException('uploadId is required.');
        if (role !== 'initial' && role !== 'result') {
            throw new BadRequestException(`Invalid attachment role: ${role}`);
        }
        if (!this.attachments) {
            throw new BadRequestException('Attachment repository not wired in this context.');
        }
        if (!task.workId) {
            throw new BadRequestException(
                'Task attachments require a Work-scoped task so upload ownership can be verified.',
            );
        }
        if (!this.workUploads) {
            throw new BadRequestException('Work upload repository not wired in this context.');
        }
        const upload = await this.workUploads.findById(task.workId, uploadId);
        if (!upload) {
            throw new BadRequestException(`Upload ${uploadId} not found for this Task's Work.`);
        }
        try {
            return await this.attachments.add(taskId, uploadId, role);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/unique|duplicate|UNIQUE/i.test(message)) {
                const existing = (await this.attachments.findByTaskId(taskId)).find(
                    (a) => a.uploadId === uploadId,
                );
                if (existing) return existing;
            }
            throw err;
        }
    }

    async removeAttachment(
        userId: string,
        taskId: string,
        attachmentId: string,
        ownershipScope?: OwnershipScope,
    ) {
        await this.getOne(userId, taskId, ownershipScope);
        if (!this.attachments) {
            throw new BadRequestException('Attachment repository not wired in this context.');
        }
        const removed = await this.attachments.removeForTask(taskId, attachmentId);
        if (!removed) {
            throw new NotFoundException(`Attachment ${attachmentId} not found.`);
        }
        return { deleted: true } as const;
    }

    // ── internals ─────────────────────────────────────────────────

    private assertTitle(title: string): void {
        if (!title || title.trim().length < 1) {
            throw new BadRequestException('Task title is required.');
        }
        if (title.length > 200) {
            throw new BadRequestException('Task title exceeds 200 characters.');
        }
    }

    private async assertScopeReachable(
        userId: string,
        input: CreateTaskInput,
        ownershipScope?: OwnershipScope,
    ): Promise<void> {
        if (input.workId) {
            if (!this.works) {
                throw new BadRequestException('Work repository not wired in this context.');
            }
            const work = await this.works.findById(input.workId);
            if (!work || work.userId !== userId || !ownershipScopeMatches(work, ownershipScope)) {
                throw new BadRequestException(`Work ${input.workId} not found.`);
            }
        }
        if (input.missionId) {
            if (!this.missions) {
                throw new BadRequestException('Mission repository not wired in this context.');
            }
            const mission = await this.missions.findOne({
                where: ownershipWhereWith<Mission>(userId, ownershipScope, {
                    id: input.missionId,
                }),
                select: ['id', 'userId'],
            });
            if (!mission) {
                throw new BadRequestException(`Mission ${input.missionId} not found.`);
            }
        }
        if (input.ideaId) {
            if (!this.ideas) {
                throw new BadRequestException('Idea repository not wired in this context.');
            }
            const idea = await this.ideas.findByIdForUser(input.ideaId, userId);
            if (!idea || !ownershipScopeMatches(idea, ownershipScope)) {
                throw new BadRequestException(`Idea ${input.ideaId} not found.`);
            }
        }
        // Security: the three newer owners get the same ownership check as
        // the three above. Without it a caller could file their Task against
        // another user's Team / Agent / Goal, which both leaks the existence
        // of that row and pollutes the victim's scoped task lists. The DB
        // foreign key only guarantees the row exists — not that the caller
        // may see it.
        if (input.teamId) {
            if (!this.teams) {
                throw new BadRequestException('Team repository not wired in this context.');
            }
            const team = await this.teams.findOne({
                where: ownershipWhereWith<Team>(userId, ownershipScope, { id: input.teamId }),
                select: ['id'],
            });
            if (!team) {
                throw new BadRequestException(`Team ${input.teamId} not found.`);
            }
        }
        if (input.agentId) {
            if (!this.agents) {
                throw new BadRequestException('Agent repository not wired in this context.');
            }
            const agent = await this.agents.findByIdAndUser(input.agentId, userId, ownershipScope);
            if (!agent || !ownershipScopeMatches(agent, ownershipScope)) {
                throw new BadRequestException(`Agent ${input.agentId} not found.`);
            }
        }
        if (input.goalId) {
            if (!this.goals) {
                throw new BadRequestException('Goal repository not wired in this context.');
            }
            const goal = await this.goals.findOne({
                where: ownershipWhereWith<Goal>(userId, ownershipScope, { id: input.goalId }),
                select: ['id'],
            });
            if (!goal) {
                throw new BadRequestException(`Goal ${input.goalId} not found.`);
            }
        }
    }

    private assertParentScopeMatches(
        child: Pick<Task, TaskOwnerKey>,
        parent: Pick<Task, TaskOwnerKey>,
    ): void {
        const childScope = this.scopeKey(child);
        const parentScope = this.scopeKey(parent);
        if (childScope !== parentScope) {
            throw new BadRequestException(
                `Parent Task scope (${parentScope}) must match child Task scope (${childScope}).`,
            );
        }
    }

    /**
     * Stable key describing the FULL owner tuple of a Task.
     *
     * Now that ownership is non-exclusive, a sub-task must agree with its
     * parent on every owner, not just on whichever one happened to be set
     * first. Keys are emitted in the fixed `TASK_OWNER_KEYS` order so two
     * Tasks with the same owners always produce the same string.
     */
    private scopeKey(scope: Pick<Task, TaskOwnerKey>): string {
        const parts: string[] = [];
        for (const key of TASK_OWNER_KEYS) {
            const value = scope[key];
            if (value) {
                parts.push(`${key.slice(0, -2)}:${value}`);
            }
        }
        return parts.length > 0 ? parts.join('|') : 'unscoped';
    }

    private diffFor(before: Task, after: Task): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        const keys: Array<keyof Task> = [
            'title',
            'description',
            'priority',
            'labels',
            'parentTaskId',
            'requireAllApprovers',
        ];
        for (const k of keys) {
            if (before[k] !== after[k]) out[k as string] = { before: before[k], after: after[k] };
        }
        return out;
    }

    private async logActivity(args: {
        userId: string;
        taskId: string;
        actionType: ActivityActionType;
        details?: Record<string, unknown>;
    }): Promise<void> {
        if (!this.activityLog) return;
        try {
            // Post-rebase fix: develop's CreateActivityLogDto dropped
            // `resourceType`/`resourceId` + renamed SUCCESS → COMPLETED.
            await this.activityLog.log({
                userId: args.userId,
                action: args.actionType,
                actionType: args.actionType,
                status: ActivityStatus.COMPLETED,
                summary: `Task ${args.taskId} — ${args.actionType}`,
                details: { ...(args.details ?? {}), resourceType: 'task', resourceId: args.taskId },
            });
        } catch (err) {
            this.logger.warn(`Failed to log activity ${args.actionType}: ${err}`);
        }
    }
}
