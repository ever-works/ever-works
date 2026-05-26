import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { Task, TaskPriority, TaskStatus, type TaskActorType } from '../entities/task.entity';
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
import { TaskTransitionService } from './task-transition.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { assertNoSecrets } from '../utils/secret-scan';
import { computeNextOccurrence, validateRecurrenceRule } from './recurrence';
import { AgentRepository } from '../database/repositories/agent.repository';
import { TaskNotificationService } from './task-notification.service';

export interface CreateTaskInput {
    title: string;
    description?: string | null;
    status?: TaskStatus;
    priority?: TaskPriority;
    labels?: string[] | null;
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
    parentTaskId?: string | null;
    createdByType: TaskActorType;
    createdById: string;
    requireAllApprovers?: boolean;
}

export interface UpdateTaskInput {
    title?: string;
    description?: string | null;
    priority?: TaskPriority;
    labels?: string[] | null;
    parentTaskId?: string | null;
    requireAllApprovers?: boolean;
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
    ) {}

    /**
     * Review-fix I4: shared validator for assignee / reviewer / approver
     * add paths. For `agent` actor type, the Agent must belong to the
     * acting user (cross-user is rejected with a 400). For `user` actor
     * type we just sanity-check the id is a non-empty string — full
     * user-existence validation requires a UserRepository in this graph
     * and is deferred to the API layer's @CurrentUser() resolution.
     */
    private async assertActorIsValid(
        userId: string,
        actorType: TaskActorType,
        actorId: string,
    ): Promise<void> {
        if (!actorId || actorId.trim().length === 0) {
            throw new BadRequestException(`${actorType} id is required.`);
        }
        if (actorType === 'agent' && this.agents) {
            const agent = await this.agents.findByIdAndUser(actorId, userId).catch(() => null);
            if (!agent) {
                throw new BadRequestException(
                    `Agent ${actorId} is not reachable for this user — cannot assign.`,
                );
            }
        }
    }

    async list(
        userId: string,
        filter: ListTasksFilter = {},
    ): Promise<{ rows: Task[]; total: number }> {
        return this.tasks.findByUserIdFiltered(userId, filter);
    }

    async getOne(userId: string, id: string): Promise<Task> {
        const task = await this.tasks.findByIdAndUser(id, userId);
        if (!task) throw new NotFoundException(`Task ${id} not found.`);
        return task;
    }

    async create(userId: string, input: CreateTaskInput): Promise<Task> {
        this.assertScopeExclusivity(input);
        this.assertTitle(input.title);
        if (input.description) assertNoSecrets(input.description, 'task.description');

        // Validate parent cycle (root task has no parent).
        // Review-fix C8: also walk the parent chain to bound depth +
        // detect existing-cyclic data before insertion. Self-cycle is
        // impossible for a brand-new id, but a malformed parent chain
        // pointing into existing-cyclic data would propagate downstream.
        if (input.parentTaskId) {
            const parent = await this.tasks.findByIdAndUser(input.parentTaskId, userId);
            if (!parent) {
                throw new BadRequestException(`Parent Task ${input.parentTaskId} not found.`);
            }
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
                const ancestor = await this.tasks.findByIdAndUser(cursor, userId);
                if (!ancestor) break;
                cursor = ancestor.parentTaskId ?? null;
                hops += 1;
            }
        }

        const nextNumber = await this.counter.nextSlug(userId);
        const slug = `T-${nextNumber}`;

        const created = await this.tasks.create({
            userId,
            slug,
            title: input.title.trim(),
            description: input.description ?? null,
            status: input.status ?? TaskStatus.BACKLOG,
            priority: input.priority ?? TaskPriority.P3,
            labels: input.labels ?? null,
            missionId: input.missionId ?? null,
            ideaId: input.ideaId ?? null,
            workId: input.workId ?? null,
            parentTaskId: input.parentTaskId ?? null,
            createdByType: input.createdByType,
            createdById: input.createdById,
            requireAllApprovers: input.requireAllApprovers ?? true,
        });

        await this.logActivity({
            userId,
            taskId: created.id,
            actionType: ActivityActionType.TASK_CREATED,
            details: { slug: created.slug, title: created.title },
        });
        return created;
    }

    async update(userId: string, id: string, input: UpdateTaskInput): Promise<Task> {
        const task = await this.getOne(userId, id);
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
        if (input.requireAllApprovers !== undefined)
            patch.requireAllApprovers = input.requireAllApprovers;

        if (input.parentTaskId !== undefined) {
            if (input.parentTaskId === null) {
                patch.parentTaskId = null;
            } else {
                const isCycle = await this.tasks.wouldCreateCycle(id, input.parentTaskId);
                if (isCycle) {
                    throw new ConflictException(
                        `Cannot set parent — would create a sub-task cycle.`,
                    );
                }
                patch.parentTaskId = input.parentTaskId;
            }
        }

        await this.tasks.updateById(id, patch);
        const refreshed = (await this.tasks.findById(id)) as Task;
        await this.logActivity({
            userId,
            taskId: id,
            actionType: ActivityActionType.TASK_UPDATED,
            details: this.diffFor(task, refreshed),
        });
        return refreshed;
    }

    async remove(userId: string, id: string): Promise<{ deleted: true }> {
        const task = await this.getOne(userId, id);
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
     * Validates the RRULE, computes the initial `nextOccurrenceAt`,
     * and flips the recurring columns. The Task row stays as the
     * TEMPLATE; the dispatcher spawns instances pointing back via
     * `parentRecurringTaskId`.
     */
    async setRecurring(
        userId: string,
        id: string,
        input: {
            recurrenceRule: string;
            recurrenceTimezone?: string;
            recurrenceEndsAt?: Date | null;
            recurrenceMaxOccurrences?: number | null;
        },
    ): Promise<Task> {
        const task = await this.getOne(userId, id);
        const check = validateRecurrenceRule(input.recurrenceRule);
        if (check.valid === false) {
            // Post-rebase narrowing fix: TS doesn't infer `reason` from
            // `!check.valid` alone on this discriminated union; explicit
            // equality narrowing surfaces the `false` branch correctly.
            throw new BadRequestException(check.reason);
        }

        const next = computeNextOccurrence({
            rule: input.recurrenceRule,
            from: new Date(),
            recurrenceEndsAt: input.recurrenceEndsAt ?? null,
            recurrenceMaxOccurrences: input.recurrenceMaxOccurrences ?? null,
            recurrenceOccurredCount: 0,
        });
        if (!next) {
            throw new BadRequestException(
                'recurrenceRule yields no future occurrences — refusing to mark as recurring.',
            );
        }

        await this.tasks.updateById(id, {
            isRecurring: true,
            recurrenceRule: input.recurrenceRule,
            recurrenceTimezone: input.recurrenceTimezone ?? 'UTC',
            nextOccurrenceAt: next,
            recurrenceEndsAt: input.recurrenceEndsAt ?? null,
            recurrenceMaxOccurrences: input.recurrenceMaxOccurrences ?? null,
        });
        const refreshed = (await this.tasks.findById(id)) as Task;
        void task;
        return refreshed;
    }

    /** Phase 17.2 — turn off recurrence on a template. Existing
     * spawned instances are untouched. */
    async clearRecurring(userId: string, id: string): Promise<Task> {
        await this.getOne(userId, id);
        await this.tasks.updateById(id, {
            isRecurring: false,
            recurrenceRule: null,
            nextOccurrenceAt: null,
            recurrenceEndsAt: null,
            recurrenceMaxOccurrences: null,
        });
        return (await this.tasks.findById(id)) as Task;
    }

    async transition(
        userId: string,
        id: string,
        to: TaskStatus,
        opts: { force?: boolean } = {},
    ): Promise<Task> {
        const task = await this.getOne(userId, id);
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

    async addAssignee(
        userId: string,
        taskId: string,
        assigneeType: TaskActorType,
        assigneeId: string,
    ) {
        const task = await this.getOne(userId, taskId);
        // Review-fix I4: validate the actor exists / belongs to user.
        await this.assertActorIsValid(userId, assigneeType, assigneeId);
        const row = await this.assignees.add(taskId, assigneeType, assigneeId);
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

    async removeAssignee(userId: string, taskId: string, assigneeId: string) {
        await this.getOne(userId, taskId);
        await this.assignees.remove(assigneeId);
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
    ) {
        await this.getOne(userId, taskId);
        // Review-fix I4: validate the actor exists / belongs to user.
        await this.assertActorIsValid(userId, reviewerType, reviewerId);
        return this.reviewers.add(taskId, reviewerType, reviewerId);
    }

    async addApprover(
        userId: string,
        taskId: string,
        approverType: TaskActorType,
        approverId: string,
    ) {
        await this.getOne(userId, taskId);
        // Review-fix I4: validate the actor exists / belongs to user.
        await this.assertActorIsValid(userId, approverType, approverId);
        return this.approvers.add(taskId, approverType, approverId);
    }

    async addBlocker(userId: string, taskId: string, blockedByTaskId: string) {
        await this.getOne(userId, taskId);
        if (taskId === blockedByTaskId) {
            throw new BadRequestException('Task cannot block itself.');
        }
        const blocker = await this.tasks.findByIdAndUser(blockedByTaskId, userId);
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

    async removeBlocker(userId: string, taskId: string, blockId: string) {
        await this.getOne(userId, taskId);
        await this.blocks.remove(blockId);
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
    ) {
        await this.getOne(userId, taskId);
        const related = await this.tasks.findByIdAndUser(relatedTaskId, userId);
        if (!related) {
            throw new BadRequestException(`Related Task ${relatedTaskId} not found.`);
        }
        return this.relations.add(taskId, relatedTaskId, kind);
    }

    // ── Phase 13.5 — attachments ──────────────────────────────────

    async listAttachments(userId: string, taskId: string) {
        await this.getOne(userId, taskId);
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
    async addAttachment(userId: string, taskId: string, uploadId: string) {
        await this.getOne(userId, taskId);
        if (!uploadId) throw new BadRequestException('uploadId is required.');
        if (!this.attachments) {
            throw new BadRequestException('Attachment repository not wired in this context.');
        }
        return this.attachments.add(taskId, uploadId);
    }

    async removeAttachment(userId: string, taskId: string, attachmentId: string) {
        await this.getOne(userId, taskId);
        if (!this.attachments) {
            throw new BadRequestException('Attachment repository not wired in this context.');
        }
        await this.attachments.remove(attachmentId);
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

    private assertScopeExclusivity(input: CreateTaskInput): void {
        const popCount = [input.missionId, input.ideaId, input.workId].filter(Boolean).length;
        if (popCount > 1) {
            throw new BadRequestException(
                'Task must be scoped to exactly zero or one of missionId / ideaId / workId.',
            );
        }
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
