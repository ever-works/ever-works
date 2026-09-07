import { DataSource } from 'typeorm';
import { CreateReleasePromotions1790000000000 } from '../1790000000000-CreateReleasePromotions';
import { AddReleaseVerification1790100000000 } from '../1790100000000-AddReleaseVerification';

/**
 * Post-deploy verification and revert (self-build slice AJ, EW-809) —
 * migration test for the `verify*` / `revert*` columns on
 * `release_promotions` and `works.releaseVerification`, against an
 * in-memory better-sqlite3 DataSource (the same harness
 * `CreateReleasePromotions.spec.ts` uses).
 *
 * Slice AI's migration is run FIRST, because this one is an ALTER and
 * asserting it in isolation would prove nothing about the table it has to
 * land on.
 *
 * Schema shape is asserted against the PHYSICAL table (`PRAGMA
 * table_info`), never by watching an INSERT fail: a column that silently
 * does not exist makes an INSERT fail for the wrong reason, and this
 * migration's whole job is thirteen columns existing.
 *
 * The inserts pass `createdAt`/`updatedAt` explicitly: the table's `now()`
 * / `uuid_generate_v4()` defaults are Postgres functions (the shape every
 * migration in this folder ships), and sqlite is used here only as a cheap
 * DDL harness.
 */
describe('AddReleaseVerification1790100000000', () => {
    let dataSource: DataSource;
    const base = new CreateReleasePromotions1790000000000();
    const migration = new AddReleaseVerification1790100000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u-a')`);
        await dataSource.query(
            `CREATE TABLE "works" ("id" varchar PRIMARY KEY NOT NULL, "slug" varchar)`,
        );
        await dataSource.query(`INSERT INTO "works" ("id", "slug") VALUES ('w-1', 'one')`);
        await dataSource.query(`CREATE TABLE "tasks" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "tasks" ("id") VALUES ('t-1'), ('t-2')`);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    async function runBase(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await base.up(runner);
        await runner.release();
    }

    async function up(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    async function down(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
    }

    async function columnNames(table: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return rows.map((r) => r.name);
    }

    async function columnInfo(
        table: string,
        column: string,
    ): Promise<{ name: string; notnull: number; dflt_value: string | null } | undefined> {
        const rows: Array<{ name: string; notnull: number; dflt_value: string | null }> =
            await dataSource.query(`PRAGMA table_info("${table}")`);
        return rows.find((r) => r.name === column);
    }

    async function indexNames(table: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("${table}")`,
        );
        return rows.map((r) => r.name);
    }

    const COLUMNS =
        '"id", "userId", "workId", "taskId", "rung", "headBranch", "baseBranch", "state", "laneKey", "gateWorkflow", "createdAt", "updatedAt"';
    const STAMPS = `'2026-09-06 00:00:00', '2026-09-06 00:00:00'`;

    function insert(id: string, laneKey = 'open'): Promise<unknown> {
        return dataSource.query(
            `INSERT INTO "release_promotions" (${COLUMNS}) VALUES ('${id}', 'u-a', 'w-1', 't-1', 'stage-to-main', 'stage', 'main', 'open', '${laneKey}', 'promotion-gate.yml', ${STAMPS})`,
        );
    }

    const VERIFY_COLUMNS = [
        'verifyState',
        'verifyExpectedSha',
        'verifyTargetUrl',
        'verifyStartedAt',
        'verifyDeadlineAt',
        'verifyAttempts',
        'verifyStreak',
        'verifyJobId',
        'verifyRetryAt',
        'verifyCheckedAt',
        'verifyDetail',
        'revertTaskId',
        'revertOfferedAt',
    ];

    describe('up', () => {
        it('adds every verification and revert column to release_promotions', async () => {
            await runBase();
            await up();
            expect(await columnNames('release_promotions')).toEqual(
                expect.arrayContaining(VERIFY_COLUMNS),
            );
        });

        it('adds releaseVerification to works', async () => {
            await runBase();
            await up();
            expect(await columnNames('works')).toContain('releaseVerification');
        });

        it('leaves the slice AI columns alone', async () => {
            // An ALTER that rebuilds a table on sqlite is exactly where a
            // column quietly disappears.
            await runBase();
            await up();
            expect(await columnNames('release_promotions')).toEqual(
                expect.arrayContaining([
                    'id',
                    'userId',
                    'workId',
                    'taskId',
                    'rung',
                    'headBranch',
                    'baseBranch',
                    'headSha',
                    'state',
                    'laneKey',
                    'gateWorkflow',
                    'gateVerdict',
                    'gateVerdictSha',
                    'gateOverridden',
                    'inboxFiledForSha',
                    'inboxFiledVerdict',
                ]),
            );
        });

        it('keeps the UNIQUE lane index working after the rebuild', async () => {
            // THE anti-duplicate guarantee from slice AI. A table rebuild
            // that dropped it would leave two competing promotion pull
            // requests possible, and nothing else in this suite would notice.
            await runBase();
            await up();
            expect(await indexNames('release_promotions')).toContain('uq_release_promotions_lane');
            await insert('p-1');
            await expect(insert('p-2')).rejects.toThrow();
        });

        it('creates the sweep index the verification cron reads', async () => {
            await runBase();
            await up();
            expect(await indexNames('release_promotions')).toContain(
                'idx_release_promotions_verify',
            );
        });

        it('defaults the two bound counters to 0 rather than NULL', async () => {
            // `verifyAttempts` is one of the two independent stops that keep
            // the lane bounded. A NULL there would make
            // `isReleaseVerifyExhausted` count from zero on every pass on a
            // row that had already used its budget.
            await runBase();
            await up();
            await insert('p-1');
            const rows: Array<{ verifyAttempts: number; verifyStreak: number; verifyState: null }> =
                await dataSource.query(
                    `SELECT "verifyAttempts", "verifyStreak", "verifyState" FROM "release_promotions" WHERE "id" = 'p-1'`,
                );
            expect(rows[0].verifyAttempts).toBe(0);
            expect(rows[0].verifyStreak).toBe(0);
            // NULL, not a state: an existing promotion has not been verified
            // and must not read as one that has.
            expect(rows[0].verifyState).toBeNull();
        });

        it('leaves every verification column nullable, so history backfills honestly', async () => {
            await runBase();
            await up();
            for (const name of VERIFY_COLUMNS.filter(
                (c) => c !== 'verifyAttempts' && c !== 'verifyStreak',
            )) {
                const info = await columnInfo('release_promotions', name);
                expect(info).toBeDefined();
                expect(info!.notnull).toBe(0);
            }
        });

        it('is idempotent — running it twice adds nothing and throws nothing', async () => {
            await runBase();
            await up();
            const first = await columnNames('release_promotions');
            await up();
            expect(await columnNames('release_promotions')).toEqual(first);
        });

        it('does nothing rather than throwing when the promotions table is absent', async () => {
            // TypeORM runs migrations in timestamp order so this cannot
            // happen on a normal boot, but a hand-rolled database must not
            // crash-loop the API.
            await expect(up()).resolves.toBeUndefined();
            expect(await columnNames('works')).toContain('releaseVerification');
        });
    });

    describe('down', () => {
        it('removes every column it added, from both tables', async () => {
            await runBase();
            await up();
            await down();
            const promotionColumns = await columnNames('release_promotions');
            for (const name of VERIFY_COLUMNS) {
                expect(promotionColumns).not.toContain(name);
            }
            expect(await columnNames('works')).not.toContain('releaseVerification');
        });

        it('leaves the slice AI table intact and still constrained', async () => {
            await runBase();
            await up();
            await down();
            expect(await columnNames('release_promotions')).toEqual(
                expect.arrayContaining([
                    'id',
                    'userId',
                    'workId',
                    'rung',
                    'laneKey',
                    'gateVerdict',
                ]),
            );
            expect(await indexNames('release_promotions')).toContain('uq_release_promotions_lane');
            await insert('p-1');
            await expect(insert('p-2')).rejects.toThrow();
        });

        it('survives being run without a preceding up', async () => {
            await runBase();
            await expect(down()).resolves.toBeUndefined();
        });

        it('round-trips — up, down, up again', async () => {
            await runBase();
            await up();
            await down();
            await up();
            expect(await columnNames('release_promotions')).toEqual(
                expect.arrayContaining(VERIFY_COLUMNS),
            );
            expect(await indexNames('release_promotions')).toContain(
                'idx_release_promotions_verify',
            );
        });
    });

    describe('what the schema deliberately does NOT have', () => {
        it('has no column that could record production having been reverted', async () => {
            // THE load-bearing absence. This platform does not revert
            // production: it files a Task offering one and stops. A
            // `revertedAt` / `revertPrNumber` / `revertMergedAt` column
            // would be the first sign somebody had built the thing this
            // slice refuses to build, so adding one fails here and the
            // author has to argue for it.
            await runBase();
            await up();
            const columns = await columnNames('release_promotions');
            expect(columns.filter((name) => /^revert/i.test(name)).sort()).toEqual([
                'revertOfferedAt',
                'revertTaskId',
            ]);
        });
    });
});
