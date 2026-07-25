import { DataSource } from 'typeorm';
import { AddRunSteeringColumns1784100000000 } from '../1784100000000-AddRunSteeringColumns';

/**
 * Run steering (Wave 4 M5) — migration test for the two `agent_runs`
 * steering columns, run against an in-memory better-sqlite3 DataSource
 * (same harness as `AddWorkKindAndStatus.spec.ts`).
 *
 * The load-bearing assertion is the `interruptRequested` DEFAULT: the tool
 * loop reads it on every iteration, and a NULL there on a pre-existing row
 * would make `interruptRequested === true` comparisons behave unpredictably
 * across drivers. `false` for every historical run is the only correct
 * backfill.
 */
describe('AddRunSteeringColumns1784100000000 (Wave 4 M5)', () => {
    let dataSource: DataSource;
    const migration = new AddRunSteeringColumns1784100000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "agent_runs" ("id" varchar PRIMARY KEY NOT NULL, "status" varchar NOT NULL)`,
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("agent_runs")`,
        );
        return rows.map((r) => r.name);
    }

    it('adds pendingInput + interruptRequested', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        expect(await columnNames()).toEqual(
            expect.arrayContaining(['pendingInput', 'interruptRequested']),
        );
    });

    it('⭐ backfills every historical run to interruptRequested = false, pendingInput = NULL', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        await dataSource.query(
            `INSERT INTO "agent_runs" ("id", "status") VALUES ('run-1', 'running')`,
        );
        const [row] = await dataSource.query(
            `SELECT "pendingInput", "interruptRequested" FROM "agent_runs" WHERE "id" = 'run-1'`,
        );
        expect(row.pendingInput).toBeNull();
        // sqlite renders booleans as 0/1; both drivers must read "not requested".
        expect(Boolean(row.interruptRequested)).toBe(false);
    });

    it('is idempotent — running up() twice does not throw or duplicate columns', async () => {
        const r1 = dataSource.createQueryRunner();
        await migration.up(r1);
        await r1.release();

        const r2 = dataSource.createQueryRunner();
        await expect(migration.up(r2)).resolves.toBeUndefined();
        await r2.release();

        const cols = await columnNames();
        expect(cols.filter((c) => c === 'pendingInput')).toHaveLength(1);
        expect(cols.filter((c) => c === 'interruptRequested')).toHaveLength(1);
    });

    it('down() drops both columns', async () => {
        const up = dataSource.createQueryRunner();
        await migration.up(up);
        await up.release();

        const down = dataSource.createQueryRunner();
        await migration.down(down);
        await down.release();

        const cols = await columnNames();
        expect(cols).not.toContain('pendingInput');
        expect(cols).not.toContain('interruptRequested');
    });
});
