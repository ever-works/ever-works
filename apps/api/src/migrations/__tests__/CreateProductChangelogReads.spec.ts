import { DataSource } from 'typeorm';
import { CreateProductChangelogReads1791140000000 } from '../1791140000000-CreateProductChangelogReads';

/**
 * What's new (AW-14) — migration test for `product_changelog_reads`, run
 * against an in-memory better-sqlite3 DataSource (same harness as
 * `CreateReleasePromotions.spec.ts`).
 *
 * The load-bearing assertion is the UNIQUE `(userId, entrySlug)` index,
 * exercised the way the repository uses it: a second read row for the same
 * person and entry must collide, while the same entry for another person
 * and another entry for the same person must not. That index is the whole
 * idempotency guarantee behind "two tabs marking the same entry read leave
 * exactly one row".
 *
 * Inserts pass `id` and `readAt` explicitly: the `uuid_generate_v4()` /
 * `now()` defaults are Postgres functions, and sqlite is only a DDL harness.
 */
describe('CreateProductChangelogReads1791140000000', () => {
    let dataSource: DataSource;
    const migration = new CreateProductChangelogReads1791140000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`PRAGMA foreign_keys = ON`);
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u-a'), ('u-b')`);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    async function up(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    async function down(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
    }

    async function columnNames(table: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return rows.map((r) => r.name);
    }

    function insert(id: string, userId: string, entrySlug: string): Promise<unknown> {
        return dataSource.query(
            `INSERT INTO "product_changelog_reads" ("id", "userId", "entrySlug", "readAt") VALUES ('${id}', '${userId}', '${entrySlug}', '2026-09-14 00:00:00')`,
        );
    }

    async function count(): Promise<number> {
        const rows: Array<{ n: number }> = await dataSource.query(
            `SELECT COUNT(*) AS n FROM "product_changelog_reads"`,
        );
        return Number(rows[0].n);
    }

    it('creates the table with exactly the person, entry and timestamp columns', async () => {
        await up();
        expect((await columnNames('product_changelog_reads')).sort()).toEqual(
            ['entrySlug', 'id', 'readAt', 'userId'].sort(),
        );
    });

    it('carries no workspace-scope columns — read state follows the person (FR-13)', async () => {
        await up();
        const columns = await columnNames('product_changelog_reads');
        expect(columns).not.toContain('tenantId');
        expect(columns).not.toContain('organizationId');
    });

    it('refuses a SECOND read row for the same person and entry', async () => {
        await up();
        await insert('r-1', 'u-a', 'first-entry');
        await expect(insert('r-2', 'u-a', 'first-entry')).rejects.toThrow(/UNIQUE/i);
    });

    it('allows the same entry for a different person and a different entry for the same person', async () => {
        await up();
        await insert('r-1', 'u-a', 'first-entry');
        await expect(insert('r-2', 'u-b', 'first-entry')).resolves.toBeDefined();
        await expect(insert('r-3', 'u-a', 'second-entry')).resolves.toBeDefined();
        expect(await count()).toBe(3);
    });

    it('cascades read rows away with the person', async () => {
        await up();
        await insert('r-1', 'u-a', 'first-entry');
        await insert('r-2', 'u-b', 'first-entry');
        await dataSource.query(`DELETE FROM "users" WHERE "id" = 'u-a'`);
        const rows: Array<{ userId: string }> = await dataSource.query(
            `SELECT "userId" FROM "product_changelog_reads"`,
        );
        expect(rows).toEqual([{ userId: 'u-b' }]);
    });

    it('is idempotent — a second up() over an applied schema is a no-op', async () => {
        await up();
        await insert('r-1', 'u-a', 'first-entry');
        await up();
        expect(await count()).toBe(1);
    });

    it('down() drops only the table up() created', async () => {
        await up();
        await down();
        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('product_changelog_reads', 'users') ORDER BY name`,
        );
        expect(tables).toEqual([{ name: 'users' }]);
    });

    it('down() is safe on a database where up() never ran', async () => {
        await expect(down()).resolves.toBeUndefined();
    });
});
