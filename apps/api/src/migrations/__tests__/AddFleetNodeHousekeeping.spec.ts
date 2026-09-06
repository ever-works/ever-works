import { DataSource } from 'typeorm';
import { AddFleetNodeHousekeeping1789500000000 } from '../1789500000000-AddFleetNodeHousekeeping';

/**
 * Migration test for the node-housekeeping schema (EW-803).
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs,
 * with one deliberate difference: every schema assertion goes through
 * `PRAGMA table_info`, i.e. the PHYSICAL schema, rather than through
 * `queryRunner.getTable()`.
 *
 * That matters here specifically. `getTable()` answers from the query
 * runner's own metadata, which is the thing a raw `ALTER TABLE ... DROP
 * COLUMN` desynchronises — so a `down()` that used the raw form could
 * pass a `getTable()` assertion while leaving the column on disk. Asking
 * sqlite directly is the only way this spec can tell the difference.
 *
 * Asserting the schema is also stronger than watching an INSERT fail:
 * an INSERT proves only that SOME constraint rejected the row, and it is
 * flaky under load. The column list is the actual contract.
 */
describe('AddFleetNodeHousekeeping1789500000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetNodeHousekeeping1789500000000();

    const NEW_COLUMNS = [
        'minFreeDiskBytes',
        'workspaceCount',
        'workspaceBytes',
        'lastReclaimAt',
        'lastReclaimFreedBytes',
    ];

    /** The physical column list, straight from sqlite. */
    const physicalColumns = async (): Promise<
        Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    > => dataSource.query(`PRAGMA table_info("fleet_nodes")`);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        // The subset of `fleet_nodes` this migration touches, plus the
        // telemetry column the new floor is meant to be read against.
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar NOT NULL,
                "kind" varchar NOT NULL,
                "status" varchar NOT NULL,
                "diskFreeBytes" bigint
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "kind", "status", "diskFreeBytes")
             VALUES ('n1', 'u1', 'Office PC', 'desktop-node', 'online', 1288490188)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds every housekeeping column to the physical schema, nullable and without a default', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const columns = await physicalColumns();
        for (const name of NEW_COLUMNS) {
            const column = columns.find((candidate) => candidate.name === name);
            expect(column).toBeDefined();
            // `notnull: 0` — an existing row cannot be forced to invent a value.
            expect(column?.notnull).toBe(0);
            // No DEFAULT: a `0` default would assert in the schema that every
            // already-enrolled node holds no workspaces and reclaimed nothing,
            // which is reassuring and false. NULL says "never reported".
            expect(column?.dflt_value).toBeNull();
        }
    });

    it('uses bigint for the byte columns and int for the count', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const byName = new Map((await physicalColumns()).map((column) => [column.name, column]));
        // A modern volume overflows a 32-bit int by three orders of
        // magnitude, so the byte columns must match `diskFreeBytes`.
        expect(byName.get('minFreeDiskBytes')?.type.toLowerCase()).toBe('bigint');
        expect(byName.get('workspaceBytes')?.type.toLowerCase()).toBe('bigint');
        expect(byName.get('lastReclaimFreedBytes')?.type.toLowerCase()).toBe('bigint');
        // …and the count is deliberately NOT a bigint: 100,000 is the
        // contract ceiling, so a 32-bit column is the honest width.
        expect(byName.get('workspaceCount')?.type.toLowerCase()).toBe('int');
    });

    it('leaves existing rows NULL rather than inventing a tidy machine', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const rows = await dataSource.query(
            `SELECT "minFreeDiskBytes", "workspaceCount", "workspaceBytes",
                    "lastReclaimAt", "lastReclaimFreedBytes", "diskFreeBytes"
             FROM "fleet_nodes"`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].minFreeDiskBytes).toBeNull();
        expect(rows[0].workspaceCount).toBeNull();
        expect(rows[0].workspaceBytes).toBeNull();
        expect(rows[0].lastReclaimAt).toBeNull();
        expect(rows[0].lastReclaimFreedBytes).toBeNull();
        // The reading these new columns give meaning to is untouched.
        expect(Number(rows[0].diskFreeBytes)).toBe(1288490188);
    });

    it('accepts a byte count far beyond a 32-bit int', async () => {
        // The whole reason for `bigint`. 8 TiB is an ordinary external
        // volume and would silently truncate in an `int` column.
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const eightTib = 8 * 1024 ** 4;
        await dataSource.query(`UPDATE "fleet_nodes" SET "workspaceBytes" = ? WHERE "id" = 'n1'`, [
            eightTib,
        ]);
        const rows = await dataSource.query(`SELECT "workspaceBytes" FROM "fleet_nodes"`);
        expect(Number(rows[0].workspaceBytes)).toBe(eightTib);
    });

    it('is idempotent — re-running up() does not throw', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();

        // And adds nothing a second time.
        const names = (await physicalColumns()).map((column) => column.name);
        for (const name of NEW_COLUMNS) {
            expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
        }
    });

    it('down() removes every column from the PHYSICAL schema and keeps the row', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        // Asked of sqlite, not of the query runner's cache: a raw
        // `ALTER TABLE ... DROP COLUMN` can leave the two disagreeing, and
        // this is the assertion that would catch it.
        const names = (await physicalColumns()).map((column) => column.name);
        for (const name of NEW_COLUMNS) {
            expect(names).not.toContain(name);
        }
        // The runner's own metadata agrees, so a later migration in the
        // same connection sees the same table this spec just checked.
        const table = await runner.getTable('fleet_nodes');
        for (const name of NEW_COLUMNS) {
            expect(table?.findColumnByName(name)).toBeUndefined();
        }
        const rows = await dataSource.query(`SELECT "id", "status" FROM "fleet_nodes"`);
        expect(rows).toEqual([{ id: 'n1', status: 'online' }]);
    });

    it('down() is safe to re-run', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);
        await expect(migration.down(runner)).resolves.toBeUndefined();
    });

    it('survives up() → down() → up(), which is what a rollback and redeploy is', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);
        await migration.up(runner);

        const names = (await physicalColumns()).map((column) => column.name);
        for (const name of NEW_COLUMNS) {
            expect(names).toContain(name);
        }
    });

    it('does not explode when fleet_nodes does not exist at all', async () => {
        // A stripped-down or not-yet-created schema must converge, not abort
        // — the API self-applies migrations on every boot.
        await dataSource.query(`DROP TABLE "fleet_nodes"`);
        const runner = dataSource.createQueryRunner();

        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
    });
});
