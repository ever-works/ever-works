import { DataSource } from 'typeorm';
import { AddGoalKind1788700000000 } from '../1788700000000-AddGoalKind';

/**
 * Migration test for the `goals.goalKind` discriminator + nullable metric
 * columns (self-build slice AG, EW-795).
 *
 * Runs on the same in-memory better-sqlite3 harness as its siblings, and
 * for the same reason: production is Postgres while CI and the e2e stack
 * are sqlite, so DDL that only works on one of them would pass in prod
 * and fail every CI run — or the reverse.
 *
 * What is pinned here beyond "the column exists":
 *  - EXISTING rows read `goalKind = 'metric'` after up() with no UPDATE
 *    pass, and a row inserted afterwards without the column defaults to it.
 *  - After up() a delivery row with NULL metricSource/comparator/targetValue/unit
 *    inserts cleanly — and the SAME insert throws NOT NULL before up().
 *  - The relax step (a table recreate on sqlite) keeps the other columns AND
 *    the indexes it was not asked to touch.
 *  - down() is symmetric: NOT NULL is back on all four, `goalKind` is gone,
 *    the metric row survives and the delivery row does not.
 */
describe('AddGoalKind1788700000000', () => {
    let dataSource: DataSource;
    const migration = new AddGoalKind1788700000000();

    const METRIC_COLUMNS = ['metricSource', 'comparator', 'targetValue', 'unit'];

    /** A minimal stand-in for the pre-existing `goals` table (+ one of its indexes). */
    const createGoalsTable = async () => {
        await dataSource.query(`
            CREATE TABLE "goals" (
                "id" varchar PRIMARY KEY,
                "userId" varchar NOT NULL,
                "title" varchar NOT NULL,
                "metricSource" text NOT NULL,
                "comparator" varchar NOT NULL,
                "targetValue" float NOT NULL,
                "unit" varchar NOT NULL,
                "window" varchar NOT NULL,
                "checkFrequencyMinutes" integer NOT NULL DEFAULT 60,
                "status" varchar NOT NULL DEFAULT 'draft',
                "dodCriteria" text
            )
        `);
        await dataSource.query(
            `CREATE INDEX "idx_goals_user_status" ON "goals" ("userId", "status")`,
        );
    };

    const insertMetricRow = (id: string) =>
        dataSource.query(
            `INSERT INTO "goals" ("id","userId","title","metricSource","comparator","targetValue","unit","window","status")
             VALUES ('${id}','u1','Legacy metric goal','{"pluginId":"stripe","metricId":"income"}','gte',1000,'usd','month','active')`,
        );

    const insertDeliveryRow = (id: string) =>
        dataSource.query(
            `INSERT INTO "goals" ("id","userId","title","metricSource","comparator","targetValue","unit","window","status","goalKind","dodCriteria")
             VALUES ('${id}','u1','Ship feature X',NULL,NULL,NULL,NULL,'total','draft','delivery','[{"id":"a","text":"ship","status":"open"}]')`,
        );

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds goalKind and relaxes NOT NULL on the four metric columns', async () => {
        await createGoalsTable();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('goals');
        expect(table?.findColumnByName('goalKind')).toBeDefined();
        for (const name of METRIC_COLUMNS) {
            expect(table?.findColumnByName(name)?.isNullable).toBe(true);
        }
        // `window` is not one of the four — a delivery Goal still stores 'total'.
        expect(table?.findColumnByName('window')?.isNullable).toBe(false);

        await runner.release();
    });

    it("backfills every EXISTING row to goalKind = 'metric' and defaults new rows to it", async () => {
        await createGoalsTable();
        await insertMetricRow('g-existing');

        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        // Inserted AFTER up() without naming the column at all.
        await insertMetricRow('g-new');

        const rows = await dataSource.query(
            `SELECT "id","goalKind","targetValue","unit" FROM "goals" ORDER BY "id"`,
        );
        expect(rows).toEqual([
            { id: 'g-existing', goalKind: 'metric', targetValue: 1000, unit: 'usd' },
            { id: 'g-new', goalKind: 'metric', targetValue: 1000, unit: 'usd' },
        ]);

        await runner.release();
    });

    it('lets a delivery row insert with NULL metric fields only AFTER up()', async () => {
        await createGoalsTable();
        // Control: the pre-migration table refuses the delivery shape, which
        // is exactly the defect this migration removes.
        await expect(
            dataSource.query(
                `INSERT INTO "goals" ("id","userId","title","metricSource","comparator","targetValue","unit","window","status")
                 VALUES ('g-before','u1','x',NULL,NULL,NULL,NULL,'total','draft')`,
            ),
        ).rejects.toThrow(/NOT NULL/i);

        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await expect(insertDeliveryRow('g-delivery')).resolves.not.toThrow();
        const rows = await dataSource.query(
            `SELECT "goalKind","metricSource","comparator","targetValue","unit","window" FROM "goals" WHERE "id" = 'g-delivery'`,
        );
        expect(rows[0]).toEqual({
            goalKind: 'delivery',
            metricSource: null,
            comparator: null,
            targetValue: null,
            unit: null,
            window: 'total',
        });

        await runner.release();
    });

    it('keeps the other columns and the existing indexes through the relax step', async () => {
        await createGoalsTable();
        await insertMetricRow('g1');
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('goals');
        for (const name of ['status', 'window', 'checkFrequencyMinutes', 'dodCriteria']) {
            expect(table?.findColumnByName(name)).toBeDefined();
        }
        expect((table?.indices ?? []).map((index) => index.name)).toEqual(
            expect.arrayContaining(['idx_goals_user_status']),
        );
        // The pre-existing row's data survived the recreate.
        const rows = await dataSource.query(
            `SELECT "metricSource","status" FROM "goals" WHERE "id" = 'g1'`,
        );
        expect(rows[0]).toEqual({
            metricSource: '{"pluginId":"stripe","metricId":"income"}',
            status: 'active',
        });

        await runner.release();
    });

    it('is idempotent — a second up() does not throw and changes nothing', async () => {
        await createGoalsTable();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();

        const table = await runner.getTable('goals');
        expect(table?.findColumnByName('goalKind')).toBeDefined();
        for (const name of METRIC_COLUMNS) {
            expect(table?.findColumnByName(name)?.isNullable).toBe(true);
        }
        await runner.release();
    });

    it('no-ops when the goals table does not exist yet', async () => {
        const runner = dataSource.createQueryRunner();
        await expect(migration.up(runner)).resolves.not.toThrow();
        await expect(migration.down(runner)).resolves.not.toThrow();
        await runner.release();
    });

    it('down() drops goalKind, restores NOT NULL, keeps metric rows and removes delivery rows', async () => {
        await createGoalsTable();
        await insertMetricRow('g-metric');
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await insertDeliveryRow('g-delivery');

        await migration.down(runner);

        const table = await runner.getTable('goals');
        expect(table?.findColumnByName('goalKind')).toBeUndefined();
        for (const name of METRIC_COLUMNS) {
            expect(table?.findColumnByName(name)?.isNullable).toBe(false);
        }
        const rows = await dataSource.query(`SELECT "id" FROM "goals" ORDER BY "id"`);
        expect(rows).toEqual([{ id: 'g-metric' }]);

        // The column is gone from the PHYSICAL schema, not merely from the
        // query runner's cached table metadata (which is what
        // `findColumnByName` reads and can lag a sqlite table recreate).
        const columns: Array<{ name: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("goals")`,
        );
        expect(columns.map((c) => c.name)).not.toContain('goalKind');
        for (const name of METRIC_COLUMNS) {
            expect(columns.find((c) => c.name === name)?.notnull).toBe(1);
        }

        // And the NOT NULL really is back: the delivery SHAPE — NULL in all
        // four metric columns — is refused again. Asserted WITHOUT naming
        // `goalKind`, so a passing test can only mean the constraint was
        // restored; the previous form named the dropped column and would
        // also have passed on "no such column".
        await expect(
            dataSource.query(
                `INSERT INTO "goals" ("id","userId","title","metricSource","comparator","targetValue","unit","window","status")
                 VALUES ('g-again','u1','Ship feature X',NULL,NULL,NULL,NULL,'total','draft')`,
            ),
        ).rejects.toThrow();

        await runner.release();
    });
});
