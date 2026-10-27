import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    UPSTREAM_ACTIVE_STATES,
    UPSTREAM_LIST_DEFAULT_LIMIT,
    UPSTREAM_LIST_MAX_LIMIT,
    type UpstreamPullRequestState,
} from '@ever-works/contracts';
import { UpstreamPullRequest } from '../../entities/upstream-pull-request.entity';
import { isUniqueConstraintError } from '../../utils/db-error.utils';

/** What `insertActive` writes: everything but the generated and defaulted columns. */
export type UpstreamPullRequestInsert = Omit<
    Partial<UpstreamPullRequest>,
    'id' | 'createdAt' | 'updatedAt' | 'user' | 'work'
> &
    Pick<
        UpstreamPullRequest,
        | 'userId'
        | 'workId'
        | 'upstreamOwner'
        | 'upstreamRepo'
        | 'baseBranch'
        | 'headOwner'
        | 'headRepo'
        | 'headBranch'
        | 'state'
    >;

/** The patch a state change may carry. Never the identity or the scope columns. */
export type UpstreamPullRequestPatch = Omit<
    Partial<UpstreamPullRequest>,
    | 'id'
    | 'userId'
    | 'workId'
    | 'tenantId'
    | 'organizationId'
    | 'createdAt'
    | 'updatedAt'
    | 'user'
    | 'work'
>;

/**
 * `insertActive`'s answer: the row (`inserted: true`), or the id of the active row that already
 * holds the source Task's slot (`inserted: false`). One flat shape rather than a union: this
 * package compiles with `strictNullChecks: false`, where a boolean discriminant does not narrow.
 */
export interface UpstreamPullRequestInsertResult {
    readonly inserted: boolean;
    readonly row: UpstreamPullRequest | null;
    readonly activeId: string | null;
}

/**
 * APW-09 T7 — the `upstream_pull_requests` store.
 *
 * Feature-owned: provided by `UpstreamPullRequestsModule` (its own `forFeature`), exported
 * from `database/index.ts`, and deliberately NOT in `_repository-inventory.ts` (that list is
 * `DatabaseModule`'s own providers only, and its drift spec counts them).
 *
 * ## Scoping
 *
 * Every read is keyed by `workId` (and `id`): the caller has already proved access to the
 * App Work, and a record id from another App Work answers `null` here — the API turns that
 * into a `404`, never a different record.
 *
 * ## Portability
 *
 * Query builder or `find` only — no raw SQL, no dialect function, no `FOR UPDATE`. Windows
 * compare a stored date against a bound `Date` on every driver. State changes are
 * compare-and-set (`updateStateIf`): the `WHERE state IN (:from)` predicate is the fence, so
 * two writers can never both move one record.
 */
@Injectable()
export class UpstreamPullRequestRepository {
    constructor(
        @InjectRepository(UpstreamPullRequest)
        private readonly repository: Repository<UpstreamPullRequest>,
    ) {}

    /**
     * Insert a record in an ACTIVE state, claiming the source Task's one slot (FR-5).
     *
     * The partial unique index is the authority: a lost race answers `inserted: false` with
     * the id of the row that holds the slot, which the API turns into
     * `409 { code: 'activeProposal', id }`. Any other error is rethrown.
     */
    async insertActive(input: UpstreamPullRequestInsert): Promise<UpstreamPullRequestInsertResult> {
        try {
            const row = await this.repository.save(this.repository.create(input));
            return { inserted: true, row, activeId: null };
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            const active = input.sourceTaskId
                ? await this.findActiveBySourceTask(input.workId, input.sourceTaskId)
                : null;
            return { inserted: false, row: null, activeId: active?.id ?? null };
        }
    }

    /** One record of THIS App Work, or `null` (another Work's id answers `null`). */
    async findForWork(workId: string, id: string): Promise<UpstreamPullRequest | null> {
        return this.repository.findOne({ where: { id, workId } });
    }

    /** The active record of a source Task, if any (FR-5). */
    async findActiveBySourceTask(
        workId: string,
        sourceTaskId: string,
    ): Promise<UpstreamPullRequest | null> {
        return this.repository
            .createQueryBuilder('upr')
            .where('upr.workId = :workId', { workId })
            .andWhere('upr.sourceTaskId = :sourceTaskId', { sourceTaskId })
            .andWhere('upr.state IN (:...states)', { states: [...UPSTREAM_ACTIVE_STATES] })
            .orderBy('upr.createdAt', 'DESC')
            .addOrderBy('upr.id', 'ASC')
            .getOne();
    }

    /**
     * The Upstream tab's list: every member's records for this App Work, newest first
     * (G11 — each row carries its author). `limit` is clamped to [1, 100].
     */
    async listForWork(
        workId: string,
        options: { state?: UpstreamPullRequestState | null; limit?: number | null } = {},
    ): Promise<{ rows: UpstreamPullRequest[]; total: number }> {
        const limit = clampLimit(options.limit);
        const query = this.repository
            .createQueryBuilder('upr')
            .where('upr.workId = :workId', { workId });
        if (options.state) query.andWhere('upr.state = :state', { state: options.state });
        const [rows, total] = await query
            .orderBy('upr.createdAt', 'DESC')
            .addOrderBy('upr.id', 'ASC')
            .take(limit)
            .getManyAndCount();
        return { rows, total };
    }

    /** The member's most recent record on this App Work — FR-24's maintainer-edit default. */
    async findLatestForUser(workId: string, userId: string): Promise<UpstreamPullRequest | null> {
        return this.repository
            .createQueryBuilder('upr')
            .where('upr.workId = :workId', { workId })
            .andWhere('upr.userId = :userId', { userId })
            .orderBy('upr.createdAt', 'DESC')
            .addOrderBy('upr.id', 'ASC')
            .getOne();
    }

    /**
     * Compare-and-set state change: moves the record only while its state is one of `from`.
     * `true` when THIS call moved it.
     */
    async updateStateIf(
        id: string,
        workId: string,
        from: readonly UpstreamPullRequestState[],
        to: UpstreamPullRequestState,
        patch: UpstreamPullRequestPatch = {},
    ): Promise<boolean> {
        if (from.length === 0) return false;
        const result = await this.repository
            .createQueryBuilder()
            .update(UpstreamPullRequest)
            .set({ ...patch, state: to })
            .where('id = :id', { id })
            .andWhere('workId = :workId', { workId })
            .andWhere('state IN (:...from)', { from: [...from] })
            .execute();
        return (result.affected ?? 0) === 1;
    }

    /** Patch a record without moving its state (e.g. the extra-files acknowledgement). */
    async patchIf(
        id: string,
        workId: string,
        from: readonly UpstreamPullRequestState[],
        patch: UpstreamPullRequestPatch,
    ): Promise<boolean> {
        if (from.length === 0) return false;
        const { state: _ignored, ...rest } = patch;
        const result = await this.repository
            .createQueryBuilder()
            .update(UpstreamPullRequest)
            .set(rest)
            .where('id = :id', { id })
            .andWhere('workId = :workId', { workId })
            .andWhere('state IN (:...from)', { from: [...from] })
            .execute();
        return (result.affected ?? 0) === 1;
    }

    // ── FR-26 / FR-39 windows ────────────────────────────────────────────

    /** Pull requests this member opened on one upstream since `since` (FR-26, per upstream). */
    async countOpenedByUserOnUpstream(
        userId: string,
        upstreamOwner: string,
        upstreamRepo: string,
        since: Date,
    ): Promise<number> {
        return this.repository
            .createQueryBuilder('upr')
            .where('upr.userId = :userId', { userId })
            .andWhere('LOWER(upr.upstreamOwner) = :owner', { owner: upstreamOwner.toLowerCase() })
            .andWhere('LOWER(upr.upstreamRepo) = :repo', { repo: upstreamRepo.toLowerCase() })
            .andWhere('upr.openedAt >= :since', { since })
            .getCount();
    }

    /** Pull requests this member opened anywhere since `since` (FR-26, overall). */
    async countOpenedByUser(userId: string, since: Date): Promise<number> {
        return this.repository
            .createQueryBuilder('upr')
            .where('upr.userId = :userId', { userId })
            .andWhere('upr.openedAt >= :since', { since })
            .getCount();
    }

    /** Pull requests Ever Works opened on one upstream since `since`, every member (FR-39). */
    async countOpenedOnUpstream(
        upstreamOwner: string,
        upstreamRepo: string,
        since: Date,
    ): Promise<number> {
        return this.repository
            .createQueryBuilder('upr')
            .where('LOWER(upr.upstreamOwner) = :owner', { owner: upstreamOwner.toLowerCase() })
            .andWhere('LOWER(upr.upstreamRepo) = :repo', { repo: upstreamRepo.toLowerCase() })
            .andWhere('upr.openedAt >= :since', { since })
            .getCount();
    }

    /**
     * This member's pull requests on one upstream that are still `opening` / `open`
     * (FR-26's open-at-once cap).
     */
    async countOpenByUserOnUpstream(
        userId: string,
        upstreamOwner: string,
        upstreamRepo: string,
    ): Promise<number> {
        return this.repository
            .createQueryBuilder('upr')
            .where('upr.userId = :userId', { userId })
            .andWhere('LOWER(upr.upstreamOwner) = :owner', { owner: upstreamOwner.toLowerCase() })
            .andWhere('LOWER(upr.upstreamRepo) = :repo', { repo: upstreamRepo.toLowerCase() })
            .andWhere('upr.state IN (:...states)', { states: ['opening', 'open'] })
            .getCount();
    }

    /** Preparations this member started since `since` (FR-26). */
    async countPreparationsStartedByUser(userId: string, since: Date): Promise<number> {
        return this.repository
            .createQueryBuilder('upr')
            .where('upr.userId = :userId', { userId })
            .andWhere('upr.origin = :origin', { origin: 'proposal' })
            .andWhere('upr.createdAt >= :since', { since })
            .getCount();
    }

    /** Preparations currently running on this App Work (FR-26: at most 1). */
    async countPreparingOnWork(workId: string): Promise<number> {
        return this.repository
            .createQueryBuilder('upr')
            .where('upr.workId = :workId', { workId })
            .andWhere('upr.state = :state', { state: 'preparing' })
            .getCount();
    }

    /**
     * The `openedAt` values of the rows that fill a window, oldest first — the oldest one
     * plus 24 hours is when the next slot opens (FR-27's `nextSlotAt`).
     */
    async openedAtInWindow(
        scope: { userId?: string; upstreamOwner?: string; upstreamRepo?: string },
        since: Date,
        take: number,
    ): Promise<Date[]> {
        const query = this.repository
            .createQueryBuilder('upr')
            .select(['upr.id', 'upr.openedAt'])
            .where('upr.openedAt >= :since', { since });
        if (scope.userId) query.andWhere('upr.userId = :userId', { userId: scope.userId });
        if (scope.upstreamOwner) {
            query.andWhere('LOWER(upr.upstreamOwner) = :owner', {
                owner: scope.upstreamOwner.toLowerCase(),
            });
        }
        if (scope.upstreamRepo) {
            query.andWhere('LOWER(upr.upstreamRepo) = :repo', {
                repo: scope.upstreamRepo.toLowerCase(),
            });
        }
        const rows = await query
            .orderBy('upr.openedAt', 'ASC')
            .addOrderBy('upr.id', 'ASC')
            .take(Math.max(1, Math.min(take, 100)))
            .getMany();
        return rows
            .map((row) => (row.openedAt ? new Date(row.openedAt) : null))
            .filter((value): value is Date => value !== null && Number.isFinite(value.getTime()));
    }
}

function clampLimit(value: number | null | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return UPSTREAM_LIST_DEFAULT_LIMIT;
    return Math.max(1, Math.min(Math.trunc(value), UPSTREAM_LIST_MAX_LIMIT));
}
