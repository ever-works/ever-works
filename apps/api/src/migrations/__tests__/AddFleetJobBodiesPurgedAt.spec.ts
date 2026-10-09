import { DataSource } from 'typeorm';
import { AddFleetJobBodiesPurgedAt1795040000000 } from '../1795040000000-AddFleetJobBodiesPurgedAt';

/**
 * Migration test for the fleet job retention marker (self-build slice AP).
 *
 * Same in-memory better-sqlite3 harness as `AddFleetNodeHousekeeping.spec`,
 * asserting the PHYSICAL schema through `PRAGMA` rather than through the
 * query runner's own metadata (which a raw DDL statement can desynchronise).
 */
describe('AddFleetJobBodiesPurgedAt1795040000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetJobBodiesPurgedAt1795040000000();

    const physicalColumns = async (): Promise<
        Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    > => dataSource.query(`PRAGMA table_info("fleet_jobs")`);
    const indexNames = async (): Promise<string[]> =>
        (
            (await dataSource.query(`PRAGMA index_list("fleet_jobs")`)) as Array<{ name: string }>
        ).map((index) => index.name);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        // The subset of `fleet_jobs` this migration touches.
        await dataSource.query(`
            CREATE TABLE "fleet_jobs" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "status" varchar(16) NOT NULL,
                "payload" text,
                "result" text,
                "completedAt" datetime
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_jobs" ("id", "userId", "status", "payload", "result", "completedAt")
             VALUES ('j1', 'u1', 'done', '{"runId":"r1"}', '{"status":"succeeded"}', '2026-01-01 00:00:00')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable, default-free bodiesPurgedAt column and the purge index', async () => {
        await migration.up(dataSource.createQueryRunner());

        const column = (await physicalColumns()).find(
            (candidate) => candidate.name === 'bodiesPurgedAt',
        );
        expect(column).toBeDefined();
        expect(column?.notnull).toBe(0);
        // No default: an existing row has NOT been purged, and saying so is
        // what lets the first nightly pass find the backlog.
        expect(column?.dflt_value).toBeNull();
        expect(await indexNames()).toContain('idx_fleet_jobs_bodies_purge');
    });

    it('leaves existing rows and their bodies untouched', async () => {
        await migration.up(dataSource.createQueryRunner());
        const rows = await dataSource.query(
            `SELECT "payload", "result", "bodiesPurgedAt" FROM "fleet_jobs"`,
        );
        expect(rows).toEqual([
            { payload: '{"runId":"r1"}', result: '{"status":"succeeded"}', bodiesPurgedAt: null },
        ]);
    });

    it('is idempotent: a second up() converges instead of throwing', async () => {
        await migration.up(dataSource.createQueryRunner());
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        expect(
            (await physicalColumns()).filter((column) => column.name === 'bodiesPurgedAt'),
        ).toHaveLength(1);
    });

    it('down() removes the column and the index from the physical schema', async () => {
        await migration.up(dataSource.createQueryRunner());
        await migration.down(dataSource.createQueryRunner());
        expect((await physicalColumns()).map((column) => column.name)).not.toContain(
            'bodiesPurgedAt',
        );
        expect(await indexNames()).not.toContain('idx_fleet_jobs_bodies_purge');
        const rows = await dataSource.query(`SELECT "payload" FROM "fleet_jobs"`);
        expect(rows).toEqual([{ payload: '{"runId":"r1"}' }]);
    });
});
