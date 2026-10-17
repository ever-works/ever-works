import { DataSource } from 'typeorm';
import { AddFleetModelUsageLimits1795161700000 } from '../1795161700000-AddFleetModelUsageLimits';

/**
 * Migration test for fleet usage limits: `fleet_nodes.modelThrottles` and
 * `fleet_jobs.usageLimitParks`. Same in-memory better-sqlite3 harness as
 * `AddFleetJobBodiesPurgedAt.spec`, asserting the PHYSICAL schema via PRAGMA.
 */
describe('AddFleetModelUsageLimits1795161700000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetModelUsageLimits1795161700000();

    const columns = async (
        table: string,
    ): Promise<Array<{ name: string; notnull: number; dflt_value: string | null }>> =>
        dataSource.query(`PRAGMA table_info("${table}")`);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar(200) NOT NULL
            )
        `);
        await dataSource.query(`
            CREATE TABLE "fleet_jobs" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "status" varchar(16) NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name") VALUES ('n1', 'u1', 'everdesk4')`,
        );
        await dataSource.query(
            `INSERT INTO "fleet_jobs" ("id", "userId", "status") VALUES ('j1', 'u1', 'queued')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable modelThrottles and a NOT NULL usageLimitParks defaulting to 0', async () => {
        await migration.up(dataSource.createQueryRunner());

        const throttles = (await columns('fleet_nodes')).find(
            (column) => column.name === 'modelThrottles',
        );
        expect(throttles?.notnull).toBe(0);
        expect(throttles?.dflt_value).toBeNull();
        const parks = (await columns('fleet_jobs')).find(
            (column) => column.name === 'usageLimitParks',
        );
        expect(parks?.notnull).toBe(1);
        expect(parks?.dflt_value).toBe('0');

        expect(await dataSource.query(`SELECT "modelThrottles" FROM "fleet_nodes"`)).toEqual([
            { modelThrottles: null },
        ]);
        expect(await dataSource.query(`SELECT "usageLimitParks" FROM "fleet_jobs"`)).toEqual([
            { usageLimitParks: 0 },
        ]);
    });

    it('is idempotent and reversible', async () => {
        await migration.up(dataSource.createQueryRunner());
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        await migration.down(dataSource.createQueryRunner());
        expect(
            (await columns('fleet_nodes')).some((column) => column.name === 'modelThrottles'),
        ).toBe(false);
        expect(
            (await columns('fleet_jobs')).some((column) => column.name === 'usageLimitParks'),
        ).toBe(false);
    });
});
