import { DataSource } from 'typeorm';
import { AddFleetCostAccounting1788300000000 } from '../1788300000000-AddFleetCostAccounting';

/**
 * Migration test for fleet cost accounting + model identity (EW-777).
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters:
 *
 *  - every new column lands NULL on existing rows — a node that predates
 *    the field never reported a seat, has no ceiling of its own and was
 *    never tripped; a job that predates the column reported no cost.
 *    Backfilling 0 would read as "free", which is not what history says;
 *  - the per-node daily-sum index exists on `(nodeId, completedAt)`;
 *  - `fleet_cost_policies` is one row per owner — the index IS unique;
 *  - `up()` is idempotent, and `down()` reverses all of it.
 */
describe('AddFleetCostAccounting1788300000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetCostAccounting1788300000000();

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
                "name" varchar NOT NULL,
                "kind" varchar NOT NULL,
                "status" varchar NOT NULL,
                "cliVersion" varchar
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "kind", "status", "cliVersion")
             VALUES ('n1', 'u1', 'laptop', 'desktop-node', 'online', 'claude 1.4.2')`,
        );
        await dataSource.query(`
            CREATE TABLE "fleet_jobs" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "nodeId" varchar,
                "kind" varchar NOT NULL,
                "status" varchar NOT NULL,
                "completedAt" datetime
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_jobs" ("id", "userId", "nodeId", "kind", "status", "completedAt")
             VALUES ('j1', 'u1', 'n1', 'agent-task', 'done', '2026-09-05 10:00:00.000')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the node identity + ceiling columns and leaves existing rows NULL', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const rows = await dataSource.query(
            `SELECT "modelIdentity", "dailyCostCeilingCents", "dailyCostTrippedOn", "cliVersion" FROM "fleet_nodes"`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].modelIdentity).toBeNull();
        expect(rows[0].dailyCostCeilingCents).toBeNull();
        expect(rows[0].dailyCostTrippedOn).toBeNull();
        // The sibling telemetry column is untouched.
        expect(rows[0].cliVersion).toBe('claude 1.4.2');
    });

    it('adds fleet_jobs.costCents as NULL on existing rows, with the per-node daily index', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const rows = await dataSource.query(`SELECT "costCents" FROM "fleet_jobs"`);
        // NULL, not 0: a job that predates the column reported no cost,
        // and 0 would read as "free" in every daily sum.
        expect(rows[0].costCents).toBeNull();

        const table = await runner.getTable('fleet_jobs');
        const index = (table?.indices ?? []).find(
            (entry) => entry.name === 'idx_fleet_jobs_node_completed',
        );
        expect(index?.columnNames).toEqual(['nodeId', 'completedAt']);
    });

    it('creates fleet_cost_policies with ONE row per owner (unique index)', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        expect(await runner.hasTable('fleet_cost_policies')).toBe(true);
        const table = await runner.getTable('fleet_cost_policies');
        expect(table?.findColumnByName('dailyCeilingCents')?.isNullable).toBe(true);
        expect(table?.findColumnByName('trippedOn')?.isNullable).toBe(true);
        const unique = (table?.indices ?? []).find(
            (index) => index.name === 'uq_fleet_cost_policies_user',
        );
        expect(unique?.isUnique).toBe(true);
        expect(unique?.columnNames).toEqual(['userId']);
    });

    it('is idempotent — re-running up() does not throw', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
    });

    it('down() reverses every step', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        expect(await runner.hasTable('fleet_cost_policies')).toBe(false);
        const nodes = await runner.getTable('fleet_nodes');
        expect(nodes?.findColumnByName('modelIdentity')).toBeUndefined();
        expect(nodes?.findColumnByName('dailyCostCeilingCents')).toBeUndefined();
        expect(nodes?.findColumnByName('dailyCostTrippedOn')).toBeUndefined();
        const jobs = await runner.getTable('fleet_jobs');
        expect(jobs?.findColumnByName('costCents')).toBeUndefined();
        expect(
            (jobs?.indices ?? []).some((index) => index.name === 'idx_fleet_jobs_node_completed'),
        ).toBe(false);
        // The pre-existing rows survive the round trip.
        expect(await dataSource.query(`SELECT "id" FROM "fleet_nodes"`)).toHaveLength(1);
        expect(await dataSource.query(`SELECT "id" FROM "fleet_jobs"`)).toHaveLength(1);
    });

    it('does not explode when the fleet tables do not exist at all', async () => {
        await dataSource.query(`DROP TABLE "fleet_nodes"`);
        await dataSource.query(`DROP TABLE "fleet_jobs"`);
        const runner = dataSource.createQueryRunner();

        await expect(migration.up(runner)).resolves.toBeUndefined();
        // The independent table still lands — a guard on one step must
        // not skip the others.
        expect(await runner.hasTable('fleet_cost_policies')).toBe(true);
    });
});
