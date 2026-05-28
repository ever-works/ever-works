import { DataSource } from 'typeorm';
import { AddWorkKindAndStatus1779991010000 } from '../1779991010000-AddWorkKindAndStatus';

/**
 * EW-665 (Tenants & Organizations Phase 13) — migration test for the
 * `works.kind` + `works.status` columns.
 *
 * Runs the real migration's `up()` / `down()` against an in-memory
 * better-sqlite3 DataSource (same harness the agent package's
 * timestamp-column integration test uses). Asserts that:
 *   - both columns exist after `up()`,
 *   - a row inserted WITHOUT specifying them backfills to the column
 *     defaults (`kind = 'default'`, `status = 'active'`),
 *   - the migration is idempotent (running `up()` twice is a no-op), and
 *   - `down()` drops both columns.
 */
describe('AddWorkKindAndStatus1779991010000 (EW-665 Phase 13)', () => {
    let dataSource: DataSource;
    const migration = new AddWorkKindAndStatus1779991010000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        // Minimal `works` table — just enough to add the columns onto. The
        // migration only touches `kind` / `status`, so a couple of NOT NULL
        // columns are enough to prove the defaults backfill an INSERT that
        // omits them.
        await dataSource.query(
            `CREATE TABLE "works" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL)`,
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(`PRAGMA table_info("works")`);
        return rows.map((r) => r.name);
    }

    it('adds kind + status columns with the documented defaults', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const cols = await columnNames();
        expect(cols).toEqual(expect.arrayContaining(['kind', 'status']));

        // Insert a row WITHOUT kind/status — the DB defaults must backfill.
        await dataSource.query(`INSERT INTO "works" ("id", "name") VALUES ('w-1', 'Acme')`);
        const [row] = await dataSource.query(
            `SELECT "kind", "status" FROM "works" WHERE "id" = 'w-1'`,
        );
        expect(row.kind).toBe('default');
        expect(row.status).toBe('active');
    });

    it('is idempotent — running up() twice does not throw or duplicate columns', async () => {
        const r1 = dataSource.createQueryRunner();
        await migration.up(r1);
        await r1.release();

        const r2 = dataSource.createQueryRunner();
        await expect(migration.up(r2)).resolves.toBeUndefined();
        await r2.release();

        const cols = await columnNames();
        expect(cols.filter((c) => c === 'kind')).toHaveLength(1);
        expect(cols.filter((c) => c === 'status')).toHaveLength(1);
    });

    it('down() drops both columns', async () => {
        const up = dataSource.createQueryRunner();
        await migration.up(up);
        await up.release();

        const down = dataSource.createQueryRunner();
        await migration.down(down);
        await down.release();

        const cols = await columnNames();
        expect(cols).not.toContain('kind');
        expect(cols).not.toContain('status');
    });
});
