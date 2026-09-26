import { readFileSync } from 'fs';
import { join } from 'path';
import type { Repository } from 'typeorm';
import { APP_BUILD_SWEEP_BATCH } from '@ever-works/contracts';
import { WorkBuild } from '../../../../../packages/agent/src/entities/work-build.entity';
import type { WorkBuildPreparation } from '../../../../../packages/agent/src/entities/work-build-preparation.entity';
import {
    APP_BUILD_ORPHANED_VERIFY_SECRET_MS,
    AppBuildRepository,
} from '../../../../../packages/agent/src/database/repositories/app-build.repository';
import { AppBuildPreparationRepository } from '../../../../../packages/agent/src/database/repositories/app-build-preparation.repository';

/**
 * APW-05 T6 — the query-shape spec for the two Builds repositories, the
 * "existing query-shape precedent" the task names (`APW05-G10`).
 *
 * Commit `b5a7d6857` established the rule: nothing the platform sends to a
 * driver may be dialect-specific, because the platform also runs on MySQL and
 * MariaDB where a **double-quoted token is a string literal, not an
 * identifier** (`ANSI_QUOTES` is off by default), and where a partial index does
 * not exist at all. T6 asks for that rule to be pinned **by a test** rather than
 * by review, and the two halves below are that test:
 *
 *  1. a SOURCE scan of both repositories — no raw statement, no double-quoted
 *     SQL fragment, no `interval '` literal, no `FOR UPDATE` inside the
 *     aggregate that assigns the Build number;
 *  2. a RECORDING query builder — what the repositories actually hand the
 *     builder: every value bound as a parameter (never interpolated), every
 *     instant a plain number, the alias-qualified property names the builder
 *     escapes per driver, and `CASE`-based NULL ordering rather than each
 *     driver's own default.
 *
 * This file lives beside the migrations because that is where the task puts it;
 * it asserts on `packages/agent` sources, which is what the `@ever-works/agent`
 * modules the API wires actually run.
 */

const REPOSITORIES = [
    'app-build.repository.ts',
    'app-build-preparation.repository.ts',
    // APW-04 T7's repository, added by the coordinator on that slice's own recommendation: it carries
    // partial indexes and a lease/attempts compare-and-set of exactly the shape this file exists to
    // protect, and an entry here is what puts it under BOTH halves — the source scan that catches a
    // double-quoted fragment or an `interval '` literal SQLite would happily accept, and the recording
    // builder that proves every value is bound rather than interpolated.
    'work-app-provisioning.repository.ts',
] as const;

const repositoriesDir = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages',
    'agent',
    'src',
    'database',
    'repositories',
);

/** Read one repository's source with its comments removed — the code, not its prose. */
function repositoryCode(file: string): string {
    const source = readFileSync(join(repositoriesDir, file), 'utf8');
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Predicate {
    readonly text: string;
    readonly params?: Record<string, unknown>;
}

/**
 * A recording stand-in for TypeORM's query builder: it keeps every predicate,
 * parameter bag, ordering, `SET` patch and page bound it is handed, and answers
 * with canned rows. Deliberately not a mock of the SQL — the assertions below
 * read what the repository PASSED, which is the part that has to be portable.
 */
function queryHarness(options: { affected?: number; rows?: unknown[]; total?: number } = {}) {
    const predicates: Predicate[] = [];
    const selects: string[] = [];
    const orderBys: Array<{ expression: string; direction?: string }> = [];
    const sets: Array<Record<string, unknown>> = [];
    const updates: unknown[] = [];
    const takes: number[] = [];
    const skips: number[] = [];
    const builderCalls: boolean[] = [];
    const findOneCalls: unknown[] = [];
    const createCalls: unknown[] = [];
    const saveCalls: unknown[] = [];
    const mergeCalls: Array<{ row: unknown; patch: unknown }> = [];

    const record = (text: unknown, params?: Record<string, unknown>) => {
        if (typeof text === 'string') predicates.push({ text, params });
    };

    const query = {
        select(selection: string) {
            selects.push(selection);
            return query;
        },
        where(text: unknown, params?: Record<string, unknown>) {
            record(text, params);
            return query;
        },
        andWhere(text: unknown, params?: Record<string, unknown>) {
            record(text, params);
            return query;
        },
        orderBy(expression: string, direction?: string) {
            orderBys.push({ expression, direction });
            return query;
        },
        addOrderBy(expression: string, direction?: string) {
            orderBys.push({ expression, direction });
            return query;
        },
        take(value: number) {
            takes.push(value);
            return query;
        },
        skip(value: number) {
            skips.push(value);
            return query;
        },
        update(entity: unknown) {
            updates.push(entity);
            return query;
        },
        set(patch: Record<string, unknown>) {
            sets.push(patch);
            return query;
        },
        async execute() {
            return { affected: options.affected ?? 1, raw: [], generatedMaps: [] };
        },
        async getMany() {
            return options.rows ?? [];
        },
        async getOne() {
            return (options.rows ?? [])[0] ?? null;
        },
        async getManyAndCount() {
            return [options.rows ?? [], options.total ?? (options.rows ?? []).length];
        },
        async getRawOne() {
            return { highest: 0 };
        },
    };

    const repository = {
        createQueryBuilder: () => {
            builderCalls.push(true);
            return query;
        },
        findOne: async (options: unknown) => {
            findOneCalls.push(options);
            return null;
        },
        create: (data: unknown) => {
            createCalls.push(data);
            return data;
        },
        save: async (data: unknown) => {
            saveCalls.push(data);
            return { id: 'saved-1', ...(data as object) };
        },
        merge: (row: unknown, patch: unknown) => {
            mergeCalls.push({ row, patch });
            return Object.assign(row as object, patch);
        },
        manager: {
            connection: { options: { type: 'better-sqlite3' } },
            transaction: async (work: (manager: unknown) => Promise<unknown>) => work(undefined),
        },
    } as unknown as Repository<WorkBuild>;

    return {
        repository,
        /** The same recording double, seen through the preparation entity. */
        asPreparation: repository as unknown as Repository<WorkBuildPreparation>,
        predicates,
        selects,
        orderBys,
        sets,
        updates,
        takes,
        skips,
        builderCalls,
        findOneCalls,
        createCalls,
        saveCalls,
        mergeCalls,
    };
}

/** The parameter bag of the predicate whose text contains `fragment`. */
function paramsOf(predicates: readonly Predicate[], fragment: string): Record<string, unknown> {
    const match = predicates.find((predicate) => predicate.text.includes(fragment));
    if (!match) {
        throw new Error(
            `no predicate contained ${fragment}: ${predicates.map((p) => p.text).join(' | ')}`,
        );
    }
    return match.params ?? {};
}

describe('APW-05 repository query shape (the b5a7d6857 rule, APW05-G10)', () => {
    describe('the sources', () => {
        it.each(REPOSITORIES)('%s issues no raw statement', (file) => {
            const code = repositoryCode(file);

            expect(code).not.toMatch(/\.query\(/);
            expect(code).not.toContain('createQueryRunner');
            expect(code).not.toMatch(/\bINSERT INTO\b/i);
            expect(code).not.toMatch(/\bSELECT\b/);
            expect(code).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
        });

        it.each(REPOSITORIES)('%s contains no interval literal', (file) => {
            // `interval '90 seconds'` is a Postgres spelling; the whole point of
            // taking epoch milliseconds is that the window is arithmetic.
            expect(repositoryCode(file)).not.toMatch(/interval\s*'/i);
        });

        it.each(REPOSITORIES)('%s writes no double-quoted SQL fragment', (file) => {
            const code = repositoryCode(file);
            const fragments = [...code.matchAll(/'([^'\n]*)'/g)]
                .map((match) => match[1])
                .filter((fragment) => fragment.includes('"'));

            expect(fragments).toEqual([]);
        });

        it.each(REPOSITORIES)('%s contains no FOR UPDATE clause', (file) => {
            // plan §3.1:388 — PostgreSQL rejects `FOR UPDATE` beside the
            // aggregate that computes `MAX(number)`, and the row lock is taken on
            // the parent Work instead.
            expect(repositoryCode(file)).not.toMatch(/FOR\s+UPDATE/i);
        });

        it.each(REPOSITORIES)('%s declares no partial index predicate', (file) => {
            // The partial-index rule is a schema rule; it must not appear as a
            // query trick either.
            expect(repositoryCode(file)).not.toMatch(/indexPredicate/);
        });

        it('the lock lives in exactly one place, with the eager relations off', () => {
            const code = repositoryCode('app-build.repository.ts');

            expect(code).toContain("lock: { mode: 'pessimistic_write' }");
            expect(code).toContain('loadEagerRelations: false');
            // The lock is skipped on the SQLite family, where writes serialise
            // at the connection and the driver refuses the option outright.
            expect(code).toMatch(
                /driver === 'postgres' \|\| driver === 'mysql' \|\| driver === 'mariadb'/,
            );
        });
    });

    describe('claimWatchLease', () => {
        it('binds the deadline and the clock as parameters, and no identifier is quoted', async () => {
            const harness = queryHarness({ affected: 1 });
            const repository = new AppBuildRepository(harness.repository);

            const claimed = await repository.claimWatchLease('build-1', 120_000);

            expect(claimed).toBe(true);
            expect(harness.predicates[0].text).toBe('id = :id');
            expect(paramsOf(harness.predicates, 'id = :id')).toEqual({ id: 'build-1' });
            const lease = harness.predicates.find((predicate) =>
                predicate.text.includes('watchLeaseUntil'),
            );
            expect(lease?.text).toBe('(watchLeaseUntil IS NULL OR watchLeaseUntil < :now)');
            // A NUMBER, not a Date: a bound Date is refused by better-sqlite3
            // and would compare a bigint with a timestamptz on PostgreSQL.
            expect(typeof lease?.params?.now).toBe('number');
            // The deadline goes through the column transformer, so the driver
            // receives epoch milliseconds.
            const until = harness.sets[0].watchLeaseUntil as Date;
            expect(until).toBeInstanceOf(Date);
            expect(until.getTime()).toBeGreaterThan(Date.now());
            expect(harness.updates[0]).toBe(WorkBuild);
        });

        it('answers false when no row was claimed', async () => {
            const harness = queryHarness({ affected: 0 });
            const repository = new AppBuildRepository(harness.repository);

            await expect(repository.claimWatchLease('build-1', 120_000)).resolves.toBe(false);
        });
    });

    describe('findSilentNonTerminal', () => {
        it('binds the cutoff as a number and asks for the two open statuses', async () => {
            const harness = queryHarness({ rows: [] });
            const repository = new AppBuildRepository(harness.repository);

            await repository.findSilentNonTerminal(1_800_000_000_000, 90_000, 200);

            expect(paramsOf(harness.predicates, 'IN (:...statuses)')).toEqual({
                statuses: ['queued', 'running'],
            });
            const silence = harness.predicates.find((predicate) =>
                predicate.text.includes('lastObservedAt <'),
            );
            expect(silence?.text).toBe(
                '(build.lastObservedAt < :cutoff OR (build.lastObservedAt IS NULL AND build.dispatchedAt < :cutoff))',
            );
            expect(silence?.params?.cutoff).toBe(1_800_000_000_000 - 90_000);
            expect(typeof silence?.params?.cutoff).toBe('number');
        });

        it('orders NULL lastObservedAt first on every driver, through a CASE', async () => {
            const harness = queryHarness({ rows: [] });
            const repository = new AppBuildRepository(harness.repository);

            await repository.findSilentNonTerminal(1_800_000_000_000, 90_000, 200);

            // A bare `ORDER BY x ASC` puts NULLs LAST on PostgreSQL and FIRST on
            // SQLite/MySQL — the sweep would poll a different set of Builds per
            // driver.
            expect(harness.orderBys[0]).toEqual({
                expression: 'CASE WHEN build.lastObservedAt IS NULL THEN 0 ELSE 1 END',
                direction: 'ASC',
            });
            expect(harness.orderBys[1]).toEqual({
                expression: 'build.lastObservedAt',
                direction: 'ASC',
            });
        });

        it('takes the batch it was given, and clamps it to the sweep batch', async () => {
            const generous = queryHarness({ rows: [] });
            await new AppBuildRepository(generous.repository).findSilentNonTerminal(
                1_800_000_000_000,
                90_000,
                100_000,
            );
            expect(generous.takes).toEqual([APP_BUILD_SWEEP_BATCH]);

            const exact = queryHarness({ rows: [] });
            await new AppBuildRepository(exact.repository).findSilentNonTerminal(
                1_800_000_000_000,
                90_000,
                25,
            );
            expect(exact.takes).toEqual([25]);
        });

        it('issues no query at all for a non-positive limit', async () => {
            const harness = queryHarness({ rows: [] });
            const repository = new AppBuildRepository(harness.repository);

            expect(await repository.findSilentNonTerminal(1_800_000_000_000, 90_000, 0)).toEqual(
                [],
            );
            expect(harness.predicates).toEqual([]);
        });
    });

    describe('findWithOrphanedVerifySecrets', () => {
        it('binds the 30 + 10 minute cutoff as a number and the empty list as a parameter', async () => {
            const harness = queryHarness({ rows: [] });
            const repository = new AppBuildRepository(harness.repository);

            await repository.findWithOrphanedVerifySecrets(1_800_000_000_000, 200);

            const cutoff = harness.predicates.find((predicate) =>
                predicate.text.includes('startedAt <= '),
            );
            expect(cutoff?.params?.cutoff).toBe(
                1_800_000_000_000 - APP_BUILD_ORPHANED_VERIFY_SECRET_MS,
            );
            expect(APP_BUILD_ORPHANED_VERIFY_SECRET_MS).toBe(2_400_000);
            expect(paramsOf(harness.predicates, 'trigger = :verification')).toEqual({
                verification: 'verification',
            });
            expect(paramsOf(harness.predicates, '<> :emptyList')).toEqual({ emptyList: '[]' });
            expect(harness.takes).toEqual([200]);
        });

        it('requires a start stamp and a non-empty name list', async () => {
            const harness = queryHarness({ rows: [] });
            const repository = new AppBuildRepository(harness.repository);

            await repository.findWithOrphanedVerifySecrets(1_800_000_000_000, 200);

            const texts = harness.predicates.map((predicate) => predicate.text);
            expect(texts).toContain('build.startedAt IS NOT NULL');
            expect(texts).toContain('build.verifySecretNames IS NOT NULL');
            expect(texts).toContain('build.verifySecretNames <> :emptyList');
        });
    });

    describe('markLost', () => {
        it('fails only the rows still open, with a bound id list', async () => {
            const harness = queryHarness({ affected: 2 });
            const repository = new AppBuildRepository(harness.repository);
            const completedAt = new Date('2026-03-01T06:00:00.000Z');

            const affected = await repository.markLost(['b1', 'b2'], completedAt);

            expect(affected).toBe(2);
            expect(paramsOf(harness.predicates, 'IN (:...ids)')).toEqual({ ids: ['b1', 'b2'] });
            expect(paramsOf(harness.predicates, 'IN (:...statuses)')).toEqual({
                statuses: ['queued', 'running'],
            });
            expect(harness.sets[0]).toEqual({
                status: 'failed',
                failureClass: 'lost',
                completedAt,
            });
        });

        it('issues no query at all for an empty id list', async () => {
            const harness = queryHarness({ affected: 0 });
            const repository = new AppBuildRepository(harness.repository);

            expect(await repository.markLost([])).toBe(0);
            expect(harness.predicates).toEqual([]);
        });
    });

    /**
     * The sweep's never-adopted write: the same UPDATE as `markLost`, plus the two
     * predicates the read saw — no run id, and the very `dispatchedAt` it read, bound
     * as a NUMBER (the `bigint` epoch column), or `IS NULL` when it read none.
     */
    describe('markNeverAdoptedLost', () => {
        it('re-checks the read dispatch stamp as a bound number, beside the open statuses', async () => {
            const harness = queryHarness({ affected: 1 });
            const repository = new AppBuildRepository(harness.repository);
            const completedAt = new Date('2026-03-01T06:00:00.000Z');
            const readDispatchedAt = Date.parse('2026-03-01T04:00:00.000Z');

            expect(await repository.markNeverAdoptedLost('b1', readDispatchedAt, completedAt)).toBe(
                true,
            );

            expect(paramsOf(harness.predicates, 'id = :id')).toEqual({ id: 'b1' });
            expect(paramsOf(harness.predicates, 'IN (:...statuses)')).toEqual({
                statuses: ['queued', 'running'],
            });
            expect(harness.predicates.map((predicate) => predicate.text)).toContain(
                'providerRunId IS NULL',
            );
            const stamp = paramsOf(harness.predicates, 'dispatchedAt = :readDispatchedAt');
            expect(stamp).toEqual({ readDispatchedAt });
            expect(typeof stamp.readDispatchedAt).toBe('number');
            expect(harness.sets[0]).toEqual({
                status: 'failed',
                failureClass: 'lost',
                completedAt,
            });
        });

        it('asks for dispatchedAt IS NULL when the read saw no stamp, and answers false for no row', async () => {
            const harness = queryHarness({ affected: 0 });
            const repository = new AppBuildRepository(harness.repository);

            expect(await repository.markNeverAdoptedLost('b1', null)).toBe(false);

            const texts = harness.predicates.map((predicate) => predicate.text);
            expect(texts).toContain('dispatchedAt IS NULL');
            expect(texts.some((text) => text.includes(':readDispatchedAt'))).toBe(false);
        });
    });

    /**
     * APW-05 T21 (first slice) — the sweep's two new reads. Same rule as every
     * read above: alias-qualified property names the builder escapes per driver,
     * every value a parameter, every instant a plain NUMBER (the `bigint` epoch
     * columns), and a deterministic order with the id as the tie-break.
     */
    describe('findUndispatchedRequested', () => {
        it('binds the status, the triggers and both window edges as parameters', async () => {
            const harness = queryHarness({ rows: [] });
            const repository = new AppBuildRepository(harness.repository);

            await repository.findUndispatchedRequested(1_800_000_000_000, 90_000, 450_000, 200);

            const texts = harness.predicates.map((predicate) => predicate.text);
            expect(texts).toEqual([
                'build.status = :queued',
                'build.trigger IN (:...triggers)',
                'build.dispatchedAt IS NULL',
                'build.queuedAt <= :newest',
                'build.queuedAt > :oldest',
            ]);
            expect(paramsOf(harness.predicates, 'status = :queued')).toEqual({ queued: 'queued' });
            expect(paramsOf(harness.predicates, 'IN (:...triggers)')).toEqual({
                triggers: ['manual', 'verification'],
            });
            const newest = paramsOf(harness.predicates, '<= :newest').newest;
            const oldest = paramsOf(harness.predicates, '> :oldest').oldest;
            expect(newest).toBe(1_800_000_000_000 - 90_000);
            expect(oldest).toBe(1_800_000_000_000 - 450_000);
            expect(typeof newest).toBe('number');
            expect(typeof oldest).toBe('number');
            expect(harness.orderBys).toEqual([
                { expression: 'build.queuedAt', direction: 'ASC' },
                { expression: 'build.id', direction: 'ASC' },
            ]);
            expect(harness.takes).toEqual([200]);
        });

        it('clamps the batch and issues no query for a non-positive limit', async () => {
            const generous = queryHarness({ rows: [] });
            await new AppBuildRepository(generous.repository).findUndispatchedRequested(
                1_800_000_000_000,
                90_000,
                450_000,
                100_000,
            );
            expect(generous.takes).toEqual([APP_BUILD_SWEEP_BATCH]);

            const none = queryHarness({ rows: [] });
            expect(
                await new AppBuildRepository(none.repository).findUndispatchedRequested(
                    1_800_000_000_000,
                    90_000,
                    450_000,
                    0,
                ),
            ).toEqual([]);
            expect(none.builderCalls).toEqual([]);
        });
    });

    describe('findNeverAdoptedQueuedBefore', () => {
        it('binds the open statuses, the triggers and the cutoff as a number', async () => {
            const harness = queryHarness({ rows: [] });
            const repository = new AppBuildRepository(harness.repository);

            await repository.findNeverAdoptedQueuedBefore(1_800_000_000_000 - 2_400_000, 200);

            expect(harness.predicates.map((predicate) => predicate.text)).toEqual([
                'build.status IN (:...statuses)',
                'build.providerRunId IS NULL',
                'build.trigger IN (:...triggers)',
                'build.queuedAt < :cutoff',
            ]);
            expect(paramsOf(harness.predicates, 'IN (:...statuses)')).toEqual({
                statuses: ['queued', 'running'],
            });
            expect(paramsOf(harness.predicates, 'IN (:...triggers)')).toEqual({
                triggers: ['manual', 'verification'],
            });
            const cutoff = paramsOf(harness.predicates, '< :cutoff').cutoff;
            expect(cutoff).toBe(1_800_000_000_000 - 2_400_000);
            expect(typeof cutoff).toBe('number');
            expect(harness.orderBys).toEqual([
                { expression: 'build.queuedAt', direction: 'ASC' },
                { expression: 'build.id', direction: 'ASC' },
            ]);
            expect(harness.takes).toEqual([200]);
        });

        it('issues no query at all for a non-positive limit', async () => {
            const harness = queryHarness({ rows: [] });
            const repository = new AppBuildRepository(harness.repository);

            expect(await repository.findNeverAdoptedQueuedBefore(1_800_000_000_000, 0)).toEqual([]);
            expect(harness.builderCalls).toEqual([]);
        });
    });

    describe('findPage', () => {
        it('binds the filters, orders newest first and offsets by whole pages', async () => {
            const harness = queryHarness({ rows: [], total: 61 });
            const repository = new AppBuildRepository(harness.repository);

            const page = await repository.findPage(
                'work-1',
                { status: ['failed'], trigger: ['push'], branch: 'main', pullRequestNumber: 3 },
                3,
                20,
            );

            expect(paramsOf(harness.predicates, 'build.workId = :workId')).toEqual({
                workId: 'work-1',
            });
            expect(paramsOf(harness.predicates, 'IN (:...statuses)')).toEqual({
                statuses: ['failed'],
            });
            expect(paramsOf(harness.predicates, 'IN (:...triggers)')).toEqual({
                triggers: ['push'],
            });
            expect(paramsOf(harness.predicates, 'build.branch = :branch')).toEqual({
                branch: 'main',
            });
            expect(paramsOf(harness.predicates, 'pullRequestNumber = :pullRequestNumber')).toEqual({
                pullRequestNumber: 3,
            });
            expect(harness.orderBys[0]).toEqual({
                expression: 'build.createdAt',
                direction: 'DESC',
            });
            expect(harness.skips).toEqual([40]);
            expect(harness.takes).toEqual([20]);
            expect(page).toEqual({ rows: [], total: 61, page: 3, pageSize: 20, hasMore: true });
        });

        it('adds no predicate for a filter the caller did not ask for', async () => {
            const harness = queryHarness({ rows: [], total: 0 });
            const repository = new AppBuildRepository(harness.repository);

            await repository.findPage('work-1');

            expect(harness.predicates).toHaveLength(1);
            expect(harness.predicates[0].text).toBe('build.workId = :workId');
        });
    });

    describe('the preparation repository', () => {
        it('reads by a parameterised workId and writes through the ORM, never through SQL', async () => {
            const harness = queryHarness({ rows: [] });
            const repository = new AppBuildPreparationRepository(harness.asPreparation);

            await repository.findByWork('work-1');

            expect(harness.findOneCalls).toEqual([{ where: { workId: 'work-1' } }]);
            // The row's identity travels as a COLUMN VALUE, never concatenated
            // into a statement — so `APW05-G10` is structural here rather than a
            // convention this file has to keep.
            expect(harness.builderCalls).toEqual([]);
        });

        it('creates with the workId as a value and the patch as column values', async () => {
            const harness = queryHarness({ rows: [] });
            const repository = new AppBuildPreparationRepository(harness.asPreparation);

            await repository.upsertAfterPrepare('work-1', {
                buildPluginId: 'github-actions',
                runsEtag: 'W/"abc"',
            });

            expect(harness.builderCalls).toEqual([]);
            expect(harness.createCalls).toEqual([
                { workId: 'work-1', buildPluginId: 'github-actions', runsEtag: 'W/"abc"' },
            ]);
            expect(harness.saveCalls).toHaveLength(1);
        });

        it('merges into the row it found rather than building an UPDATE statement', async () => {
            const existing = { id: 'prep-1', workId: 'work-1', prepareSeq: 7 };
            const harness = queryHarness({ rows: [] });
            harness.repository.findOne = (async () => existing) as never;
            const repository = new AppBuildPreparationRepository(harness.asPreparation);

            const merged = await repository.upsertAfterPrepare('work-1', {
                webhookState: 'installed',
            });

            expect(harness.builderCalls).toEqual([]);
            expect(harness.mergeCalls).toEqual([
                { row: existing, patch: { webhookState: 'installed' } },
            ]);
            // `prepareSeq` is requestPrepare's column and is never part of a patch.
            expect(merged).not.toBeNull();
            expect((existing as { prepareSeq: number }).prepareSeq).toBe(7);
        });
    });
});
