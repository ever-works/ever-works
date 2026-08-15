import { DataSource } from 'typeorm';
import { AddGoalOrchestration1785010000000 } from '../1785010000000-AddGoalOrchestration';

/**
 * Migration test for the additive `goals` autonomy columns.
 *
 * Runs on the same in-memory better-sqlite3 harness as its siblings, and
 * for the same reason: production is Postgres while CI and the e2e stack
 * are sqlite, so a migration written with Postgres-only DDL would pass in
 * prod and fail every CI run.
 *
 * What is pinned here beyond "the columns exist":
 *  - EXISTING rows survive with sane defaults (`spentCents`/`iteration`
 *    are `NOT NULL DEFAULT 0`, everything else NULL) — the migration is
 *    additive and must not need a backfill.
 *  - `loopStatus` is a NEW column, not new members on `status`: the
 *    metric-evaluation dispatcher keys on `status` and would change
 *    behaviour if `cancelled`/`stuck` appeared there.
 */
describe('AddGoalOrchestration1785010000000', () => {
    let dataSource: DataSource;
    const migration = new AddGoalOrchestration1785010000000();

    const ADDED_COLUMNS = [
        'dodCriteria',
        'spendCapCents',
        'spentCents',
        'wallClockLimitHours',
        'stuckThresholdIterations',
        'sessionBudgetMinutes',
        'gracePeriodMinutes',
        'executionTarget',
        'plannerModelHint',
        'workerModelHint',
        'iteration',
        'lastProgressIteration',
        'activeAgentId',
        'assignedAgentId',
        'loopStatus',
        'loopStartedAt',
        'archivedAt',
    ];

    /** A minimal stand-in for the pre-existing `goals` table. */
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
                "status" varchar NOT NULL DEFAULT 'draft'
            )
        `);
    };

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

    it('adds every autonomy column', async () => {
        await createGoalsTable();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('goals');
        for (const column of ADDED_COLUMNS) {
            expect(table?.findColumnByName(column)).toBeDefined();
        }

        await runner.release();
    });

    it('leaves an EXISTING row valid with zeroed counters and null ceilings', async () => {
        await createGoalsTable();
        await dataSource.query(
            `INSERT INTO "goals" ("id","userId","title","metricSource","comparator","targetValue","unit","window","status")
             VALUES ('g1','u1','Legacy goal','{}','gte',1000,'usd','month','active')`,
        );

        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const rows = await dataSource.query(
            `SELECT "spentCents","iteration","lastProgressIteration","spendCapCents","loopStatus","archivedAt" FROM "goals" WHERE "id" = 'g1'`,
        );
        expect(rows[0]).toMatchObject({
            spentCents: 0,
            iteration: 0,
            lastProgressIteration: 0,
            spendCapCents: null,
            loopStatus: null,
            archivedAt: null,
        });

        await runner.release();
    });

    it('creates the orchestrator due-scan index', async () => {
        await createGoalsTable();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('goals');
        expect((table?.indices ?? []).map((index) => index.name)).toEqual(
            expect.arrayContaining(['idx_goals_loop_status']),
        );

        await runner.release();
    });

    it('is idempotent — a second up() does not throw', async () => {
        await createGoalsTable();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();
        await runner.release();
    });

    it('no-ops when the goals table does not exist yet', async () => {
        const runner = dataSource.createQueryRunner();
        await expect(migration.up(runner)).resolves.not.toThrow();
        await runner.release();
    });

    it('down() removes every added column', async () => {
        await createGoalsTable();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        const table = await runner.getTable('goals');
        for (const column of ADDED_COLUMNS) {
            expect(table?.findColumnByName(column)).toBeUndefined();
        }
        // The original columns are untouched — the revert removes a
        // feature, it does not mangle the table it was added to.
        expect(table?.findColumnByName('status')).toBeDefined();
        expect(table?.findColumnByName('targetValue')).toBeDefined();

        await runner.release();
    });
});
