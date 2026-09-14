import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, LessThanOrEqual, Repository, type SelectQueryBuilder } from 'typeorm';
import { Task, TaskStatus } from '../../entities/task.entity';
import {
    buildCaseInsensitiveLikeClause,
    prepareCaseInsensitiveContainsPattern,
    sanitizeLikePattern,
} from '../utils';
import { ownershipSqlPredicate, ownershipWhereWith, type OwnershipScope } from '../ownership-scope';

export interface ListTasksFilter {
    status?: TaskStatus | TaskStatus[];
    priority?: string | string[];
    missionId?: string;
    ideaId?: string;
    workId?: string;
    teamId?: string;
    agentId?: string;
    goalId?: string;
    /**
     * A parent Task id returns that parent's sub-tasks. The literal `'none'`
     * (never a valid uuid, so it cannot collide with one) returns only
     * top-level Tasks — the Task board's default read. Omitted = no
     * predicate, today's behaviour.
     */
    parentTaskId?: string | 'none';
    label?: string;
    search?: string;
    /**
     * Include Tasks flagged `hiddenFromBoard` (trigger-spawned work the
     * owning trigger chose to keep off the board). Omitted/false =
     * hidden rows are excluded, which is what the board and every
     * default list want.
     */
    includeHidden?: boolean;
    /**
     * `true` = recurring templates only; `false` = everything except
     * templates. Omitted = no predicate, today's behaviour.
     */
    isRecurring?: boolean;
    /**
     * Task board — bound the terminal statuses (`done`, `cancelled`) to rows
     * updated at or after this instant, leaving every other status
     * unbounded. The same predicate reaches the count and the page, so a
     * windowed column's total and its cards always agree. Omitted = no
     * predicate.
     */
    terminalUpdatedSince?: Date;
    /**
     * Row order. Omitted and `'updatedAt'` both emit today's
     * `updatedAt DESC`, so every existing caller is unchanged. Every order
     * then breaks remaining ties on `id ASC`, so offset pages never overlap.
     *   - `'priorityThenUpdated'` — `p0` first, then oldest update first.
     *   - `'stalledThenPriority'` — stalled `in_progress` Tasks first (see
     *     `stallCutoff`), then priority, then oldest update first. The
     *     Task board's order.
     */
    orderBy?: 'updatedAt' | 'priorityThenUpdated' | 'stalledThenPriority';
    /**
     * Only read with `orderBy: 'stalledThenPriority'`: an `in_progress` Task
     * with nothing running whose `updatedAt` is before this instant sorts
     * first. Omitted = nothing sorts as stalled.
     */
    stallCutoff?: Date;
    limit?: number;
    offset?: number;
}

/** Task statuses the board bounds to a recent window. */
const TERMINAL_TASK_STATUSES: TaskStatus[] = [TaskStatus.DONE, TaskStatus.CANCELLED];

/** Run statuses after which nothing is running for a Task (stall ordering). */
const FINISHED_RUN_STATUSES = ['completed', 'failed', 'cancelled'];

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

    async findByIdAndUser(
        id: string,
        userId: string,
        scope?: OwnershipScope,
    ): Promise<Task | null> {
        return this.repository.findOne({
            where: ownershipWhereWith<Task>(userId, scope, { id }),
        });
    }

    async findBySlug(slug: string): Promise<Task | null> {
        return this.repository.findOne({ where: { slug } });
    }

    /**
     * Orchestration M9 — the Task an agent opened a given pull request
     * for. `prNumber` is only unique WITHIN a repository, and a Work maps
     * to one repository, so the (workId, prNumber) pair is the correct
     * key — `prNumber` alone would collide across Works the moment two
     * repos both have a PR #7.
     *
     * Newest first: a Task whose branch was recycled could in principle
     * carry a stale number, and the most recently updated row is the one
     * the reviewer was looking at.
     */
    async findByWorkAndPrNumber(workId: string, prNumber: number): Promise<Task | null> {
        return this.repository.findOne({
            where: { workId, prNumber },
            order: { updatedAt: 'DESC' },
        });
    }

    /**
     * Org-scoped digest briefings — the most recently touched Tasks of
     * one Organization, regardless of which member owns them.
     *
     * Deliberately NOT an extra filter on `findByUserIdFiltered`: that
     * method is owner-scoped by construction (`task.userId = :userId`
     * is its first predicate and every caller relies on it), and adding
     * an org filter there would let a caller that forgets the owner
     * argument read across users. A separate, explicitly org-keyed read
     * keeps the two scopes impossible to confuse.
     *
     * `organizationId` is never NULL-matched: rows with no org stamped
     * belong to the personal surface and must not leak into an org
     * briefing.
     */
    async findRecentByOrganization(organizationId: string, limit = 200): Promise<Task[]> {
        const take = Math.min(Math.max(limit, 1), 500);
        return this.repository
            .createQueryBuilder('task')
            .where('task.organizationId = :organizationId', { organizationId })
            .orderBy('task.updatedAt', 'DESC')
            .take(take)
            .getMany();
    }

    /**
     * Git activity ingestion (audit item j) — the Task whose isolated
     * worktree branch a push landed on.
     *
     * Same key shape as {@link findByWorkAndPrNumber} and for the same
     * reason: `branchRef` holds the SHORT branch name
     * (`taskBranchName()`), which is only unique within a repository, and
     * a Work maps to one repository. Newest-updated first, because a
     * recycled branch name can appear on more than one row and the live
     * Task is the one that moved last.
     */
    async findByWorkAndBranchRef(workId: string, branchRef: string): Promise<Task | null> {
        if (!branchRef) return null;
        return this.repository.findOne({
            where: { workId, branchRef },
            order: { updatedAt: 'DESC' },
        });
    }

    async findByUserIdFiltered(
        userId: string,
        filter: ListTasksFilter = {},
        scope?: OwnershipScope,
    ): Promise<{ rows: Task[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('task')
            .where('task.userId = :userId', { userId });

        const scopePredicate = ownershipSqlPredicate('task', scope, 'taskScope');
        if (scopePredicate) {
            qb.andWhere(scopePredicate.clause, scopePredicate.parameters);
        }

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
        if (filter.parentTaskId === 'none') {
            qb.andWhere('task.parentTaskId IS NULL');
        } else if (filter.parentTaskId) {
            qb.andWhere('task.parentTaskId = :parentTaskId', { parentTaskId: filter.parentTaskId });
        }
        if (filter.isRecurring !== undefined) {
            qb.andWhere('task.isRecurring = :isRecurring', { isRecurring: filter.isRecurring });
        }
        if (filter.terminalUpdatedSince) {
            qb.andWhere(
                new Brackets((windowQb) => {
                    windowQb
                        .where('task.status NOT IN (:...terminalStatuses)', {
                            terminalStatuses: TERMINAL_TASK_STATUSES,
                        })
                        .orWhere('task.updatedAt >= :terminalUpdatedSince', {
                            terminalUpdatedSince: filter.terminalUpdatedSince,
                        });
                }),
            );
        }

        // Board visibility: trigger-spawned Tasks whose trigger opted out
        // of the board are excluded unless the caller explicitly asks for
        // them. `= false` (not `!= true`) is correct because the column is
        // NOT NULL DEFAULT false on every row.
        if (!filter.includeHidden) {
            qb.andWhere('task.hiddenFromBoard = :hiddenFromBoard', { hiddenFromBoard: false });
        }

        if (filter.search) {
            // Escape LIKE wildcards (%/_/\) in the user-supplied search term
            // and pair each predicate with an explicit ESCAPE clause. The
            // value is already bound, so this is not SQLi, but unescaped
            // wildcards otherwise let a caller bypass the filter (e.g. `%`)
            // or force an index-defeating leading-wildcard scan.
            //
            // Both the column (LOWER(), via `buildCaseInsensitiveLikeClause`)
            // and the pattern (via `prepareCaseInsensitiveContainsPattern`)
            // are folded — a bare LIKE is case-SENSITIVE on PostgreSQL and
            // case-INSENSITIVE on SQLite, so the previous clause silently
            // returned fewer rows in stage and production than it did in CI.
            // Mirrors agent.repository.ts / work.repository.ts.
            const searchPattern = prepareCaseInsensitiveContainsPattern(filter.search);
            if (searchPattern) {
                qb.andWhere(
                    new Brackets((searchQb) => {
                        searchQb
                            .where(buildCaseInsensitiveLikeClause('task.title', 'q'), {
                                q: searchPattern,
                            })
                            .orWhere(buildCaseInsensitiveLikeClause('task.slug', 'q'), {
                                q: searchPattern,
                            })
                            .orWhere(buildCaseInsensitiveLikeClause('task.description', 'q'), {
                                q: searchPattern,
                            });
                    }),
                );
            }
        }

        // `labels` is a simple-json array; we hit it as a substring match
        // against the serialized JSON. v1 — proper jsonb indexing lands
        // when the catalog grows.
        if (filter.label) {
            // Security: escape LIKE wildcards (%/_/\) in the user-supplied
            // label before wrapping it in the `"<label>"` JSON-token match,
            // and add an explicit ESCAPE clause. Bound param (not SQLi), but
            // unescaped wildcards would let `%` match every labelled task and
            // break out of the intended quoted-token boundary.
            //
            // BOTH sides are lower-cased so the filter behaves identically on
            // PostgreSQL and SQLite: `?label=bug` previously did not match the
            // stored label `Bug` in stage or production, while matching fine
            // in CI. The surrounding `"` quotes are preserved, so folding case
            // does not widen the match from a whole JSON token to a substring.
            qb.andWhere(buildCaseInsensitiveLikeClause('task.labels', 'label'), {
                label: `%"${sanitizeLikePattern(filter.label).toLowerCase()}"%`,
            });
        }

        const total = await qb.getCount();
        this.applyListOrder(qb, filter);
        qb.take(filter.limit ?? 50).skip(filter.offset ?? 0);
        const rows = await qb.getMany();
        return { rows, total };
    }

    /**
     * Row order for {@link findByUserIdFiltered}. Applied AFTER the count, so
     * no ordering option can change a total.
     *
     * `task.priority ASC` is deliberate and correct: the column is a
     * `varchar(4)` holding `p0`..`p4`, so lexicographic order IS priority
     * order (`'p0' < 'p1' < … < 'p4'`). No CASE mapping or numeric column is
     * needed. It looks accidental; it is not.
     *
     * Every order ends on `task.id ASC`. `updatedAt` is not unique, and rows
     * tied on every other key have no defined relative order: two OFFSET
     * reads may then be served by different plans and repeat one row while
     * never returning another. The unique final key makes each page a fixed
     * slice of one total order. It only breaks ties, so it never moves a row
     * that the earlier keys already placed.
     */
    private applyListOrder(qb: SelectQueryBuilder<Task>, filter: ListTasksFilter): void {
        this.applyListOrderKeys(qb, filter);
        qb.addOrderBy('task.id', 'ASC');
    }

    private applyListOrderKeys(qb: SelectQueryBuilder<Task>, filter: ListTasksFilter): void {
        switch (filter.orderBy) {
            case 'priorityThenUpdated':
                qb.orderBy('task.priority', 'ASC').addOrderBy('task.updatedAt', 'ASC');
                return;
            case 'stalledThenPriority': {
                if (filter.stallCutoff) {
                    // Stalled = in progress, nothing running, untouched since
                    // the cutoff. Same rule as `isTaskStalled` in contracts,
                    // so the order and the card flag cannot disagree.
                    qb.orderBy(
                        `CASE WHEN task.status = :stallStatus AND (task.latestRunStatus IS NULL OR task.latestRunStatus IN (:...stallFinishedRuns)) AND task.updatedAt < :stallCutoff THEN 0 ELSE 1 END`,
                        'ASC',
                    )
                        .setParameter('stallStatus', TaskStatus.IN_PROGRESS)
                        .setParameter('stallFinishedRuns', FINISHED_RUN_STATUSES)
                        .setParameter('stallCutoff', filter.stallCutoff)
                        .addOrderBy('task.priority', 'ASC');
                } else {
                    qb.orderBy('task.priority', 'ASC');
                }
                qb.addOrderBy('task.updatedAt', 'ASC');
                return;
            }
            case 'updatedAt':
            case undefined:
            default:
                qb.orderBy('task.updatedAt', 'DESC');
        }
    }

    async create(data: Partial<Task>): Promise<Task> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async updateById(id: string, data: Partial<Task>): Promise<void> {
        await this.repository.update(id, data);
    }

    /**
     * Branch-GC candidates (worktree-per-Task M6): Tasks that still hold
     * a live branch (`branchState` pushed/pr-open/conflict/created) and
     * are either TERMINAL (done/cancelled — eligible immediately, the
     * per-Work cleanup policy is applied by the sweeper) or abandoned
     * (not updated in `staleDays`). Uses idx_tasks_branch_state.
     */
    async findBranchCleanupCandidates(staleDays: number): Promise<Task[]> {
        const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
        return this.repository
            .createQueryBuilder('task')
            .where('task.branchRef IS NOT NULL')
            .andWhere('task.branchState IN (:...live)', {
                live: ['created', 'pushed', 'pr-open', 'conflict'],
            })
            .andWhere('(task.status IN (:...terminal) OR task.updatedAt < :cutoff)', {
                terminal: ['done', 'cancelled'],
                cutoff,
            })
            .take(200)
            .getMany();
    }

    /**
     * PR insights (kanban run cockpit M5) — Tasks whose pull request is
     * still OPEN and whose cached CI verdict has gone stale.
     *
     * Two deliberate narrowings, both about not burning a provider's rate
     * limit on questions that cannot change the board:
     *
     *  - `prNumber IS NOT NULL` — nothing to ask about otherwise.
     *  - `prState` is null / `open` / `draft` — a merged or closed PR is
     *    TERMINAL. Once observed, we never poll it again; the plan's
     *    "only while the PR is open" rule is enforced here rather than
     *    left to the caller.
     *
     * Never-checked rows (`ciCheckedAt IS NULL`) sort first, then the
     * stalest — so a newly opened PR gets its dot quickly and a long
     * backlog drains in age order. Hits `idx_tasks_pr_status_sync`.
     */
    async findDuePrStatusSync(staleBefore: Date, limit = 50): Promise<Task[]> {
        return this.repository
            .createQueryBuilder('task')
            .where('task.prNumber IS NOT NULL')
            .andWhere('task.workId IS NOT NULL')
            .andWhere("(task.prState IS NULL OR task.prState IN ('open', 'draft'))")
            .andWhere('(task.ciCheckedAt IS NULL OR task.ciCheckedAt < :staleBefore)', {
                staleBefore,
            })
            .orderBy('task.ciCheckedAt', 'ASC', 'NULLS FIRST')
            .take(Math.max(1, Math.min(limit, 200)))
            .getMany();
    }

    /**
     * PR-status cache write. Query-builder update on purpose: like
     * `updateLatestRun` it must NOT bump `updatedAt`, or every sync tick
     * would reshuffle the updatedAt-ordered board.
     */
    async updatePrStatusCache(
        taskId: string,
        patch: Partial<
            Pick<Task, 'prState' | 'ciState' | 'ciCheckedAt' | 'prChecks' | 'prHeadSha'>
        >,
    ): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(Task)
            .set(patch)
            .where('id = :taskId', { taskId })
            .execute();
    }

    /**
     * Merge approval (self-build slice AE) — record that a HUMAN approved
     * this Task's pull request on the git provider, for one specific
     * commit.
     *
     * Same query-builder posture as `updatePrStatusCache` and for the same
     * reason: this is provider telemetry arriving on a webhook, and it
     * must not bump `updatedAt` and reshuffle the board.
     *
     * `prNumber` is part of the predicate, not just the id: a webhook is
     * resolved to a Task by `(workId, prNumber)`, which is a newest-first
     * lookup rather than a unique one, so the write re-asserts that the
     * row it landed on still carries the pull request the review was for.
     */
    async recordPullRequestReviewApproval(
        taskId: string,
        prNumber: number,
        patch: { headSha: string; approvedAt: Date; approvedBy: string | null },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(Task)
            .set({
                prReviewApprovedSha: patch.headSha,
                prReviewApprovedAt: patch.approvedAt,
                prReviewApprovedBy: patch.approvedBy,
            })
            .where('id = :taskId', { taskId })
            .andWhere('prNumber = :prNumber', { prNumber })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Merge approval (self-build slice AE) — RETRACT a provider-side human
     * review approval, because its author withdrew or reversed it.
     *
     * Guarded on the recorded approver: a dismissal by Alice clears
     * Alice's attestation, and a `changes_requested` from Bob does not
     * unmake the fact that Alice read the diff. Same query-builder posture
     * as the writer — webhook telemetry must not bump `updatedAt`.
     *
     * Returns true when a Task row was cleared.
     */
    async clearPullRequestReviewApproval(
        taskId: string,
        prNumber: number,
        approvedBy: string,
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(Task)
            .set({
                prReviewApprovedSha: null,
                prReviewApprovedAt: null,
                prReviewApprovedBy: null,
            })
            .where('id = :taskId', { taskId })
            .andWhere('prNumber = :prNumber', { prNumber })
            .andWhere('LOWER(prReviewApprovedBy) = :approvedBy', {
                approvedBy: approvedBy.toLowerCase(),
            })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Merge approval (self-build slice AE) — remember the last merge
     * REFUSAL so it is told to the human once instead of every two
     * minutes.
     *
     * The merge attempt now lives on the PR-status sweep, so a stable
     * refusal (a protected base branch, a required review) repeats for as
     * long as the pull request stays open. `TaskWorkspaceService`
     * compares (head commit, refusal code) against what is stored here
     * before it posts a chat message and writes an activity row.
     *
     * Query-builder update for the same reason as `updatePrStatusCache`:
     * this is bookkeeping about a background sweep and must not bump
     * `updatedAt` and reshuffle the updatedAt-ordered board.
     */
    async recordMergeRefusal(
        taskId: string,
        patch: { sha: string | null; code: string | null },
    ): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(Task)
            .set({ mergeRefusedSha: patch.sha, mergeRefusedCode: patch.code })
            .where('id = :taskId', { taskId })
            .execute();
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

    /**
     * Kanban run cockpit (Wave 2) — latest-run denorm write, used only by
     * `TaskRunDenormService`.
     *
     * When `expectRunId` is given the write lands ONLY while the row still
     * points at that run (or at no run yet), so a stale claim/terminal
     * write from an OLDER run can never clobber the pointer a NEWER queued
     * run already installed. Queued creation passes no `expectRunId` — the
     * newest dispatch always wins the pointer.
     *
     * Query-builder update on purpose: unlike `repository.update` it does
     * NOT touch `updatedAt`, so silent telemetry denorms never reshuffle
     * the updatedAt-ordered task lists.
     */
    async updateLatestRun(
        taskId: string,
        patch: { latestRunId: string; latestRunStatus: string },
        expectRunId?: string,
    ): Promise<boolean> {
        const qb = this.repository
            .createQueryBuilder()
            .update(Task)
            .set(patch)
            .where('id = :taskId', { taskId });
        if (expectRunId) {
            qb.andWhere('(latestRunId = :expectRunId OR latestRunId IS NULL)', { expectRunId });
        }
        const result = await qb.execute();
        return (result.affected ?? 0) > 0;
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
        userId?: string,
        scope?: OwnershipScope,
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
                where: userId
                    ? ownershipWhereWith<Task>(userId, scope, { id: cursor })
                    : { id: cursor },
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
        return (
            this.repository
                .createQueryBuilder('task')
                .where('task.isRecurring = :rec', { rec: true })
                // Schedules — a paused template keeps its cadence and its
                // `nextOccurrenceAt`; it is simply not due while paused. Every
                // job runtime reaches this scan through
                // `TaskRecurrenceDispatcherService.dispatchDue`, so the pause is
                // honoured wherever the cron is hosted.
                .andWhere('task.recurrencePausedAt IS NULL')
                .andWhere('task.nextOccurrenceAt IS NOT NULL')
                .andWhere('task.nextOccurrenceAt <= :now', { now })
                .orderBy('task.nextOccurrenceAt', 'ASC')
                .take(limit)
                .getMany()
        );
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
            // Schedules — closes the window between the due-scan read and
            // this claim: a template paused in between is not spawned.
            .andWhere('recurrencePausedAt IS NULL')
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Schedules — the most recently spawned instance of a recurring
     * template, or null when it has never fired. Run-now reads it to refuse
     * a second out-of-band fire while the previous one is still in flight.
     *
     * @internal Unscoped — callers must have resolved the template through
     * an owner-scoped read first (`TasksService.getOne`).
     */
    async findLatestRecurrenceInstance(templateId: string): Promise<Task | null> {
        return this.repository
            .createQueryBuilder('task')
            .where('task.parentRecurringTaskId = :templateId', { templateId })
            .orderBy('task.createdAt', 'DESC')
            .getOne();
    }

    /**
     * Schedule modes — one-shot Tasks due to dispatch: `scheduledAt` has
     * passed and no dispatcher has claimed them yet.
     *
     * @internal CRON-ONLY — fetches across ALL tenants/users by design.
     * Do NOT call from user-facing request handlers; doing so would expose
     * tasks across tenant boundaries.
     */
    async findDueScheduledTasks(limit: number, now: Date = new Date()): Promise<Task[]> {
        return this.repository
            .createQueryBuilder('task')
            .where('task.scheduledAt IS NOT NULL')
            .andWhere('task.scheduledAt <= :now', { now })
            .andWhere('task.scheduleClaimedAt IS NULL')
            .orderBy('task.scheduledAt', 'ASC')
            .take(limit)
            .getMany();
    }

    /**
     * Task-graph fan-out (self-build slice AH) — candidate rows for one
     * bounded driver tick: Tasks sitting in `todo` that a fan-out may
     * start once their blockers clear.
     *
     * The filters are deliberately conservative, each one excluding work
     * that ANOTHER driver already owns or that a human deliberately kept
     * off the board:
     *  - `isRecurring = false` — a recurring row is a TEMPLATE; the
     *    recurrence scan spawns its instances and those instances are
     *    ordinary Tasks that appear here.
     *  - `scheduledAt IS NULL` — a one-shot belongs to the schedule scan,
     *    which fires it at its instant. Starting it early would defeat the
     *    schedule.
     *  - `hiddenFromBoard = false` — automation-produced rows a trigger
     *    hid stay hidden; the fan-out is the board's driver, not a way
     *    around that flag.
     *  - `goalId IS NULL` — a Goal's iteration Tasks belong to the GOAL
     *    LOOP, which creates them `todo`, dispatches them itself
     *    (`GoalOrchestratorService.applyDispatch` calls `dispatchAgentRun`
     *    directly and never transitions the row) and bounds them with
     *    `maxConcurrentIterations`. Without this filter the fan-out would
     *    re-start every finished iteration Task and drive a serial Goal
     *    past its own ceiling.
     *  - `parentRecurringTaskId IS NULL` — likewise, a recurrence INSTANCE
     *    is spawned `todo` and dispatched by `dispatchDue`, which also
     *    never transitions it. Its occurrence is the recurrence scan's to
     *    decide, not this driver's.
     *  - `startedAt IS NULL` AND `latestRunId IS NULL` — the row has never
     *    been run. Three shipped paths dispatch a run and deliberately
     *    LEAVE the Task in `todo` (board "Run" / `TasksService.runTask`,
     *    the recurrence scan, the Goal loop), so "still todo" does not
     *    mean "never started"; without these the fan-out would silently
     *    re-run work as soon as the first run went terminal. `startedAt`
     *    additionally excludes a Task a human pulled back to `todo` after
     *    it ran — a re-run is a human decision, not an automatic one.
     *
     * Ordering is DETERMINISTIC — `priority ASC` (the column is a
     * varchar(4) `P0`..`P3`, so ASC is highest-priority-first),
     * `createdAt ASC`, then `id ASC` as the final tiebreak — so two
     * identical ticks consider the same Tasks in the same order and a
     * per-owner bound always spends its budget on the same work.
     *
     * @internal CRON-ONLY — fetches across ALL tenants/users by design.
     * Do NOT call from user-facing request handlers; doing so would expose
     * tasks across tenant boundaries.
     */
    async findFanoutCandidates(limit: number): Promise<Task[]> {
        return this.repository
            .createQueryBuilder('task')
            .where('task.status = :status', { status: TaskStatus.TODO })
            .andWhere('task.isRecurring = :recurring', { recurring: false })
            .andWhere('task.scheduledAt IS NULL')
            .andWhere('task.hiddenFromBoard = :hidden', { hidden: false })
            .andWhere('task.goalId IS NULL')
            .andWhere('task.parentRecurringTaskId IS NULL')
            .andWhere('task.startedAt IS NULL')
            .andWhere('task.latestRunId IS NULL')
            .orderBy('task.priority', 'ASC')
            .addOrderBy('task.createdAt', 'ASC')
            .addOrderBy('task.id', 'ASC')
            .take(limit)
            .getMany();
    }

    /**
     * CAS-claim a due one-shot for dispatch. Atomic: stamps
     * `scheduleClaimedAt` only while the row still carries the expected
     * `scheduledAt` AND is unclaimed, so two concurrent dispatcher ticks
     * (or a reschedule racing a tick) resolve to exactly one winner.
     * Mirrors {@link casClaimRecurrence}.
     */
    async casClaimSchedule(
        taskId: string,
        expected: Date,
        now: Date = new Date(),
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(Task)
            .set({ scheduleClaimedAt: now })
            .where('id = :id', { id: taskId })
            .andWhere('scheduledAt = :expected', { expected })
            .andWhere('scheduleClaimedAt IS NULL')
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

    /**
     * CI feedback loop (slice AC, EW-806) — record the head commit the
     * provider is reporting checks against, and the red verdict that came
     * with it.
     *
     * MONOTONIC by construction: the head pair is only written when the
     * row still carries the head this caller read (or none at all), so two
     * deliveries racing on one push cannot leave the newer commit
     * overwritten by the older one. Returns whether this caller's head
     * write landed.
     *
     * Query-builder update for the same reason `updatePrStatusCache` uses
     * one: it must NOT bump `updatedAt`, or a busy CI would reshuffle the
     * updatedAt-ordered board on every job.
     *
     * `ciState` is only ever written RED here. A single green check is not
     * a green gate — only the poll, which sees every check at once, may
     * write `passing` (see `deriveCiState`: red beats everything, never
     * green early).
     */
    async recordCiHead(input: {
        taskId: string;
        expectedHeadSha: string | null;
        headSha: string;
        seenAt: Date;
        failing?: boolean;
    }): Promise<boolean> {
        const patch: Partial<Task> = { ciHeadSha: input.headSha, ciHeadSeenAt: input.seenAt };
        if (input.failing) {
            patch.ciState = 'failing';
            patch.ciCheckedAt = input.seenAt;
        }
        const qb = this.repository
            .createQueryBuilder()
            .update(Task)
            .set(patch)
            .where('id = :taskId', { taskId: input.taskId });
        if (input.expectedHeadSha === null) {
            qb.andWhere('ciHeadSha IS NULL');
        } else {
            qb.andWhere('ciHeadSha = :expected', { expected: input.expectedHeadSha });
        }
        const result = await qb.execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * CI feedback loop (slice AC) — claim the right to file the ONE
     * "automatic retries stopped" Inbox notice for this Task.
     *
     * Compare-and-set from NULL in a single statement, so exactly one of N
     * concurrent deliveries that all discover a spent budget files the
     * notice and the rest are told they lost. Same shape as
     * `FleetNodeRepository.casTripDailyCeiling`.
     */
    async casMarkCiAutoResumeNoticed(taskId: string, at: Date): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(Task)
            .set({ ciAutoResumeNoticedAt: at })
            .where('id = :taskId', { taskId })
            .andWhere('ciAutoResumeNoticedAt IS NULL')
            .execute();
        return (result.affected ?? 0) > 0;
    }
}
