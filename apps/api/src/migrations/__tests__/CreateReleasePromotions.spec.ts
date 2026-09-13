import { DataSource } from 'typeorm';
import { CreateReleasePromotions1790000000000 } from '../1790000000000-CreateReleasePromotions';

/**
 * Release promotion lane (self-build slice AI, EW-808) — migration test for
 * `release_promotions` + `works.releaseLadder`, run against an in-memory
 * better-sqlite3 DataSource (same harness as
 * `CreateExternalIssueLinks.spec.ts`).
 *
 * The load-bearing assertion is the UNIQUE `(workId, rung, laneKey)` index,
 * exercised the way the service uses it rather than by reading its
 * definition: two OPEN promotions for the same (Work, rung) must collide,
 * and everything else must not. That constraint is the whole anti-duplicate
 * guarantee — without it two merges to `develop` seconds apart open two
 * competing promotion pull requests.
 *
 * Schema shape is asserted against the PHYSICAL table (`PRAGMA table_info`),
 * never by watching an INSERT fail: a column that silently does not exist
 * makes an INSERT fail for the wrong reason.
 *
 * The inserts pass `createdAt`/`updatedAt` explicitly: the table's `now()` /
 * `uuid_generate_v4()` defaults are Postgres functions (the shape every
 * migration in this folder ships), and sqlite is used here only as a cheap
 * DDL harness.
 */
describe('CreateReleasePromotions1790000000000', () => {
    let dataSource: DataSource;
    const migration = new CreateReleasePromotions1790000000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u-a'), ('u-b')`);
        await dataSource.query(
            `CREATE TABLE "works" ("id" varchar PRIMARY KEY NOT NULL, "slug" varchar)`,
        );
        await dataSource.query(
            `INSERT INTO "works" ("id", "slug") VALUES ('w-1', 'one'), ('w-2', 'two')`,
        );
        await dataSource.query(`CREATE TABLE "tasks" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "tasks" ("id") VALUES ('t-1'), ('t-2')`);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

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

    const COLUMNS =
        '"id", "userId", "workId", "taskId", "rung", "headBranch", "baseBranch", "state", "laneKey", "gateWorkflow", "createdAt", "updatedAt"';
    const STAMPS = `'2026-09-06 00:00:00', '2026-09-06 00:00:00'`;

    function insert(
        id: string,
        opts: {
            workId?: string;
            rung?: string;
            laneKey?: string;
            state?: string;
            taskId?: string | null;
        } = {},
    ): Promise<unknown> {
        const workId = opts.workId ?? 'w-1';
        const rung = opts.rung ?? 'develop-to-stage';
        const state = opts.state ?? 'open';
        const laneKey = opts.laneKey ?? 'open';
        const taskId =
            opts.taskId === undefined ? `'t-1'` : opts.taskId ? `'${opts.taskId}'` : 'NULL';
        return dataSource.query(
            `INSERT INTO "release_promotions" (${COLUMNS}) VALUES ('${id}', 'u-a', '${workId}', ${taskId}, '${rung}', 'develop', 'stage', '${state}', '${laneKey}', 'promotion-gate.yml', ${STAMPS})`,
        );
    }

    it('creates the table with the lane, pull-request and gate columns', async () => {
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
                'headRecordedAt',
                'prNumber',
                'prUrl',
                'state',
                'laneKey',
                'gateWorkflow',
                'gateVerdict',
                'gateVerdictSha',
                'gateOverridden',
                'gateCheckedAt',
                'gateRunUrl',
                'refusalCode',
                'inboxFiledForSha',
                'inboxFiledVerdict',
                'tenantId',
                'organizationId',
                'createdAt',
                'updatedAt',
            ]),
        );
    });

    it('adds works.releaseLadder as a nullable column', async () => {
        await up();
        expect(await columnNames('works')).toContain('releaseLadder');
        const rows: Array<{ name: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("works")`,
        );
        const ladder = rows.find((row) => row.name === 'releaseLadder');
        // Nullable, because every existing Work legitimately has no
        // release lane and must not be given a guessed one.
        expect(ladder?.notnull).toBe(0);
    });

    it('leaves existing Works with a NULL ladder — no lane is the correct history', async () => {
        await up();
        const rows: Array<{ releaseLadder: string | null }> = await dataSource.query(
            `SELECT "releaseLadder" FROM "works" WHERE "id" = 'w-1'`,
        );
        expect(rows[0].releaseLadder).toBeNull();
    });

    it('refuses a SECOND open promotion for the same Work and rung', async () => {
        await up();
        await insert('p-1');
        // THE constraint. Two merges to develop seconds apart both try to
        // claim (w-1, develop-to-stage, 'open'); exactly one survives.
        await expect(insert('p-2')).rejects.toThrow(/UNIQUE/i);
    });

    it('allows an open promotion on each rung of the same Work', async () => {
        await up();
        await insert('p-1', { rung: 'develop-to-stage' });
        await expect(
            insert('p-2', { rung: 'stage-to-main', taskId: 't-2' }),
        ).resolves.toBeDefined();
    });

    it('allows an open promotion on the same rung of a DIFFERENT Work', async () => {
        await up();
        await insert('p-1', { workId: 'w-1' });
        await expect(insert('p-2', { workId: 'w-2', taskId: 't-2' })).resolves.toBeDefined();
    });

    it('frees the lane once the previous promotion goes terminal', async () => {
        await up();
        await insert('p-1');
        // What `promotionLaneKey('merged', id)` writes.
        await dataSource.query(
            `UPDATE "release_promotions" SET "state" = 'merged', "laneKey" = 'merged:p-1' WHERE "id" = 'p-1'`,
        );
        await expect(insert('p-2', { taskId: 't-2' })).resolves.toBeDefined();
    });

    it('allows many terminal promotions for one lane', async () => {
        await up();
        await insert('p-1', { state: 'merged', laneKey: 'merged:p-1' });
        await insert('p-2', { state: 'merged', laneKey: 'merged:p-2', taskId: 't-2' });
        await insert('p-3', { state: 'refused', laneKey: 'refused:p-3', taskId: null });
        const rows: Array<{ n: number }> = await dataSource.query(
            `SELECT COUNT(*) AS n FROM "release_promotions"`,
        );
        expect(Number(rows[0].n)).toBe(3);
    });

    it('is idempotent — a second up() over an applied schema is a no-op', async () => {
        await up();
        await insert('p-1');
        await up();
        const rows: Array<{ n: number }> = await dataSource.query(
            `SELECT COUNT(*) AS n FROM "release_promotions"`,
        );
        expect(Number(rows[0].n)).toBe(1);
        expect(await columnNames('works')).toContain('releaseLadder');
    });

    it('down() drops the table and the works column via the query runner', async () => {
        await up();
        await down();
        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'release_promotions'`,
        );
        expect(tables).toEqual([]);
        // Physical schema, not a failing INSERT: `dropColumn` rebuilds the
        // table on this driver, and a rebuild that silently kept the column
        // would still pass an INSERT-based check.
        expect(await columnNames('works')).not.toContain('releaseLadder');
        // The rest of `works` survived the rebuild.
        expect(await columnNames('works')).toEqual(expect.arrayContaining(['id', 'slug']));
    });

    it('down() is safe on a database where up() never ran', async () => {
        await expect(down()).resolves.toBeUndefined();
    });
});
