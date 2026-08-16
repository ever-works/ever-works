import { DataSource } from 'typeorm';
import { CreateGoalEvents1786900001000 } from '../1786900001000-CreateGoalEvents';

/**
 * Migration test for the `goal_events` orchestrator log.
 *
 * Same in-memory better-sqlite3 harness as `CreateWorkflowRuns.spec.ts`,
 * and the same reason: production is Postgres, CI is sqlite, and only a
 * portable Table-API migration works on both.
 *
 * Also pinned: NO scope XOR CHECK. `ScopeStampingSubscriber` stamps
 * `organizationId` on every insert, so ordinary rows carry both scope
 * columns and a copied XOR would abort the migration on real data.
 */
describe('CreateGoalEvents1786900001000', () => {
    let dataSource: DataSource;
    const migration = new CreateGoalEvents1786900001000();

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

    it('creates the table with every expected column', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('goal_events');
        expect(table).toBeDefined();
        for (const column of [
            'id',
            'goalId',
            'userId',
            'kind',
            'message',
            'agentId',
            'taskId',
            'iteration',
            'metadata',
            'tenantId',
            'organizationId',
            'createdAt',
        ]) {
            expect(table?.findColumnByName(column)).toBeDefined();
        }

        await runner.release();
    });

    it('creates the per-goal log indexes the Orchestrator tab depends on', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('goal_events');
        expect((table?.indices ?? []).map((index) => index.name)).toEqual(
            expect.arrayContaining([
                'idx_goal_events_goal_created',
                'idx_goal_events_goal_iteration',
            ]),
        );

        await runner.release();
    });

    it('is idempotent — a second up() does not throw', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();
        await runner.release();
    });

    // NOTE: these raw inserts supply createdAt explicitly. The column
    // defaults to `now()`, which Postgres has and sqlite does not —
    // harmless in practice because every real insert goes through TypeORM.
    it('accepts a routing row carrying BOTH a tenant and an organization', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await expect(
            dataSource.query(
                `INSERT INTO "goal_events"
                    ("id","goalId","userId","kind","message","iteration","tenantId","organizationId","createdAt")
                 VALUES ('e1','g1','u1','route','Routed iteration 4 to research-agent',4,'tenant-1','org-1','2026-08-15')`,
            ),
        ).resolves.not.toThrow();

        const rows = await dataSource.query(
            `SELECT "kind","iteration","tenantId","organizationId" FROM "goal_events" WHERE "id" = 'e1'`,
        );
        expect(rows[0]).toMatchObject({
            kind: 'route',
            iteration: 4,
            tenantId: 'tenant-1',
            organizationId: 'org-1',
        });

        await runner.release();
    });

    it('accepts a dispatch row with agent/task pointers and JSON metadata', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await dataSource.query(
            `INSERT INTO "goal_events"
                ("id","goalId","userId","kind","message","agentId","taskId","iteration","metadata","createdAt")
             VALUES ('e2','g1','u1','dispatch','Dispatched iteration 4','agent-1','task-1',4,'{"runId":"run-1","dispatched":true}','2026-08-15')`,
        );

        const rows = await dataSource.query(
            `SELECT "agentId","taskId","metadata" FROM "goal_events" WHERE "id" = 'e2'`,
        );
        expect(rows[0].agentId).toBe('agent-1');
        expect(rows[0].taskId).toBe('task-1');
        expect(JSON.parse(rows[0].metadata)).toEqual({ runId: 'run-1', dispatched: true });

        await runner.release();
    });

    it('down() drops the table', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        expect(await runner.hasTable('goal_events')).toBe(false);

        await runner.release();
    });
});
