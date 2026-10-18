import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    Brackets,
    type EntityManager,
    LessThanOrEqual,
    Repository,
    type SelectQueryBuilder,
} from 'typeorm';
import { ExternalRecordLink } from '../../entities/external-record-link.entity';
import { Task, TaskStatus } from '../../entities/task.entity';
import {
    buildCaseInsensitiveLikeClause,
    prepareCaseInsensitiveContainsPattern,
    sanitizeLikePattern,
} from '../utils';
import { ownershipSqlPredicate, ownershipWhereWith, type OwnershipScope } from '../ownership-scope';
import type { RecordListView } from '@ever-works/contracts';
import type { RecordAccessContext } from '../../record-visibility/record-access.types';
import { visibleToPredicate } from '../../record-visibility/visible-to';

export interface ListTasksFilter {
    /**
     * Record visibility (EW-P1-3) list tab: `mine` (default, today's owner list),
     * `shared` or `organization`. Only `TasksService.list` reads it: the repository's
     * owner list ignores it, and {@link TaskRepository.findVisibleFiltered} takes the
     * view as an argument.
     */
    view?: RecordListView;
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

        return this.readFilteredPage(qb, filter);
    }

    /**
     * Record visibility (EW-P1-3) — the list through `visibleTo(principal)` instead of
     * `userId = caller`: own rows, rows the caller takes part in, rows on their Teams /
     * Works (`team` + `organization`) and, for an Organization member, every
     * `organization` row. Same filters, order and paging as
     * {@link findByUserIdFiltered}; `view = 'mine'` is identical to it.
     */
    async findVisibleFiltered(
        context: RecordAccessContext,
        view: RecordListView,
        filter: ListTasksFilter = {},
        scope?: OwnershipScope,
    ): Promise<{ rows: Task[]; total: number }> {
        const qb = this.repository.createQueryBuilder('task');
        const predicate = visibleToPredicate({
            alias: 'task',
            aggregate: 'task',
            context,
            view,
            escape: (identifier) => qb.connection.driver.escape(identifier),
        });
        qb.where(predicate.clause, predicate.parameters);

        const scopePredicate = ownershipSqlPredicate('task', scope, 'taskScope');
        if (scopePredicate) {
            qb.andWhere(scopePredicate.clause, scopePredicate.parameters);
        }

        return this.readFilteredPage(qb, filter);
    }

    /**
     * Record visibility (EW-P1-3) — one Task by id when `visibleTo(principal)` admits
     * it in the active scope. `null` (→ 404) otherwise, so existence never leaks.
     */
    async findVisibleById(
        id: string,
        context: RecordAccessContext,
        scope?: OwnershipScope,
    ): Promise<Task | null> {
        const qb = this.repository.createQueryBuilder('task').where('task.id = :taskId', {
            taskId: id,
        });
        const predicate = visibleToPredicate({
            alias: 'task',
            aggregate: 'task',
            context,
            view: 'organization',
            escape: (identifier) => qb.connection.driver.escape(identifier),
        });
        qb.andWhere(predicate.clause, predicate.parameters);
        const scopePredicate = ownershipSqlPredicate('task', scope, 'taskScope');
        if (scopePredicate) {
            qb.andWhere(scopePredicate.clause, scopePredicate.parameters);
        }
        return qb.getOne();
    }

    /** The shared filter / count / order / page tail of the two list reads. */
    private async readFilteredPage(
        qb: SelectQueryBuilder<Task>,
        filter: ListTasksFilter,
    ): Promise<{ rows: Task[]; total: number }> {
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

    // `manager` (domain events, EW-P1-1): pass the transaction's EntityManager to
    // write inside it, so the change and its outbox row commit together.
    async create(data: Partial<Task>, manager?: EntityManager): Promise<Task> {
        const repository = manager ? manager.getRepository(Task) : this.repository;
        const entity = repository.create(data);
        return repository.save(entity);
    }

    async updateById(id: string, data: Partial<Task>, manager?: EntityManager): Promise<void> {
        const repository = manager ? manager.getRepository(Task) : this.repository;
        await repository.update(id, data);
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
        manager?: EntityManager,
    ): Promise<boolean> {
        const repository = manager ? manager.getRepository(Task) : this.repository;
        const result = await repository.update({ id, status: expectedStatus }, data);
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
     * Silent telemetry: it must NOT touch `updatedAt`, so denorms never
     * reshuffle the updatedAt-ordered task lists and `task.runtime_updated`
     * bumps neither version nor updatedAt (domain events B2). TypeORM's
     * UpdateQueryBuilder sets an `@UpdateDateColumn` to CURRENT_TIMESTAMP by
     * itself unless the SET names it, so `updatedAt` is set to its own value.
     */
    async updateLatestRun(
        taskId: string,
        patch: { latestRunId: string; latestRunStatus: string },
        expectRunId?: string,
    ): Promise<boolean> {
        const keepUpdatedAt = this.repository.manager.connection.driver.escape('updatedAt');
        const qb = this.repository
            .createQueryBuilder()
            .update(Task)
            .set({ ...patch, updatedAt: () => keepUpdatedAt })
            .where('id = :taskId', { taskId });
        if (expectRunId) {
            qb.andWhere('(latestRunId = :expectRunId OR latestRunId IS NULL)', { expectRunId });
        }
        const result = await qb.execute();
        return (result.affected ?? 0) > 0;
    }

    async deleteById(id: string, manager?: EntityManager): Promise<void> {
        const repository = manager ? manager.getRepository(Task) : this.repository;
        await repository.delete(id);
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
     *  - not an integration's Task (review 2026-10-17 F10, plan decision D9:
     *    "integration writes never start Ever Works autonomous spend"): a Task
     *    an integration key created (`createdByType = 'integration'`), or one
     *    linked to an external record (`external_record_links`, which covers an
     *    integration create made as a person through X-Act-As-User and a Task
     *    an integration mirrors into `todo` with a sync walk). An external
     *    system drives such a Task's status; a person still starts it by hand.
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
        return (
            this.repository
                .createQueryBuilder('task')
                .where('task.status = :status', { status: TaskStatus.TODO })
                .andWhere('task.isRecurring = :recurring', { recurring: false })
                .andWhere('task.scheduledAt IS NULL')
                .andWhere('task.hiddenFromBoard = :hidden', { hidden: false })
                .andWhere('task.goalId IS NULL')
                .andWhere('task.parentRecurringTaskId IS NULL')
                .andWhere('task.createdByType <> :fanoutIntegrationAuthor', {
                    fanoutIntegrationAuthor: 'integration',
                })
                .andWhere(
                    (qb: SelectQueryBuilder<Task>) => {
                        // `entityId` is a varchar, `tasks.id` a uuid on Postgres: compare as text.
                        const type = String(qb.connection.options.type);
                        const taskId = `${qb.escape('task')}.${qb.escape('id')}`;
                        const taskIdText =
                            type === 'postgres'
                                ? `CAST(${taskId} AS text)`
                                : type === 'mysql'
                                  ? `CAST(${taskId} AS CHAR)`
                                  : taskId;
                        const linked = qb
                            .subQuery()
                            .select('1')
                            .from(ExternalRecordLink, 'fanout_link')
                            .where('fanout_link.entityType = :fanoutLinkType')
                            .andWhere(`fanout_link.entityId = ${taskIdText}`)
                            .getQuery();
                        return `NOT EXISTS ${linked}`;
                    },
                    { fanoutLinkType: 'task' },
                )
                .andWhere('task.startedAt IS NULL')
                .andWhere('task.latestRunId IS NULL')
                // Prompt-injection hardening — a Task filed from an untrusted email
                // waits for its owner; the fan-out never starts it. Excluded IN the
                // query, so held Tasks never use up the scan limit and starve the
                // ones behind them (CodeRabbit on #2769). `labels` is `simple-json`,
                // i.e. JSON text on every driver, so the quoted label is matched as
                // text; the filter below re-checks the parsed array.
                .andWhere('(task.labels IS NULL OR task.labels NOT LIKE :awaitingOwnerLabel)', {
                    awaitingOwnerLabel: '%"awaiting-owner"%',
                })
                .orderBy('task.priority', 'ASC')
                .addOrderBy('task.createdAt', 'ASC')
                .addOrderBy('task.id', 'ASC')
                .take(limit)
                .getMany()
                .then((rows) =>
                    rows.filter(
                        (row) =>
                            !(Array.isArray(row.labels) && row.labels.includes('awaiting-owner')),
                    ),
                )
        );
    }

    /**
     * EW-P2-3 — Tasks due inside `[now, until]` whose due-soon notice has not
     * gone out for the current `dueAt`, oldest deadline first. Done, cancelled
     * and recurring templates are skipped (a template's instances carry their
     * own dates).
     *
     * @internal CRON-ONLY — reads across all tenants by design.
     */
    async findDueSoonTasks(limit: number, now: Date, until: Date): Promise<Task[]> {
        return this.repository
            .createQueryBuilder('task')
            .where('task.dueAt IS NOT NULL')
            .andWhere('task.dueAt >= :now', { now })
            .andWhere('task.dueAt <= :until', { until })
            .andWhere('task.dueSoonNotifiedAt IS NULL')
            .andWhere('task.status NOT IN (:...closed)', { closed: ['done', 'cancelled'] })
            .andWhere('task.isRecurring = :recurring', { recurring: false })
            .orderBy('task.dueAt', 'ASC')
            .take(limit)
            .getMany();
    }

    /**
     * EW-P2-3 — give a due-soon claim back (the notice did not reach everyone),
     * so the next scan retries. Only the claim stamped at `claimedAt` is
     * released, never a later one.
     */
    async releaseDueSoonClaim(taskId: string, claimedAt: Date): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(Task)
            .set({ dueSoonNotifiedAt: null })
            .where('id = :id', { id: taskId })
            .andWhere('dueSoonNotifiedAt = :claimedAt', { claimedAt })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * EW-P2-3 — update a Task only while one planning date still holds the
     * value the caller validated against (`startAt` ≤ `dueAt` is a rule over
     * BOTH columns; a PATCH that moves one end must not race a PATCH moving the
     * other). Answers whether the row was written.
     */
    async updateByIdIfUnchanged(
        id: string,
        data: Partial<Task>,
        guard: { field: 'startAt' | 'dueAt'; expected: Date | null },
        manager?: EntityManager,
    ): Promise<boolean> {
        const repository = manager ? manager.getRepository(Task) : this.repository;
        const query = repository
            .createQueryBuilder()
            .update(Task)
            .set(data)
            .where('id = :id', { id });
        if (guard.expected === null) {
            query.andWhere(`${guard.field} IS NULL`);
        } else {
            query.andWhere(`${guard.field} = :expected`, { expected: guard.expected });
        }
        const result = await query.execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * EW-P2-3 — claim the due-soon notice for one Task: only the tick that
     * stamps `dueSoonNotifiedAt` while it is still NULL (and `dueAt` is still
     * the date it read) sends it, so two ticks or replicas never notify twice.
     */
    async casClaimDueSoon(taskId: string, expectedDueAt: Date, now: Date): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(Task)
            .set({ dueSoonNotifiedAt: now })
            .where('id = :id', { id: taskId })
            .andWhere('dueAt = :expected', { expected: expectedDueAt })
            .andWhere('dueSoonNotifiedAt IS NULL')
            .execute();
        return (result.affected ?? 0) > 0;
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

    /**
     * Reviewer agent stage (slice AD, CodeRabbit CR-2) — take the planning
     * lease for one attempt at the agent reviews this Task is owed.
     *
     * Compare-and-set in ONE statement on two things:
     *
     *  - the lease token the caller READ (`expectedLease`, `NULL` included):
     *    the caller decided from that snapshot that an attempt is allowed
     *    (`decideAgentReviewPlanAttempt`), so if any other planner took the
     *    lease since — another replica's poll, an entry hook — the snapshot
     *    is stale and this caller loses. Two replicas polling one Task
     *    therefore plan it once;
     *  - the Task still being `in_review`, so a Task that left review is
     *    never planned from a stale in-memory copy;
     *  - `when` — the time condition, compared HERE against `now` rather
     *    than in JavaScript against a timestamp read back from the row, so it
     *    holds whatever time zone a driver hydrates dates in (`due`: the
     *    backoff elapsed or the lease expired; `no-live-lease`: nobody holds
     *    an unexpired lease).
     *
     * Query-builder update like the other poll bookkeeping here: must not
     * bump `updatedAt` and reshuffle the board.
     */
    async claimAgentReviewPlan(input: {
        taskId: string;
        expectedLease: string | null;
        now: Date;
        when: 'always' | 'due' | 'no-live-lease';
        patch: {
            agentReviewPlanKey: string;
            agentReviewPlanState: 'in-flight';
            agentReviewPlanAttempts: number;
            agentReviewPlanNextAt: Date;
            agentReviewPlanLease: string;
            agentReviewPlanReason?: string | null;
            agentReviewPlanStarted?: number;
        };
    }): Promise<boolean> {
        const qb = this.repository
            .createQueryBuilder()
            .update(Task)
            .set(input.patch)
            .where('id = :taskId', { taskId: input.taskId })
            .andWhere('status = :status', { status: TaskStatus.IN_REVIEW });
        if (input.expectedLease === null) {
            qb.andWhere('agentReviewPlanLease IS NULL');
        } else {
            qb.andWhere('agentReviewPlanLease = :expectedLease', {
                expectedLease: input.expectedLease,
            });
        }
        if (input.when === 'due') {
            qb.andWhere('(agentReviewPlanNextAt IS NULL OR agentReviewPlanNextAt <= :now)', {
                now: input.now,
            });
        } else if (input.when === 'no-live-lease') {
            qb.andWhere(
                "(agentReviewPlanState IS NULL OR agentReviewPlanState <> 'in-flight' OR agentReviewPlanNextAt IS NULL OR agentReviewPlanNextAt <= :now)",
                { now: input.now },
            );
        }
        const result = await qb.execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Record, while the attempt holding `lease` still runs, how many reviews
     * it has claimed for dispatch so far (`agentReviewPlanStarted`). Written
     * right after planning returns and BEFORE the runs are dispatched, so an
     * attempt killed during dispatch still leaves its starts counted against
     * the per-entry approver cap when its lease is taken over. Does not touch
     * the lease: the attempt still has to settle with it.
     */
    async recordAgentReviewPlanProgress(input: {
        taskId: string;
        lease: string;
        started: number;
    }): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(Task)
            .set({ agentReviewPlanStarted: input.started })
            .where('id = :taskId', { taskId: input.taskId })
            .andWhere('agentReviewPlanLease = :lease', { lease: input.lease })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Record how the attempt holding `lease` ended. Lands only while the row
     * still carries that lease: an attempt that outlived its lease and was
     * taken over must not overwrite its successor's memory.
     *
     * ROTATES the lease (adversarial review of CR-2): `patch.agentReviewPlanLease`
     * must be a fresh token. The token is the whole compare-and-set, and a
     * settled / refused / exhausted row has `agentReviewPlanNextAt` NULL, which
     * satisfies the `due` time condition — so a caller holding a copy of the
     * row read WHILE this attempt was in flight (state `in-flight`, this
     * lease) used to pass both checks after this settle and plan a key that
     * had just been refused, settled with cap leftovers, or exhausted. A fresh
     * token (never NULL — a copy read before any lease would match NULL) makes
     * every such copy stale.
     */
    async settleAgentReviewPlan(input: {
        taskId: string;
        lease: string;
        patch: {
            agentReviewPlanKey: string;
            agentReviewPlanState: 'settled' | 'refused' | 'retry' | 'exhausted';
            agentReviewPlanReason: string | null;
            agentReviewPlanNextAt: Date | null;
            agentReviewPlanLease: string;
            agentReviewPlanStarted?: number;
        };
    }): Promise<boolean> {
        if (!input.patch.agentReviewPlanLease || input.patch.agentReviewPlanLease === input.lease) {
            throw new Error(
                `settleAgentReviewPlan: task ${input.taskId} must rotate its planning lease on settle`,
            );
        }
        const result = await this.repository
            .createQueryBuilder()
            .update(Task)
            .set(input.patch)
            .where('id = :taskId', { taskId: input.taskId })
            .andWhere('agentReviewPlanLease = :lease', { lease: input.lease })
            .execute();
        return (result.affected ?? 0) > 0;
    }
}
