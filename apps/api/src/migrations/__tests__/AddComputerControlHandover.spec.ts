import { DataSource } from 'typeorm';
import { AddComputerControlHandover1791141100000 } from '../1791141100000-AddComputerControlHandover';

/**
 * Migration test for the take-over half of the machine control lock.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs. What
 * an upgraded install depends on:
 *
 *  - every new column is NULLABLE and NULL on an existing machine — nobody
 *    holds control of it and nobody is asking;
 *  - the Phase 1 lock columns and the row itself are untouched;
 *  - `up()` converges on a partially-applied database, and `down()` removes
 *    exactly what `up()` added.
 */
describe('AddComputerControlHandover1791141100000', () => {
    let dataSource: DataSource;
    const migration = new AddComputerControlHandover1791141100000();

    const NEW_COLUMNS = [
        'controlIdleAt',
        'controlAckAt',
        'controlExtendedAt',
        'controlRequestUserId',
        'controlRequestSessionId',
        'controlRequestedAt',
    ];

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        // The subset of `fleet_nodes` this migration touches, as Phase 1 left it.
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar NOT NULL,
                "status" varchar NOT NULL,
                "controlPolicy" varchar(24) NOT NULL DEFAULT ('owner'),
                "controlHolderUserId" varchar,
                "controlHolderSessionId" varchar,
                "controlHeldSince" datetime,
                "controlExpiresAt" datetime
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "status", "controlHolderUserId", "controlHolderSessionId")
             VALUES ('n1', 'u1', 'studio', 'online', 'u1', 's1')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds every column as nullable and leaves existing machines NULL', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('fleet_nodes');
        for (const name of NEW_COLUMNS) {
            expect(table?.findColumnByName(name)?.isNullable).toBe(true);
        }
        const rows = await dataSource.query(`SELECT * FROM "fleet_nodes"`);
        expect(rows).toHaveLength(1);
        for (const name of NEW_COLUMNS) {
            expect(rows[0][name]).toBeNull();
        }
        // Phase 1's lock and the machine itself are untouched.
        expect(rows[0].controlHolderSessionId).toBe('s1');
        expect(rows[0].controlPolicy).toBe('owner');
        expect(rows[0].name).toBe('studio');
    });

    it('is idempotent, including over a partially-applied database', async () => {
        const runner = dataSource.createQueryRunner();
        await runner.query(`ALTER TABLE "fleet_nodes" ADD COLUMN "controlIdleAt" datetime`);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        const table = await runner.getTable('fleet_nodes');
        for (const name of NEW_COLUMNS) {
            expect(table?.findColumnByName(name)).toBeDefined();
        }
    });

    it('down() drops exactly what up() added and keeps the row', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        const table = await runner.getTable('fleet_nodes');
        for (const name of NEW_COLUMNS) {
            expect(table?.findColumnByName(name)).toBeUndefined();
        }
        expect(table?.findColumnByName('controlHolderSessionId')).toBeDefined();
        const rows = await dataSource.query(`SELECT "id" FROM "fleet_nodes"`);
        expect(rows).toEqual([{ id: 'n1' }]);
    });
});
