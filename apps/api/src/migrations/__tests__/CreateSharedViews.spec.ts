import { DataSource } from 'typeorm';
import { CreateSharedViews1791180000000 } from '../1791180000000-CreateSharedViews';

/**
 * Shared view (AW-18) — migration test for `shared_views`, run against an
 * in-memory better-sqlite3 DataSource (same harness as the sibling
 * migration specs).
 *
 * What matters:
 *  - at most one Shared view per Workspace (unique `organizationId`);
 *  - a token hash can resolve to exactly one view (unique `tokenHash`);
 *  - deleting the Workspace deletes its link (FK cascade) — the "same
 *    transaction" guarantee;
 *  - a new row starts with crawlers blocked, the link active and zero views;
 *  - `up()` is idempotent and `down()` drops only what `up()` created.
 *
 * Inserts pass `id` explicitly: `uuid_generate_v4()` is a Postgres function
 * and sqlite is only a DDL harness here.
 */
describe('CreateSharedViews1791180000000', () => {
    let dataSource: DataSource;
    const migration = new CreateSharedViews1791180000000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`PRAGMA foreign_keys = ON`);
        for (const table of ['users', 'organizations']) {
            await dataSource.query(`CREATE TABLE "${table}" ("id" varchar PRIMARY KEY NOT NULL)`);
        }
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
        await dataSource.query(`INSERT INTO "organizations" ("id") VALUES ('o1'), ('o2')`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    function insert(id: string, organizationId: string, tokenHash: string): Promise<unknown> {
        return dataSource.query(
            `INSERT INTO "shared_views"
                ("id", "organizationId", "tenantId", "ownerUserId", "tokenHash", "tokenEncrypted",
                 "sections", "knowledgeClasses", "createdById")
             VALUES ('${id}', '${organizationId}', 't1', 'u1', '${tokenHash}', '{}',
                 '{"board":true,"knowledge":false}', '[]', 'u1')`,
        );
    }

    async function rows(): Promise<Array<Record<string, unknown>>> {
        return dataSource.query(`SELECT * FROM "shared_views" ORDER BY "id"`);
    }

    it('creates the table with exactly the declared columns', async () => {
        await run('up');
        const columns: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("shared_views")`,
        );
        expect(columns.map((column) => column.name).sort()).toEqual(
            [
                'createdAt',
                'createdById',
                'firstViewNotifiedAt',
                'id',
                'knowledgeClasses',
                'lastViewedAt',
                'organizationId',
                'ownerUserId',
                'rotationCount',
                'searchIndexable',
                'sections',
                'status',
                'tenantId',
                'tokenEncrypted',
                'tokenHash',
                'tokenRotatedAt',
                'updatedAt',
                'viewCount',
            ].sort(),
        );
    });

    it('starts a row active, blocked from crawlers, unviewed and never rotated', async () => {
        await run('up');
        await insert('v1', 'o1', 'a'.repeat(64));
        const [row] = await rows();
        expect(row.status).toBe('active');
        expect(Number(row.searchIndexable)).toBe(0);
        expect(Number(row.viewCount)).toBe(0);
        expect(Number(row.rotationCount)).toBe(0);
        expect(row.lastViewedAt).toBeNull();
        expect(row.tokenRotatedAt).toBeNull();
        expect(row.firstViewNotifiedAt).toBeNull();
    });

    it('refuses a second Shared view for the same Workspace', async () => {
        await run('up');
        await insert('v1', 'o1', 'a'.repeat(64));
        await expect(insert('v2', 'o1', 'b'.repeat(64))).rejects.toThrow(/UNIQUE/i);
    });

    it('refuses a token hash that already resolves to another view', async () => {
        await run('up');
        await insert('v1', 'o1', 'a'.repeat(64));
        await expect(insert('v2', 'o2', 'a'.repeat(64))).rejects.toThrow(/UNIQUE/i);
    });

    it('deletes the Shared view with its Workspace', async () => {
        await run('up');
        await insert('v1', 'o1', 'a'.repeat(64));
        await insert('v2', 'o2', 'b'.repeat(64));
        await dataSource.query(`DELETE FROM "organizations" WHERE "id" = 'o1'`);
        expect((await rows()).map((row) => row.id)).toEqual(['v2']);
    });

    it('is idempotent — a second up() over an applied schema is a no-op', async () => {
        await run('up');
        await insert('v1', 'o1', 'a'.repeat(64));
        await run('up');
        expect(await rows()).toHaveLength(1);
        const indexes: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("shared_views")`,
        );
        const names = indexes.map((index) => index.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'uq_shared_views_organization',
                'uq_shared_views_token_hash',
                'idx_shared_views_tenant',
            ]),
        );
    });

    it('down() drops only the table up() created', async () => {
        await run('up');
        await run('down');
        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('shared_views', 'users', 'organizations') ORDER BY name`,
        );
        expect(tables.map((table) => table.name)).toEqual(['organizations', 'users']);
    });

    it('down() is safe on a database where up() never ran', async () => {
        await expect(run('down')).resolves.toBeUndefined();
    });

    describe('ownership — a table this migration did not create', () => {
        /** A stranger that happens to be called `shared_views`, carrying a row. */
        const createForeignTable = async () => {
            await dataSource.query(
                `CREATE TABLE "shared_views" ("id" varchar PRIMARY KEY NOT NULL, "note" varchar)`,
            );
            await dataSource.query(
                `INSERT INTO "shared_views" ("id", "note") VALUES ('x1', 'keep')`,
            );
        };

        it('up() refuses to adopt it instead of bolting the indexes and cascades on', async () => {
            await createForeignTable();

            await expect(run('up')).rejects.toThrow(/shared_views/);

            const indexes: Array<{ name: string }> = await dataSource.query(
                `PRAGMA index_list("shared_views")`,
            );
            expect(indexes.map((index) => index.name)).not.toContain('uq_shared_views_token_hash');
            expect(await dataSource.query(`SELECT * FROM "shared_views"`)).toHaveLength(1);
        });

        it('down() leaves it — and its rows — alone', async () => {
            await createForeignTable();

            await expect(run('down')).resolves.toBeUndefined();

            const rows: Array<{ id: string; note: string }> = await dataSource.query(
                `SELECT * FROM "shared_views"`,
            );
            expect(rows).toEqual([{ id: 'x1', note: 'keep' }]);
        });

        /**
         * A stranger called `shared_views` that carries every column name this
         * migration declares — the case a shape check alone cannot tell from
         * the `synchronize()`-built table, and the one where a naive `down()`
         * would drop somebody else's rows.
         */
        const createShapeMatchingForeignTable = async () => {
            await dataSource.query(
                `CREATE TABLE "shared_views" (
                    "id" varchar PRIMARY KEY NOT NULL,
                    "organizationId" varchar NOT NULL,
                    "tenantId" varchar NOT NULL,
                    "ownerUserId" varchar NOT NULL,
                    "tokenHash" varchar NOT NULL,
                    "tokenEncrypted" text NOT NULL,
                    "status" varchar NOT NULL DEFAULT ('active'),
                    "sections" text NOT NULL,
                    "knowledgeClasses" text NOT NULL,
                    "searchIndexable" boolean NOT NULL DEFAULT (0),
                    "viewCount" integer NOT NULL DEFAULT (0),
                    "lastViewedAt" datetime,
                    "firstViewNotifiedAt" datetime,
                    "tokenRotatedAt" datetime,
                    "rotationCount" integer NOT NULL DEFAULT (0),
                    "createdById" varchar NOT NULL,
                    "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    "note" varchar
                )`,
            );
            await insert('x1', 'o1', 'c'.repeat(64));
            await dataSource.query(`UPDATE "shared_views" SET "note" = 'keep' WHERE "id" = 'x1'`);
        };

        const indexNames = async (): Promise<string[]> => {
            const indexes: Array<{ name: string }> = await dataSource.query(
                `PRAGMA index_list("shared_views")`,
            );
            return indexes.map((index) => index.name);
        };

        it('up() stamps the table it creates, so down() can prove it owns it', async () => {
            await run('up');

            expect(await indexNames()).toContain('idx_shared_views_owned_1791180000000');
        });

        it('up() adopts a shape-matching stranger without stamping it', async () => {
            await createShapeMatchingForeignTable();

            await expect(run('up')).resolves.toBeUndefined();

            const names = await indexNames();
            expect(names).toEqual(
                expect.arrayContaining([
                    'uq_shared_views_organization',
                    'uq_shared_views_token_hash',
                    'idx_shared_views_tenant',
                ]),
            );
            expect(names).not.toContain('idx_shared_views_owned_1791180000000');
        });

        it('down() keeps a shape-matching stranger and its rows, reverting only what up() added', async () => {
            await createShapeMatchingForeignTable();
            await run('up');

            await expect(run('down')).resolves.toBeUndefined();

            const tables: Array<{ name: string }> = await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shared_views'`,
            );
            expect(tables.map((table) => table.name)).toEqual(['shared_views']);

            const surviving: Array<{ id: string; note: string }> = await dataSource.query(
                `SELECT "id", "note" FROM "shared_views"`,
            );
            expect(surviving).toEqual([{ id: 'x1', note: 'keep' }]);

            const names = await indexNames();
            for (const dropped of [
                'uq_shared_views_organization',
                'uq_shared_views_token_hash',
                'idx_shared_views_tenant',
            ]) {
                expect(names).not.toContain(dropped);
            }
            expect(await dataSource.query(`PRAGMA foreign_key_list("shared_views")`)).toEqual([]);
        });

        it('up() still adopts a table that carries the declared shape', async () => {
            // The `synchronize()` path builds `shared_views` from the entity
            // before this migration ever runs; adopting it must keep working.
            await run('up');
            await dataSource.query(`DROP INDEX "uq_shared_views_token_hash"`);
            await insert('v1', 'o1', 'a'.repeat(64));

            await expect(run('up')).resolves.toBeUndefined();

            const indexes: Array<{ name: string }> = await dataSource.query(
                `PRAGMA index_list("shared_views")`,
            );
            expect(indexes.map((index) => index.name)).toContain('uq_shared_views_token_hash');
            expect(await rows()).toHaveLength(1);
        });
    });
});
