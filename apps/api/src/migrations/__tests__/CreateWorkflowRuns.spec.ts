import { DataSource } from 'typeorm';
import { CreateWorkflowRuns1784830000000 } from '../1784830000000-CreateWorkflowRuns';

/**
 * Migration test for the `workflow_runs` table.
 *
 * Runs on the same in-memory better-sqlite3 harness as
 * `CreateWorkflows.spec.ts`, and for the same reason: production is
 * Postgres while CI and the e2e stack are sqlite, so a migration written
 * with raw `gen_random_uuid()` / `CREATE INDEX IF NOT EXISTS` would pass
 * in prod and fail every CI run. Building it with TypeORM's portable
 * Table API is what makes both work; this spec is what proves it.
 *
 * Also pinned: NO scope XOR CHECK. `ScopeStampingSubscriber` stamps
 * `organizationId` on every insert, so ordinary rows carry both scope
 * columns and a copied XOR would abort the migration on real data.
 */
describe('CreateWorkflowRuns1784830000000', () => {
    let dataSource: DataSource;
    const migration = new CreateWorkflowRuns1784830000000();

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

        const table = await runner.getTable('workflow_runs');
        expect(table).toBeDefined();
        for (const column of [
            'id',
            'workflowId',
            'userId',
            'status',
            'triggerRunId',
            'startedAt',
            'finishedAt',
            'durationMs',
            'errorMessage',
            'trace',
            'output',
            'outputTruncated',
            'failureCode',
            'failedNodeId',
            'stepCount',
            'tenantId',
            'organizationId',
            'createdAt',
        ]) {
            expect(table?.findColumnByName(column)).toBeDefined();
        }

        await runner.release();
    });

    it('creates the run-history index the list route depends on', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('workflow_runs');
        const names = (table?.indices ?? []).map((index) => index.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'idx_workflow_runs_workflow_started',
                'idx_workflow_runs_status',
                'idx_workflow_runs_user',
                'idx_workflow_runs_org',
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
    // harmless in practice because every real insert goes through TypeORM,
    // whose @CreateDateColumn supplies the value from the ORM side.
    it('accepts a row with BOTH workId-scope org and a tenant set', async () => {
        // The scope-stamping subscriber populates organizationId on every
        // insert, so this is the ORDINARY shape. A copied XOR CHECK would
        // reject it — that is the exact defect this pins against.
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await expect(
            dataSource.query(
                `INSERT INTO "workflow_runs"
                    ("id","workflowId","userId","status","stepCount","outputTruncated","tenantId","organizationId","createdAt")
                 VALUES ('r1','w1','u1','queued',0,0,'tenant-1','org-1','2026-08-03')`,
            ),
        ).resolves.not.toThrow();

        const rows = await dataSource.query(
            `SELECT "tenantId", "organizationId", "status" FROM "workflow_runs" WHERE "id" = 'r1'`,
        );
        expect(rows[0]).toMatchObject({
            tenantId: 'tenant-1',
            organizationId: 'org-1',
            status: 'queued',
        });

        await runner.release();
    });

    it('accepts a terminal row carrying a trace and a failure code', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await dataSource.query(
            `INSERT INTO "workflow_runs"
                ("id","workflowId","userId","status","stepCount","outputTruncated","trace","output","failureCode","failedNodeId","durationMs","createdAt")
             VALUES ('r2','w1','u1','failed',2,0,'{"visited":["a","b"]}','null','node-failed','b',1234,'2026-08-03')`,
        );

        const rows = await dataSource.query(
            `SELECT "status","failureCode","failedNodeId","stepCount","durationMs","trace" FROM "workflow_runs" WHERE "id" = 'r2'`,
        );
        expect(rows[0]).toMatchObject({
            status: 'failed',
            failureCode: 'node-failed',
            failedNodeId: 'b',
            stepCount: 2,
            durationMs: 1234,
        });
        expect(JSON.parse(rows[0].trace)).toEqual({ visited: ['a', 'b'] });

        await runner.release();
    });

    it('down() drops the table', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        expect(await runner.hasTable('workflow_runs')).toBe(false);

        await runner.release();
    });
});
