import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { CreateAppLauncherPreferences1792110000000 } from '../1792110000000-CreateAppLauncherPreferences';

/**
 * APW-11 T3 — the migration test for `1792110000000-CreateAppLauncherPreferences`,
 * run against an in-memory better-sqlite3 DataSource (the same harness as the
 * sibling migration specs).
 *
 * Spec FR-19 (`spec.md:259-261`) for the column, FR-24/FR-25/FR-28
 * (`spec.md:285-295`) for the table; plan §3.1 (`plan.md:194-203`), §3.2
 * (`plan.md:205-222`) and §3.4 (`plan.md:338-347`) for the DDL. The task's own
 * clauses: no `DROP COLUMN` or rename of a pre-existing column in `up()`;
 * `down()` drops exactly the column, table and index `up()` created; and on
 * SQLite an existing Work reads `appLauncherExposed = NULL` after `up()`.
 *
 * Inserts pass `id` explicitly: `uuid_generate_v4()` is a Postgres function and
 * sqlite is only a DDL harness here.
 */
describe('CreateAppLauncherPreferences1792110000000', () => {
    let dataSource: DataSource;
    const migration = new CreateAppLauncherPreferences1792110000000();

    /** The `up()` half of the file, so the source scan cannot see `down()`. */
    const source = readFileSync(
        join(__dirname, '..', '1792110000000-CreateAppLauncherPreferences.ts'),
        'utf8',
    );
    const upSource = source.slice(0, source.indexOf('public async down('));
    const downSource = source.slice(source.indexOf('public async down('));

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
        await dataSource.query(
            `CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "tenantId" varchar)`,
        );
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1'), ('u2')`);
        await dataSource.query(
            `CREATE TABLE "works" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "status" varchar NOT NULL)`,
        );
        await dataSource.query(
            `INSERT INTO "works" ("id", "name", "status") VALUES ('w1', 'A Work that predates this epic', 'active')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function columnsOf(
        table: string,
    ): Promise<Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>> {
        return dataSource.query(`PRAGMA table_info("${table}")`);
    }

    async function indexNames(table: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}'`,
        );
        return rows.map((row) => row.name);
    }

    async function tableNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        return rows.map((row) => row.name);
    }

    function insertPreference(id: string, userId = 'u1', scopeKey = 'global'): Promise<unknown> {
        return dataSource.query(
            `INSERT INTO "app_launcher_preferences"
                ("id", "userId", "scopeKey", "itemKey", "visible", "pinned")
             VALUES ('${id}', '${userId}', '${scopeKey}', 'platform:ever-gauzy', 1, 0)`,
        );
    }

    describe('the works column', () => {
        it('adds appLauncherExposed as a nullable boolean with no default', async () => {
            await run('up');

            const column = (await columnsOf('works')).find(
                (entry) => entry.name === 'appLauncherExposed',
            );

            expect(column).toBeDefined();
            expect(column?.type).toBe('boolean');
            expect(column?.notnull).toBe(0);
            // No DEFAULT: `NULL` is FR-19's "no explicit choice", and a default
            // would collapse that third state into a choice nobody made.
            expect(column?.dflt_value ?? null).toBeNull();
        });

        it('leaves an existing Work reading NULL — no data migration (FR-19, ACC-11-09)', async () => {
            await run('up');

            const [work] = await dataSource.query(
                `SELECT "id", "name", "status", "appLauncherExposed" FROM "works" WHERE "id" = 'w1'`,
            );

            expect(work.name).toBe('A Work that predates this epic');
            expect(work.status).toBe('active');
            expect(work.appLauncherExposed).toBeNull();
        });

        it('does not touch any pre-existing works column', async () => {
            const before = (await columnsOf('works')).map((entry) => entry.name).sort();
            await run('up');
            const after = (await columnsOf('works')).map((entry) => entry.name).sort();

            expect(after).toEqual([...before, 'appLauncherExposed'].sort());
        });
    });

    describe('the app_launcher_preferences table', () => {
        it('creates the table with exactly the declared columns', async () => {
            await run('up');

            expect(await tableNames()).toContain('app_launcher_preferences');
            expect(
                (await columnsOf('app_launcher_preferences')).map((entry) => entry.name).sort(),
            ).toEqual(
                [
                    'createdAt',
                    'id',
                    'itemKey',
                    'pinOrder',
                    'pinned',
                    'scopeKey',
                    'sortOrder',
                    'updatedAt',
                    'userId',
                    'visible',
                ].sort(),
            );
        });

        it('declares the scope and item keys NOT NULL at the documented widths (plan §3.2:211-212)', async () => {
            await run('up');
            const columns = await columnsOf('app_launcher_preferences');
            const find = (name: string) => columns.find((entry) => entry.name === name);

            expect(find('scopeKey')?.type).toBe('varchar(40)');
            expect(find('scopeKey')?.notnull).toBe(1);
            expect(find('itemKey')?.type).toBe('varchar(64)');
            expect(find('itemKey')?.notnull).toBe(1);
            expect(find('userId')?.notnull).toBe(1);
        });

        it('declares visible and pinned NOT NULL with the documented defaults', async () => {
            await run('up');
            const columns = await columnsOf('app_launcher_preferences');
            const find = (name: string) => columns.find((entry) => entry.name === name);

            expect(find('visible')?.notnull).toBe(1);
            // The driver may spell a boolean default `true` or `1`; the value is
            // what matters.
            expect(String(find('visible')?.dflt_value).toLowerCase()).toBe('true');
            expect(find('pinned')?.notnull).toBe(1);
            expect(String(find('pinned')?.dflt_value).toLowerCase()).toBe('false');
        });

        it("declares the two order columns nullable with the plan's types", async () => {
            await run('up');
            const columns = await columnsOf('app_launcher_preferences');
            const find = (name: string) => columns.find((entry) => entry.name === name);

            expect(String(find('pinOrder')?.type).toLowerCase()).toBe('smallint');
            expect(find('pinOrder')?.notnull).toBe(0);
            expect(String(find('sortOrder')?.type).toLowerCase()).toBe('integer');
            expect(find('sortOrder')?.notnull).toBe(0);
        });

        it('creates the (userId, scopeKey) read index under the name T2 declares', async () => {
            await run('up');

            expect(await indexNames('app_launcher_preferences')).toContain(
                'idx_app_launcher_prefs_user_scope',
            );
        });

        it('enforces one row per (userId, scopeKey, itemKey)', async () => {
            await run('up');
            await insertPreference('p1');

            await expect(insertPreference('p2')).rejects.toThrow();

            const stored: unknown[] = await dataSource.query(
                `SELECT * FROM "app_launcher_preferences"`,
            );
            expect(stored).toHaveLength(1);
        });

        it('allows the same item in a different scope, and the same scope for another person', async () => {
            await run('up');
            await insertPreference('p1', 'u1', 'global');
            await insertPreference('p2', 'u1', 'personal');
            await insertPreference('p3', 'u2', 'global');

            const stored: unknown[] = await dataSource.query(
                `SELECT * FROM "app_launcher_preferences"`,
            );
            expect(stored).toHaveLength(3);
        });

        it("cascades a person's arrangement away with the account", async () => {
            await run('up');
            await insertPreference('p1', 'u1', 'global');
            await insertPreference('p2', 'u2', 'global');

            await dataSource.query(`DELETE FROM "users" WHERE "id" = 'u1'`);

            const stored: Array<{ id: string }> = await dataSource.query(
                `SELECT "id" FROM "app_launcher_preferences" ORDER BY "id"`,
            );
            expect(stored.map((row) => row.id)).toEqual(['p2']);
        });

        it('defaults a row inserted without visible or pinned to shown and not pinned', async () => {
            await run('up');
            await dataSource.query(
                `INSERT INTO "app_launcher_preferences"
                    ("id", "userId", "scopeKey", "itemKey")
                 VALUES ('p1', 'u1', 'global', 'platform:ever-gauzy')`,
            );

            const [row] = await dataSource.query(`SELECT * FROM "app_launcher_preferences"`);
            expect(Number(row.visible)).toBe(1);
            expect(Number(row.pinned)).toBe(0);
            expect(row.pinOrder).toBeNull();
            expect(row.sortOrder).toBeNull();
            expect(row.createdAt).toBeTruthy();
            expect(row.updatedAt).toBeTruthy();
        });
    });

    describe('up() is additive and idempotent', () => {
        it('never drops or renames a pre-existing column in up()', async () => {
            // Read from the source rather than inferred from the result: a
            // `DROP COLUMN` that happened to be a no-op on this fixture is still
            // a removal, which CONTRACTS R-26 forbids outright.
            expect(upSource).not.toMatch(/DROP\s+COLUMN/i);
            expect(upSource).not.toMatch(/RENAME\s+COLUMN|RENAME\s+TO|renameColumn/i);
            expect(upSource).not.toMatch(/dropTable|dropColumn|dropIndex/i);
            // One ADD COLUMN, one CREATE TABLE — nothing else structural.
            expect(upSource).toMatch(/addColumn\(/);
            expect(upSource).toMatch(/createTable\(/);
        });

        it('is idempotent — a second up() over an applied schema is a no-op', async () => {
            await run('up');
            await insertPreference('p1');
            await run('up');

            expect(
                (await columnsOf('works')).filter((c) => c.name === 'appLauncherExposed'),
            ).toHaveLength(1);
            const stored: unknown[] = await dataSource.query(
                `SELECT * FROM "app_launcher_preferences"`,
            );
            expect(stored).toHaveLength(1);
        });

        it('migrates a database where works does not exist yet, without inventing it', async () => {
            await dataSource.query(`DROP TABLE "works"`);

            await expect(run('up')).resolves.toBeUndefined();
            expect(await tableNames()).toContain('app_launcher_preferences');
            expect(await tableNames()).not.toContain('works');
        });
    });

    describe('down()', () => {
        it('drops the column, the table and the index that up() created', async () => {
            await run('up');
            await insertPreference('p1');
            await run('down');

            expect(await tableNames()).not.toContain('app_launcher_preferences');
            expect(await indexNames('app_launcher_preferences')).toEqual([]);
            expect((await columnsOf('works')).map((entry) => entry.name)).not.toContain(
                'appLauncherExposed',
            );
        });

        it('leaves everything that existed before it untouched', async () => {
            await run('up');
            await insertPreference('p1');
            await run('down');

            expect((await columnsOf('works')).map((entry) => entry.name).sort()).toEqual([
                'id',
                'name',
                'status',
            ]);
            expect(await dataSource.query(`SELECT * FROM "works" ORDER BY "id"`)).toHaveLength(1);
            expect(await dataSource.query(`SELECT * FROM "users" ORDER BY "id"`)).toHaveLength(2);
        });

        it('drops exactly the column, table and index up() created, in the source too', async () => {
            expect(downSource).toMatch(/dropTable\(/);
            expect(downSource).toMatch(/dropColumn\(/);
            expect(downSource).not.toMatch(/DROP\s+COLUMN/i);
            expect(downSource).toMatch(/'works'/);
        });

        it('is safe on a database where up() never ran', async () => {
            await expect(run('down')).resolves.toBeUndefined();
            expect(await tableNames()).toContain('works');
        });
    });
});
