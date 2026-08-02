import { DataSource } from 'typeorm';
import { CreateWorkflows1784820000000 } from '../1784820000000-CreateWorkflows';

/**
 * Migration test for the `workflows` table.
 *
 * Runs on the same in-memory better-sqlite3 harness the sibling specs
 * use — which is the point, not an incidental detail. Production is
 * Postgres and CI/e2e are sqlite, so a migration written with raw
 * `gen_random_uuid()` / `CREATE INDEX IF NOT EXISTS` would pass in prod
 * and fail every CI run. Building it with TypeORM's portable Table API
 * is what makes both work, and this spec is what proves it.
 *
 * Also pinned: NO scope XOR CHECK. Copying that constraint from
 * `work_knowledge_documents` aborted a migration once already, because
 * `ScopeStampingSubscriber` stamps `organizationId` on every insert and
 * so ordinary rows have both scope columns populated.
 */
describe('CreateWorkflows1784820000000', () => {
    let dataSource: DataSource;
    const migration = new CreateWorkflows1784820000000();

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

        const table = await runner.getTable('workflows');
        expect(table).toBeDefined();
        for (const column of [
            'id',
            'userId',
            'name',
            'description',
            'status',
            'graph',
            'workId',
            'tenantId',
            'organizationId',
            'runCount',
            'lastRunAt',
            'createdAt',
            'updatedAt',
        ]) {
            expect(table?.findColumnByName(column)).toBeDefined();
        }

        await runner.release();
    });

    it('is idempotent — a second up() does not throw', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();
        await runner.release();
    });

    // NOTE: these raw inserts supply createdAt/updatedAt explicitly. The
    // columns default to `now()`, which Postgres has and sqlite does not —
    // harmless in practice because every real insert goes through TypeORM,
    // whose @CreateDateColumn supplies the value from the ORM side. Only a
    // hand-written INSERT like this one would ever hit the DB default.
    it('accepts a row with BOTH workId and organizationId set', async () => {
        // The scope-stamping subscriber populates organizationId on every
        // insert, so this is the ORDINARY shape. A copied XOR CHECK would
        // reject it — that is the exact defect this pins against.
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await expect(
            dataSource.query(
                `INSERT INTO "workflows"
                    ("id","userId","name","status","graph","workId","organizationId","runCount","createdAt","updatedAt")
                 VALUES ('w1','u1','Nightly digest','draft','{}','work-1','org-1',0,'2026-08-02','2026-08-02')`,
            ),
        ).resolves.not.toThrow();

        const rows = await dataSource.query(
            `SELECT "workId", "organizationId" FROM "workflows" WHERE "id" = 'w1'`,
        );
        expect(rows[0]).toMatchObject({ workId: 'work-1', organizationId: 'org-1' });

        await runner.release();
    });

    it('accepts an organization-level workflow with no workId', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await dataSource.query(
            `INSERT INTO "workflows"
                ("id","userId","name","status","graph","organizationId","runCount","createdAt","updatedAt")
             VALUES ('w2','u1','Org workflow','active','{}','org-1',0,'2026-08-02','2026-08-02')`,
        );

        const rows = await dataSource.query(`SELECT "workId" FROM "workflows" WHERE "id" = 'w2'`);
        expect(rows[0].workId).toBeNull();

        await runner.release();
    });

    it('down() drops the table', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        expect(await runner.hasTable('workflows')).toBe(false);

        await runner.release();
    });
});
