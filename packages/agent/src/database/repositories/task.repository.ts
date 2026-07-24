import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Task, TaskStatus } from '../../entities/task.entity';
import { sanitizeLikePattern } from '../utils';

export interface ListTasksFilter {
    status?: TaskStatus | TaskStatus[];
    priority?: string | string[];
    missionId?: string;
    ideaId?: string;
    workId?: string;
    teamId?: string;
    agentId?: string;
    goalId?: string;
    parentTaskId?: string;
    label?: string;
    search?: string;
    limit?: number;
    offset?: number;
}

/**
 * Tasks feature — Phase 11.5.
 *
 * Custom repository for `tasks`. Owns CRUD + cycle detection on
 * sub-task assignment + CAS-claim for the recurrence dispatcher
 * (Phase 17). Cross-user reads route through `findByIdAndUser`
 * so the service can 404 instead of leaking existence.
 */
@Injectable()
export class TaskRepository {
    constructor(
        @InjectRepository(Task)
        private readonly repository: Repository<Task>,
    ) {}

    async findById(id: string): Promise<Task | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdAndUser(id: string, userId: string): Promise<Task | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findBySlug(slug: string): Promise<Task | null> {
        return this.repository.findOne({ where: { slug } });
    }

    async findByUserIdFiltered(
        userId: string,
        filter: ListTasksFilter = {},
    ): Promise<{ rows: Task[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('task')
            .where('task.userId = :userId', { userId });

        if (filter.status) {
            if (Array.isArray(filter.status)) {
                qb.andWhere('task.status IN (:...statuses)', { statuses: filter.status });
            } else {
                qb.andWhere('task.status = :status', { status: filter.status });
            }
        }
        if (filter.priority) {
            if (Array.isArray(filter.priority)) {
                qb.andWhere('task.priority IN (:...priorities)', { priorities: filter.priority });
            } else {
                qb.andWhere('task.priority = :priority', { priority: filter.priority });
            }
        }
        if (filter.missionId)
            qb.andWhere('task.missionId = :missionId', { missionId: filter.missionId });
        if (filter.ideaId) qb.andWhere('task.ideaId = :ideaId', { ideaId: filter.ideaId });
        if (filter.workId) qb.andWhere('task.workId = :workId', { workId: filter.workId });
        // Owner filters combine with AND: passing both workId and teamId
        // means "tasks that belong to this Work AND this Team", which is
        // what the scoped list views on each owner's tab need.
        if (filter.teamId) qb.andWhere('task.teamId = :teamId', { teamId: filter.teamId });
        if (filter.agentId) qb.andWhere('task.agentId = :agentId', { agentId: filter.agentId });
        if (filter.goalId) qb.andWhere('task.goalId = :goalId', { goalId: filter.goalId });
        if (filter.parentTaskId)
            qb.andWhere('task.parentTaskId = :parentTaskId', { parentTaskId: filter.parentTaskId });

        if (filter.search) {
            // Security: escape LIKE wildcards (%/_/\) in the user-supplied
            // search term and pair each predicate with an explicit ESCAPE
            // clause. The value is already bound, so this is not SQLi, but
            // unescaped wildcards otherwise let a caller bypass the filter
            // (e.g. `%`) or force an index-defeating leading-wildcard scan.
            // Mirrors agent.repository.ts. Escape-only (no LOWER()) preserves
            // the existing case-sensitive matching for legitimate input.
            qb.andWhere(
                "(task.title LIKE :q ESCAPE '\\' OR task.slug LIKE :q ESCAPE '\\' OR task.description LIKE :q ESCAPE '\\')",
                {
                    q: `%${sanitizeLikePattern(filter.search)}%`,
                },
            );
        }

        // `labels` is a simple-json array; we hit it as a substring match
        // against the serialized JSON. v1 — proper jsonb indexing lands
        // when the catalog grows.
        if (filter.label) {
            // Security: escape LIKE wildcards (%/_/\) in the user-supplied
            // label before wrapping it in the `"<label>"` JSON-token match,
            // and add an explicit ESCAPE clause. Bound param (not SQLi), but
            // unescaped wildcards would let `%` match every labelled task and
            // break out of the intended quoted-token boundary. Escape-only
            // preserves the exact match for legitimate, wildcard-free labels.
            qb.andWhere("task.labels LIKE :label ESCAPE '\\'", {
                label: `%"${sanitizeLikePattern(filter.label)}"%`,
            });
        }

        const total = await qb.getCount();
        qb.orderBy('task.updatedAt', 'DESC')
            .take(filter.limit ?? 50)
            .skip(filter.offset ?? 0);
        const rows = await qb.getMany();
        return { rows, total };
    }

    async create(data: Partial<Task>): Promise<Task> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async updateById(id: string, data: Partial<Task>): Promise<void> {
        await this.repository.update(id, data);
    }

    /**
     * Compare-and-swap status update: applies `data` (which advances the
     * status) ONLY while the row is still at `expectedStatus`, in a single
     * atomic `UPDATE … WHERE id=? AND status=?`. Returns true iff exactly one
     * row changed — i.e. THIS caller won the race. Concurrent transitions from
     * the same source state therefore resolve to exactly one winner
     * (affected=1); the losers get affected=0 and a read-time conflict, instead
     * of every racer clobbering the row (the state machine is the CAS lock).
     */
    async casUpdateStatus(
        id: string,
        expectedStatus: Task['status'],
        data: Partial<Task>,
    ): Promise<boolean> {
        const result = await this.repository.update({ id, status: expectedStatus }, data);
        return (result.affected ?? 0) === 1;
    }

    async deleteById(id: string): Promise<void> {
        await this.repository.delete(id);
    }

    /**
     * Walk the parent chain from `candidateChildId` upward. Returns
     * true iff `proposedParentId` appears in the chain — i.e. setting
     * `candidateChild.parentTaskId = proposedParentId` would form a
     * cycle. Service-layer guard for sub-task assignment.
     *
     * Iterative (not recursive CTE) — small N expected; readable on
     * SQLite + Postgres alike without dialect branching.
     */
    async wouldCreateCycle(
        candidateChildId: string,
        proposedParentId: string,
        maxDepth = 200,
    ): Promise<boolean> {
        if (candidateChildId === proposedParentId) return true;
        let cursor: string | null = proposedParentId;
        const seen = new Set<string>();
        for (let i = 0; i < maxDepth && cursor; i++) {
            if (seen.has(cursor)) return true; // existing data is already cyclic — bail
            seen.add(cursor);
            if (cursor === candidateChildId) return true;
            const next = await this.repository.findOne({
                where: { id: cursor },
                select: ['id', 'parentTaskId'],
            });
            cursor = next?.parentTaskId ?? null;
        }
        return false;
    }

    /**
     * Find recurring Task templates due to spawn an instance. Used by
     * `TaskRecurrenceDispatcherService.dispatchDue` in Phase 17.
     *
     * @internal CRON-ONLY — fetches across ALL tenants/users by design.
     * Do NOT call from user-facing request handlers; doing so would expose
     * tasks across tenant boundaries. If a user-scoped variant is ever
     * needed, create a separate `findDueRecurringTemplatesForUser(userId)`
     * method rather than adding optional params here.
     */
    async findDueRecurringTemplates(limit: number, now: Date = new Date()): Promise<Task[]> {
        return this.repository
            .createQueryBuilder('task')
            .where('task.isRecurring = :rec', { rec: true })
            .andWhere('task.nextOccurrenceAt IS NOT NULL')
            .andWhere('task.nextOccurrenceAt <= :now', { now })
            .orderBy('task.nextOccurrenceAt', 'ASC')
            .take(limit)
            .getMany();
    }

    /**
     * CAS-claim a recurring template for one spawn round. Atomic
     * transition: advance `nextOccurrenceAt` AND bump
     * `recurrenceOccurredCount` only if `nextOccurrenceAt` still
     * matches `expected`. Returns true iff this caller won the claim.
     * Mirrors `WorkScheduleRepository.tryMarkDispatched`.
     */
    async casClaimRecurrence(
        taskId: string,
        expected: Date,
        newNextOccurrence: Date | null,
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(Task)
            .set({
                nextOccurrenceAt: newNextOccurrence,
                recurrenceOccurredCount: () => 'recurrenceOccurredCount + 1',
                updatedAt: new Date(),
            })
            .where('id = :id', { id: taskId })
            .andWhere('isRecurring = :rec', { rec: true })
            .andWhere('nextOccurrenceAt = :expected', { expected })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Find recurring templates whose `nextOccurrenceAt` is stuck (not
     * advanced) past `olderThan`. Used by the cron-based recovery path in
     * `TaskRecurrenceDispatcherService`.
     *
     * @internal CRON-ONLY — fetches across ALL tenants/users by design.
     * Do NOT call from user-facing request handlers; doing so would expose
     * tasks across tenant boundaries.
     */
    async findStuckRecurring(olderThan: Date): Promise<Task[]> {
        return this.repository.find({
            where: {
                isRecurring: true,
                nextOccurrenceAt: LessThanOrEqual(olderThan),
            },
        });
    }
}
