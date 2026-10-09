import { DataSource } from 'typeorm';
import { AddFleetNodeLimits1795030000000 } from '../1795030000000-AddFleetNodeLimits';

/**
 * Migration test for remote node limits (self-build slice AS).
 *
 * Same in-memory better-sqlite3 harness as `AddFleetNodeHousekeeping.spec.ts`;
 * every schema assertion reads `PRAGMA table_info` (the PHYSICAL schema),
 * because the query runner's own metadata is exactly what a raw
 * `DROP COLUMN` would desynchronise.
 */
describe('AddFleetNodeLimits1795030000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetNodeLimits1795030000000();

    const NEW_COLUMNS = [
        'effectiveMaxConcurrentJobs',
        'effectiveMaxCpuPercent',
        'effectiveMaxMemoryMb',
        'ceilingMaxConcurrentJobs',
        'ceilingMaxCpuPercent',
        'ceilingMaxMemoryMb',
    ];

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
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar NOT NULL,
                "kind" varchar NOT NULL,
                "status" varchar NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "kind", "status")
             VALUES ('n1', 'u1', 'Office PC', 'desktop-node', 'online')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds six nullable int columns with no default', async () => {
        await migration.up(dataSource.createQueryRunner());

        const byName = new Map((await physicalColumns()).map((column) => [column.name, column]));
        for (const name of NEW_COLUMNS) {
            const column = byName.get(name);
            expect(column).toBeDefined();
            expect(column?.type.toLowerCase()).toBe('int');
            expect(column?.notnull).toBe(0);
            // No DEFAULT: NULL is "never reported" / "no ceiling" — the truth
            // for every existing row, and the value that changes nothing.
            expect(column?.dflt_value).toBeNull();
        }
    });

    it('leaves every existing node with no ceiling and no reading', async () => {
        await migration.up(dataSource.createQueryRunner());
        const rows = await dataSource.query(
            `SELECT ${NEW_COLUMNS.map((name) => `"${name}"`).join(', ')} FROM "fleet_nodes"`,
        );
        expect(rows).toHaveLength(1);
        for (const name of NEW_COLUMNS) {
            expect(rows[0][name]).toBeNull();
        }
    });

    it('holds the largest legitimate value — a 1 TiB memory ceiling in MB', async () => {
        await migration.up(dataSource.createQueryRunner());
        await dataSource.query(
            `UPDATE "fleet_nodes" SET "ceilingMaxMemoryMb" = ? WHERE "id" = 'n1'`,
            [1_048_576],
        );
        const rows = await dataSource.query(`SELECT "ceilingMaxMemoryMb" FROM "fleet_nodes"`);
        expect(Number(rows[0].ceilingMaxMemoryMb)).toBe(1_048_576);
    });

    it('is idempotent, and down() removes every column from the physical schema', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        const names = (await physicalColumns()).map((column) => column.name);
        for (const name of NEW_COLUMNS) {
            expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
        }

        await migration.down(runner);
        const after = (await physicalColumns()).map((column) => column.name);
        for (const name of NEW_COLUMNS) {
            expect(after).not.toContain(name);
        }
        await expect(migration.down(runner)).resolves.toBeUndefined();
        expect(await dataSource.query(`SELECT "id", "status" FROM "fleet_nodes"`)).toEqual([
            { id: 'n1', status: 'online' },
        ]);
    });

    it('survives up() → down() → up(), and a missing table', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);
        await migration.up(runner);
        const names = (await physicalColumns()).map((column) => column.name);
        for (const name of NEW_COLUMNS) expect(names).toContain(name);

        await dataSource.query(`DROP TABLE "fleet_nodes"`);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
    });
});
