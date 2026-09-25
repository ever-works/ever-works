import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
    APP_BUILD_LIST_MAX_PAGE_SIZE,
    APP_BUILD_LIST_PAGE_SIZE,
    APP_BUILD_SWEEP_BATCH,
    type AppBuildStatus,
    type AppBuildTrigger,
} from '@ever-works/contracts';
import { WorkBuild } from '../../entities/work-build.entity';
import { WorkBuildPreparation } from '../../entities/work-build-preparation.entity';
import { Work } from '../../entities/work.entity';
import { serializeOnSingleConnection } from './single-connection-write-queue';

/**
 * APW-05 (Builds) — the `work_builds` repository.
 *
 * Plan §3.1 (`plan.md:381-396`) states the number arithmetic and the upsert
 * rule; T6 fixes the signatures. Feature-owned: it is provided by the App Works
 * module and exported from `database/index.ts` for it, NOT by `DatabaseModule` —
 * see the docstring of `_repository-inventory.ts` for why a feature-owned
 * repository must not appear in that inventory.
 *
 * ## `number` is assigned under a lock, and retried on a unique violation
 *
 * `insertWithNextNumber` runs ONE transaction (plan §3.1:381-392):
 *
 *  1. On `postgres`, `mysql` and `mariadb` it locks the parent Work row —
 *     `findOne({ where: { id: workId }, lock: { mode: 'pessimistic_write' },
 *     loadEagerRelations: false })`. 🛑 `loadEagerRelations: false` is
 *     load-bearing, exactly as `CreditLedgerRepository.lockUserRow` documents:
 *     `Work.user` is eager, so a plain `findOne` LEFT JOINs it and PostgreSQL
 *     refuses `SELECT … FOR UPDATE` over the nullable side of an outer join.
 *     The lock is skipped on the SQLite family, where one connection serialises
 *     writes at the driver.
 *  2. It reads `COALESCE(MAX(number), 0) + 1` through the query builder, with
 *     **no `FOR UPDATE`** — PostgreSQL rejects that together with an aggregate.
 *  3. It inserts. A unique violation of `uq_work_builds_work_number` is retried
 *     up to {@link APP_BUILD_NUMBER_RETRIES} times, and any other error is
 *     re-thrown untouched.
 *
 * The whole call is wrapped in {@link serializeOnSingleConnection} for the same
 * reason `WorkUpstreamStateRepository.claimDue` is: better-sqlite3 is the
 * default `DATABASE_TYPE` and TypeORM hands every caller the SAME query runner
 * there, so two overlapping `manager.transaction` calls collide or nest as
 * savepoints of each other (see that helper's docstring). With the queue in
 * place the twenty-way concurrency case of T6 produces 1…20 with no gap and no
 * duplicate on the driver CI and the e2e stack actually run.
 *
 * ## Every instant here is epoch milliseconds, not a `Date`
 *
 * `claimWatchLease`, `findSilentNonTerminal`, `findWithOrphanedVerifySecrets`,
 * `findUndispatchedRequested` and `findNeverAdoptedQueuedBefore` take plain
 * numbers, and every predicate compares the `bigint` columns the
 * entity stores. A `Date` bound into a query-builder predicate is passed to the
 * driver verbatim — better-sqlite3 refuses to bind one at all, and PostgreSQL
 * would be asked to compare a `bigint` with a `timestamptz`. Dates appear only
 * where TypeORM applies the column transformer: `.set()` on a timestamp column.
 *
 * ## Driver-agnostic SQL (`APW05-G10`)
 *
 * The platform runs on MySQL and MariaDB as well as PostgreSQL and the SQLite
 * family, so nothing here is dialect-specific: no raw statement, no
 * double-quoted SQL fragment beyond the column names TypeORM itself quotes, no
 * `interval '` literal and no partial index. NULL ordering is made explicit with
 * a `CASE` expression rather than left to each driver's default, because
 * PostgreSQL sorts NULLs LAST on `ASC` while SQLite and MySQL sort them FIRST —
 * and "stalest first" has to mean one thing.
 *
 * `apps/api/src/migrations/__tests__/query-shape.spec.ts` asserts those
 * properties on this file's source, so the rule is enforced by a test rather
 * than by review (the rule commit `b5a7d6857` established).
 */

/**
 * How many times `insertWithNextNumber` re-reads the maximum and retries after a
 * unique violation of `uq_work_builds_work_number` (plan §3.1:390).
 */
export const APP_BUILD_NUMBER_RETRIES = 3;

/**
 * The two statuses the sweep looks at (plan §7.4:1401). Deliberately a local
 * constant rather than a contracts export: `plan §3.2`'s closed sets do not
 * publish an "open" subset, and inventing one in the contract module is APW-05's
 * own T2 surface, not this file's.
 */
export const APP_BUILD_OPEN_STATUSES: readonly AppBuildStatus[] = ['queued', 'running'];

/**
 * The two triggers of a Build the PLATFORM asks for — a Rebuild and a
 * verification (plan §7.2:1374-1375). Only these are started by
 * `workflow_dispatch` and adopted later by their display title, so only these can
 * be stuck undispatched (§9.2) or never adopted (§7.4); a push or pull-request
 * Build is created FROM its run and carries the run id from the start. Local for
 * the same reason as {@link APP_BUILD_OPEN_STATUSES}.
 */
export const APP_BUILD_REQUESTED_TRIGGERS: readonly AppBuildTrigger[] = ['manual', 'verification'];

/**
 * How long a verification Build's per-run prompted-value secret may outlive
 * `startedAt` before the sweep removes it: `30 + 10` minutes (plan §4.10:1019 and
 * §7.4:1405). It is the verification timeout of §4.5 plus the ten-minute grace,
 * so a run that is still going never loses the value it is using.
 */
export const APP_BUILD_ORPHANED_VERIFY_SECRET_MS = 2_400_000;

/**
 * The empty `string[]` as TypeORM's `simple-json` writes it. A verification
 * Build with no prompted names stores this, and it is NOT an orphan to clean up.
 */
const EMPTY_JSON_LIST = '[]';

/**
 * The columns a caller may set on INSERT. The identity (`id`, `workId`), the
 * sequence (`number`) and the creation stamp are the repository's — see
 * {@link AppBuildRepository.insertWithNextNumber}.
 */
export type WorkBuildInsert = Pick<
    WorkBuild,
    'buildPluginId' | 'status' | 'trigger' | 'branch' | 'commitSha'
> &
    Partial<Omit<WorkBuild, 'id' | 'workId' | 'number' | 'work' | 'createdAt' | 'updatedAt'>>;

/** The columns a caller may change on an existing row: never the identity, never the number. */
export type WorkBuildPatch = Partial<
    Omit<WorkBuild, 'id' | 'workId' | 'number' | 'work' | 'createdAt' | 'updatedAt'>
>;

/** Options shared by the two write paths. */
export interface WriteWorkBuildOptions {
    /**
     * Copy `buildInputsHash`, `buildSecretNames` and `secretsSyncedAt` from the
     * App Work's preparation row **in the same transaction** (plan §7.5:1467-1470).
     * With the flag on, that row is authoritative: a Work with no preparation row
     * leaves all three NULL, which §5.1's verdict reads as `staleInputs`.
     */
    readonly stampFromPreparation?: boolean;
}

/** The result of {@link AppBuildRepository.upsertByProviderRun}. */
export interface UpsertProviderRunResult {
    readonly build: WorkBuild;
    /**
     * `true` only when THIS call inserted the row. The consumer publishes
     * `app.build.queued` and dispatches `app-build-watch` on a create and must
     * not do either for a duplicate delivery or a delivery racing a poll
     * (§9.2) — so the distinction is the caller's, and it is reported here
     * rather than guessed from a second read.
     */
    readonly created: boolean;
}

/** The filters the Builds list accepts (plan §5:1196). */
export interface WorkBuildPageFilters {
    readonly status?: readonly AppBuildStatus[];
    readonly trigger?: readonly AppBuildTrigger[];
    readonly branch?: string;
    readonly pullRequestNumber?: number;
}

/** One page of the Builds list (plan §5:1196). */
export interface WorkBuildPage {
    readonly rows: WorkBuild[];
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    readonly hasMore: boolean;
}

/**
 * The three columns a push or pull-request Build copies from the preparation
 * row. `null` on any of them is a real value — "no sync has completed" — never
 * an omission (§3.1b:407-409).
 */
interface PreparationStamps {
    readonly buildInputsHash: string | null;
    readonly buildSecretNames: string[] | null;
    readonly secretsSyncedAt: Date | null;
}

@Injectable()
export class AppBuildRepository {
    constructor(
        @InjectRepository(WorkBuild)
        private readonly repository: Repository<WorkBuild>,
    ) {}

    /**
     * Insert one Build, assigning the next number for this App Work, and
     * optionally stamping the three secret-sync columns from the preparation row.
     *
     * The whole transaction is serialised per DataSource and retried on a unique
     * violation — see the class docstring for why each part is there.
     */
    async insertWithNextNumber(
        workId: string,
        data: WorkBuildInsert,
        options: WriteWorkBuildOptions = {},
    ): Promise<WorkBuild> {
        return serializeOnSingleConnection(this.repository.manager, () =>
            this.insertWithRetry(workId, data, options),
        );
    }

    /**
     * Upsert by the run identity `(buildPluginId, providerRunId, runAttempt)`
     * (plan §3.1:394-396): a duplicate delivery or a delivery racing a poll is a
     * no-op, and the two intake paths converge on ONE row.
     *
     * The `uq_work_builds_provider_run` violation is detected across drivers
     * exactly as {@link AppBuildRepository.isUniqueViolation} does, and the loser
     * of the race re-reads the winner's row and updates it rather than failing.
     */
    async upsertByProviderRun(
        workId: string,
        data: WorkBuildInsert & { readonly providerRunId: string },
        options: WriteWorkBuildOptions = {},
    ): Promise<UpsertProviderRunResult> {
        const runAttempt = data.runAttempt ?? 1;
        const existing = await this.findByProviderRun(
            data.buildPluginId,
            data.providerRunId,
            runAttempt,
        );

        if (existing) {
            return { build: await this.updateById(existing.id, data), created: false };
        }

        try {
            return {
                build: await this.insertWithNextNumber(workId, data, options),
                created: true,
            };
        } catch (error) {
            if (!this.isUniqueViolation(error)) {
                throw error;
            }

            // Lost the race: another delivery (or the poll) inserted this run's
            // row between the read above and the insert. Re-read and update it.
            const raced = await this.findByProviderRun(
                data.buildPluginId,
                data.providerRunId,
                runAttempt,
            );
            if (!raced) {
                throw error;
            }

            return { build: await this.updateById(raced.id, data), created: false };
        }
    }

    /** One page of one App Work's Builds, newest first (plan §5:1196). */
    async findPage(
        workId: string,
        filters: WorkBuildPageFilters = {},
        page = 1,
        pageSize: number = APP_BUILD_LIST_PAGE_SIZE,
    ): Promise<WorkBuildPage> {
        const size = this.pageSize(pageSize);
        const current = Math.max(1, Math.floor(Number.isFinite(page) ? page : 1));

        const query = this.repository
            .createQueryBuilder('build')
            .where('build.workId = :workId', { workId });

        if (filters.status?.length) {
            query.andWhere('build.status IN (:...statuses)', { statuses: [...filters.status] });
        }
        if (filters.trigger?.length) {
            query.andWhere('build.trigger IN (:...triggers)', { triggers: [...filters.trigger] });
        }
        if (filters.branch !== undefined) {
            query.andWhere('build.branch = :branch', { branch: filters.branch });
        }
        if (filters.pullRequestNumber !== undefined) {
            query.andWhere('build.pullRequestNumber = :pullRequestNumber', {
                pullRequestNumber: filters.pullRequestNumber,
            });
        }

        // `(workId, createdAt)` is `idx_work_builds_work_created`, the index the
        // plan creates for exactly this read; `number` and `id` break ties so the
        // page boundary can never repeat or skip a row.
        const [rows, total] = await query
            .orderBy('build.createdAt', 'DESC')
            .addOrderBy('build.number', 'DESC')
            .addOrderBy('build.id', 'ASC')
            .skip((current - 1) * size)
            .take(size)
            .getManyAndCount();

        return {
            rows,
            total,
            page: current,
            pageSize: size,
            hasMore: current * size < total,
        };
    }

    /**
     * One Build of one App Work, or `null`. A Build id belonging to another Work
     * (or to another account) is simply not found — plan §5:1190 turns that into
     * a 404 at the controller, so the ownership check is the predicate, not a
     * post-read comparison.
     */
    async findByIdForWork(workId: string, id: string): Promise<WorkBuild | null> {
        return this.repository.findOne({ where: { id, workId } });
    }

    /**
     * The most recent Build of this App Work for this commit created at or after
     * `sinceMs` — FR-41/FR-42's Rebuild dedupe window
     * (`APP_BUILD_REBUILD_DEDUPE_MS`) and APW-06's "green Build for commit".
     *
     * `null` means "no Build of this commit inside the window", which is what
     * makes a Rebuild a new Build rather than a second dispatch.
     */
    async findRecentForCommit(
        workId: string,
        commitSha: string,
        sinceMs: number,
    ): Promise<WorkBuild | null> {
        return this.repository
            .createQueryBuilder('build')
            .where('build.workId = :workId', { workId })
            .andWhere('build.commitSha = :commitSha', { commitSha })
            .andWhere('build.createdAt >= :since', { since: new Date(sinceMs) })
            .orderBy('build.createdAt', 'DESC')
            .addOrderBy('build.number', 'DESC')
            .getOne();
    }

    /**
     * Claim the one-shot `app-build-watch` lease (§7.3:1386-1388), written
     * through the query builder with a parameterised timestamp so no
     * driver-specific SQL appears:
     *
     *     UPDATE work_builds SET watchLeaseUntil = :until
     *      WHERE id = :id AND (watchLeaseUntil IS NULL OR watchLeaseUntil < :now)
     *
     * `true` when this call won the row (1 row affected); `false` when a live
     * lease already covers it, which is the caller's signal to exit without
     * calling the provider.
     */
    async claimWatchLease(id: string, leaseMs: number): Promise<boolean> {
        const now = Date.now();
        const until = new Date(now + Math.max(0, leaseMs));

        const result = await this.repository
            .createQueryBuilder()
            .update(WorkBuild)
            .set({ watchLeaseUntil: until })
            .where('id = :id', { id })
            .andWhere('(watchLeaseUntil IS NULL OR watchLeaseUntil < :now)', { now })
            .execute();

        return (result.affected ?? 0) === 1;
    }

    /**
     * Up to `limit` non-terminal Builds nobody has observed for `silenceMs` —
     * the sweep's main pass (§7.4:1401-1402), stalest first.
     *
     * A Build is silent when its last observation is older than the cutoff, or —
     * when it has never been observed — when its dispatch is. A Build that was
     * never dispatched and never observed is NOT silent: nothing has failed to
     * report yet, which is why the `dispatchedAt` half is not merely
     * `COALESCE(lastObservedAt, queuedAt)`.
     */
    async findSilentNonTerminal(
        nowMs: number,
        silenceMs: number,
        limit: number,
    ): Promise<WorkBuild[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        const cutoff = nowMs - Math.max(0, silenceMs);

        return (
            this.repository
                .createQueryBuilder('build')
                .where('build.status IN (:...statuses)', {
                    statuses: [...APP_BUILD_OPEN_STATUSES],
                })
                .andWhere(
                    '(build.lastObservedAt < :cutoff OR (build.lastObservedAt IS NULL AND build.dispatchedAt < :cutoff))',
                    { cutoff },
                )
                // A `CASE` rather than a bare `ORDER BY … ASC`: PostgreSQL sorts
                // NULLs LAST ascending while SQLite and MySQL sort them FIRST, and
                // "never observed" is the stalest row of all on every driver.
                .orderBy('CASE WHEN build.lastObservedAt IS NULL THEN 0 ELSE 1 END', 'ASC')
                .addOrderBy('build.lastObservedAt', 'ASC')
                .addOrderBy('build.id', 'ASC')
                .take(take)
                .getMany()
        );
    }

    /**
     * Up to `limit` requested Builds nothing has dispatched, queued between
     * `minAgeMs` and `maxAgeMs` ago — the sweep's re-drive (§9.2: "a requested
     * Build stays queued" and the job is retried 3 times), oldest first.
     *
     * The window is half-open by age, `[minAgeMs, maxAgeMs)`:
     * `queuedAt <= now - minAgeMs AND queuedAt > now - maxAgeMs`. A window three
     * sweep intervals long therefore holds exactly three ticks whatever their
     * phase WHEN the ticks are exactly one interval apart — and three ±1 when they
     * drift, as real scheduled ticks do. Either way the window is what bounds the
     * re-drives of one Build.
     *
     * `dispatchedAt IS NULL` is the runner's own selection rule
     * (`readRequestedBuilds`) and its dispatch claim: a Build the runner claimed
     * or started is never re-driven, so a re-drive cannot start a Build twice.
     */
    async findUndispatchedRequested(
        nowMs: number,
        minAgeMs: number,
        maxAgeMs: number,
        limit: number,
    ): Promise<WorkBuild[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        const newest = nowMs - Math.max(0, minAgeMs);
        const oldest = nowMs - Math.max(0, maxAgeMs);

        return this.repository
            .createQueryBuilder('build')
            .where('build.status = :queued', { queued: 'queued' })
            .andWhere('build.trigger IN (:...triggers)', {
                triggers: [...APP_BUILD_REQUESTED_TRIGGERS],
            })
            .andWhere('build.dispatchedAt IS NULL')
            .andWhere('build.queuedAt <= :newest', { newest })
            .andWhere('build.queuedAt > :oldest', { oldest })
            .orderBy('build.queuedAt', 'ASC')
            .addOrderBy('build.id', 'ASC')
            .take(take)
            .getMany();
    }

    /**
     * Up to `limit` open requested Builds that no provider run was ever adopted
     * for (`providerRunId IS NULL`), queued strictly before `cutoffMs` — the
     * candidates for §7.4's never-adopted `lost` rule (`queuedAt + 5 min +
     * timeoutMinutes + 30`), oldest first.
     *
     * One cutoff only: `timeoutMinutes` is per App spec, so the sweep passes the
     * cutoff of the SHORTEST legal timeout and applies each Build's own deadline
     * itself. A `blocked` Build is not open and is never selected — it waits for
     * its owner, not for a provider.
     */
    async findNeverAdoptedQueuedBefore(cutoffMs: number, limit: number): Promise<WorkBuild[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        return this.repository
            .createQueryBuilder('build')
            .where('build.status IN (:...statuses)', {
                statuses: [...APP_BUILD_OPEN_STATUSES],
            })
            .andWhere('build.providerRunId IS NULL')
            .andWhere('build.trigger IN (:...triggers)', {
                triggers: [...APP_BUILD_REQUESTED_TRIGGERS],
            })
            .andWhere('build.queuedAt < :cutoff', { cutoff: cutoffMs })
            .orderBy('build.queuedAt', 'ASC')
            .addOrderBy('build.id', 'ASC')
            .take(take)
            .getMany();
    }

    /**
     * Verification Builds whose per-run prompted-value secret is still recorded
     * more than {@link APP_BUILD_ORPHANED_VERIFY_SECRET_MS} after `startedAt`
     * (§4.10:1019, §7.4:1404-1405) — the rows whose secret the sweep must delete.
     *
     * A Build with no `startedAt` is excluded: the secret is written when the run
     * starts, so a Build that never started has none to remove. A Build whose
     * `verifySecretNames` is the EMPTY list is excluded too — that is the shape a
     * run with no prompted values leaves, and it is not an orphan.
     */
    async findWithOrphanedVerifySecrets(nowMs: number, limit: number): Promise<WorkBuild[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        const cutoff = nowMs - APP_BUILD_ORPHANED_VERIFY_SECRET_MS;

        return this.repository
            .createQueryBuilder('build')
            .where('build.trigger = :verification', { verification: 'verification' })
            .andWhere('build.startedAt IS NOT NULL')
            .andWhere('build.startedAt <= :cutoff', { cutoff })
            .andWhere('build.verifySecretNames IS NOT NULL')
            .andWhere('build.verifySecretNames <> :emptyList', { emptyList: EMPTY_JSON_LIST })
            .orderBy('build.startedAt', 'ASC')
            .addOrderBy('build.id', 'ASC')
            .take(take)
            .getMany();
    }

    /**
     * Fail Builds the provider stopped reporting as `lost` (§7.4:1402-1403) and
     * return how many rows this call actually moved.
     *
     * The `status IN (queued, running)` predicate is re-checked in the UPDATE, so
     * a Build that finished between the sweep's SELECT and this statement keeps
     * the status it earned: a lost-sweep must never overwrite a real outcome.
     */
    async markLost(ids: readonly string[], completedAt: Date = new Date()): Promise<number> {
        if (ids.length === 0) {
            return 0;
        }

        const result = await this.repository
            .createQueryBuilder()
            .update(WorkBuild)
            .set({ status: 'failed', failureClass: 'lost', completedAt })
            .where('id IN (:...ids)', { ids: [...ids] })
            .andWhere('status IN (:...statuses)', { statuses: [...APP_BUILD_OPEN_STATUSES] })
            .execute();

        return result.affected ?? 0;
    }

    /**
     * §7.4's never-adopted `lost` for ONE Build, applied only while the row is still
     * exactly what the sweep read: open (`queued`/`running`), with no provider run
     * adopted (`providerRunId IS NULL`) and the same `dispatchedAt` — NULL still NULL,
     * or the very stamp that was read. `true` when the row was moved.
     *
     * {@link markLost} re-checks the status alone, which suffices for a Build the
     * provider stopped reporting. The never-adopted rule is about something that has
     * NOT happened yet, and it can happen between the sweep's read and this write: the
     * watch adopts the run (`providerRunId`), or a prepare pass claims and starts the
     * Build (its dispatch claim stamps `dispatchedAt`). Failing the Build then would
     * orphan a run that just started — the runner's record patch finds a row that is
     * no longer `queued` and records nothing. With the predicate re-checked here the
     * write simply misses, and the next tick measures the Build again from what it
     * then reads.
     *
     * `readDispatchedAtMs` is epoch milliseconds, like every instant in this file.
     */
    async markNeverAdoptedLost(
        id: string,
        readDispatchedAtMs: number | null,
        completedAt: Date = new Date(),
    ): Promise<boolean> {
        const update = this.repository
            .createQueryBuilder()
            .update(WorkBuild)
            .set({ status: 'failed', failureClass: 'lost', completedAt })
            .where('id = :id', { id })
            .andWhere('status IN (:...statuses)', { statuses: [...APP_BUILD_OPEN_STATUSES] })
            .andWhere('providerRunId IS NULL');

        if (readDispatchedAtMs === null) {
            update.andWhere('dispatchedAt IS NULL');
        } else {
            update.andWhere('dispatchedAt = :readDispatchedAt', {
                readDispatchedAt: readDispatchedAtMs,
            });
        }

        const result = await update.execute();

        return (result.affected ?? 0) === 1;
    }

    /** The one row of a run identity, or `null` — the read {@link upsertByProviderRun} decides on. */
    private async findByProviderRun(
        buildPluginId: string,
        providerRunId: string,
        runAttempt: number,
    ): Promise<WorkBuild | null> {
        return this.repository.findOne({
            where: { buildPluginId, providerRunId, runAttempt },
        });
    }

    /** Patch one row by id. `null` when the row is gone — the caller decides what that means. */
    private async updateById(id: string, patch: WorkBuildPatch): Promise<WorkBuild> {
        const row = await this.repository.findOne({ where: { id } });
        if (!row) {
            throw new Error(`AppBuildRepository: work_builds row ${id} disappeared before update`);
        }

        this.repository.merge(row, patch);

        return this.repository.save(row);
    }

    /** One insert attempt inside its own transaction; retried by the caller. */
    private async insertWithRetry(
        workId: string,
        data: WorkBuildInsert,
        options: WriteWorkBuildOptions,
    ): Promise<WorkBuild> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await this.repository.manager.transaction(async (manager) => {
                    // 1. Serialise competing inserts for THIS Work on the drivers
                    //    that support a row lock. See the class docstring for why
                    //    `loadEagerRelations: false` is not optional.
                    await this.lockWorkRow(manager, workId);

                    // 2. The next number. No `FOR UPDATE` — a dialect that
                    //    supports the lock rejects it beside an aggregate, and the
                    //    Work-row lock above is what serialises the readers.
                    const number = await this.nextNumber(manager, workId);

                    // 3. Insert, with the preparation stamps when asked for.
                    const stamps = options.stampFromPreparation
                        ? await this.readPreparationStamps(manager, workId)
                        : null;
                    const repo = manager.getRepository(WorkBuild);
                    const entity = repo.create({
                        ...data,
                        workId,
                        number,
                        ...(stamps ?? {}),
                    });

                    return repo.save(entity);
                });
            } catch (error) {
                if (attempt >= APP_BUILD_NUMBER_RETRIES || !this.isUniqueViolation(error)) {
                    throw error;
                }
                // `uq_work_builds_work_number` was taken between the read and the
                // insert: re-read the maximum and try again.
            }
        }
    }

    /**
     * Lock the parent Work row for the rest of the transaction. Pessimistic row
     * locks are only supported on postgres/mysql/mariadb; the SQLite family
     * throws `LockNotSupportedOnGivenDriverError` AND serialises writes at the
     * connection anyway, so the lock is safely skipped there — the same shape as
     * `CreditLedgerRepository.lockUserRow`.
     */
    private async lockWorkRow(manager: EntityManager, workId: string): Promise<void> {
        const driver = manager.connection.options.type;
        if (driver === 'postgres' || driver === 'mysql' || driver === 'mariadb') {
            await manager.getRepository(Work).findOne({
                where: { id: workId },
                lock: { mode: 'pessimistic_write' },
                // Lock the row, join nothing. See the class docstring.
                loadEagerRelations: false,
            });
        }
    }

    /**
     * `COALESCE(MAX(number), 0) + 1` for one App Work, through the query builder.
     * `workId` is parameterised; nothing here is dialect-specific.
     */
    private async nextNumber(manager: EntityManager, workId: string): Promise<number> {
        const raw = await manager
            .getRepository(WorkBuild)
            .createQueryBuilder('build')
            .select('COALESCE(MAX(build.number), 0)', 'highest')
            .where('build.workId = :workId', { workId })
            .getRawOne<{ highest: string | number }>();

        return Number(raw?.highest ?? 0) + 1;
    }

    /**
     * The three columns a push or pull-request Build copies from the preparation
     * row, read inside the INSERT's transaction so the value stamped is the one
     * that was stored. No row → all three `null` (§7.5:1467-1470).
     */
    private async readPreparationStamps(
        manager: EntityManager,
        workId: string,
    ): Promise<PreparationStamps> {
        const preparation = await manager
            .getRepository(WorkBuildPreparation)
            .findOne({ where: { workId } });

        return {
            buildInputsHash: preparation?.buildInputsHash ?? null,
            buildSecretNames: preparation?.buildSecretNames ?? null,
            secretsSyncedAt: preparation?.secretsSyncedAt ?? null,
        };
    }

    /** Plan §5:1196 — `pageSize` 1–100, default 20. */
    private pageSize(pageSize: number): number {
        if (!Number.isFinite(pageSize)) {
            return APP_BUILD_LIST_PAGE_SIZE;
        }
        return Math.max(1, Math.min(Math.floor(pageSize), APP_BUILD_LIST_MAX_PAGE_SIZE));
    }

    /**
     * The hard ceiling on one sweep batch, whatever the caller asks for. The
     * sweep asks for `APP_BUILD_SWEEP_BATCH` (200, plan §7.4:1401); this only
     * stops an unbounded value from loading the whole table into memory.
     */
    private batchSize(limit: number): number {
        if (!Number.isFinite(limit)) {
            return APP_BUILD_SWEEP_BATCH;
        }
        return Math.max(0, Math.min(Math.floor(limit), APP_BUILD_SWEEP_BATCH));
    }

    /**
     * Driver-agnostic unique-violation detection: PostgreSQL exposes code
     * `23505`, SQLite surfaces `UNIQUE constraint failed` and MySQL/MariaDB
     * `Duplicate entry` in the message — exactly as
     * `CreditLedgerRepository.isUniqueViolation` detects it, because a Build
     * number and a run identity are the same class of collision.
     */
    private isUniqueViolation(error: unknown): boolean {
        const err = error as { code?: string; message?: string; driverError?: { code?: string } };
        if (err?.code === '23505' || err?.driverError?.code === '23505') {
            return true;
        }
        const message = String(err?.message ?? '');
        return (
            message.includes('UNIQUE constraint failed') ||
            message.includes('duplicate key') ||
            message.includes('Duplicate entry')
        );
    }
}
