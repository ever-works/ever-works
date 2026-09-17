import { DataSource } from 'typeorm';
import { AddAgentLane1791200000000 } from '../1791200000000-AddAgentLane';
import { CreateOnboardingChecklists1791200100000 } from '../1791200100000-CreateOnboardingChecklists';

/**
 * AW-20 slots 00 and 01, on the in-memory better-sqlite3 harness the
 * sibling migration specs use. Asserted against the PHYSICAL tables
 * (`PRAGMA table_info`) and against existing rows: neither migration may
 * change what an existing row means.
 */
describe('AW-20 roster migrations', () => {
    let dataSource: DataSource;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function withRunner(
        action: (runner: ReturnType<DataSource['createQueryRunner']>) => Promise<void>,
    ): Promise<void> {
        const runner = dataSource.createQueryRunner();
        try {
            await action(runner);
        } finally {
            await runner.release();
        }
    }

    async function columnNames(table: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return rows.map((row) => row.name).sort();
    }

    describe('AddAgentLane1791200000000', () => {
        const migration = new AddAgentLane1791200000000();

        /** Named columns, because `up()` widens the table under the test. */
        function insertAgent(
            id: string,
            userId: string,
            name: string,
            lane: string | null = null,
        ): Promise<unknown> {
            return dataSource.query(
                `INSERT INTO "agents" ("id","userId","name","slug","lane") VALUES ('${id}','${userId}','${name}','${name.toLowerCase().replace(/ /g, '-')}',${
                    lane === null ? 'NULL' : `'${lane}'`
                })`,
            );
        }

        async function createAgents(): Promise<void> {
            await dataSource.query(
                `CREATE TABLE "agents" ("id" varchar PRIMARY KEY, "userId" varchar, "name" varchar, "slug" varchar)`,
            );
            await dataSource.query(`INSERT INTO "agents" VALUES ('a1','u1','Research','research')`);
        }

        it('adds a nullable lane column and leaves every existing row untouched', async () => {
            await createAgents();

            await withRunner((runner) => migration.up(runner));

            expect(await columnNames('agents')).toContain('lane');
            const rows = await dataSource.query(`SELECT * FROM "agents"`);
            expect(rows).toHaveLength(1);
            // No backfill: an Agent that existed before this migration has
            // no lane and behaves exactly as it did.
            expect(rows[0].lane).toBeNull();
            expect(rows[0].name).toBe('Research');
        });

        it('lets many agents of one user stay laneless (the index is partial)', async () => {
            await createAgents();
            await withRunner((runner) => migration.up(runner));

            await insertAgent('a2', 'u1', 'Content');
            await insertAgent('a3', 'u1', 'Social');

            const rows = await dataSource.query(
                `SELECT COUNT(*) AS n FROM "agents" WHERE "lane" IS NULL`,
            );
            expect(Number(rows[0].n)).toBe(3);
        });

        it('refuses a second agent of the same user in the same lane', async () => {
            await createAgents();
            await withRunner((runner) => migration.up(runner));

            await dataSource.query(`UPDATE "agents" SET "lane" = 'research' WHERE "id" = 'a1'`);
            await expect(insertAgent('a2', 'u1', 'Research 2', 'research')).rejects.toThrow();
        });

        it('lets two different users each hold the same lane', async () => {
            await createAgents();
            await withRunner((runner) => migration.up(runner));

            await dataSource.query(`UPDATE "agents" SET "lane" = 'research' WHERE "id" = 'a1'`);
            await insertAgent('a2', 'u2', 'Research', 'research');

            const rows = await dataSource.query(
                `SELECT COUNT(*) AS n FROM "agents" WHERE "lane" = 'research'`,
            );
            expect(Number(rows[0].n)).toBe(2);
        });

        it('is a no-op on a second run and removes only what it added on down', async () => {
            await createAgents();

            await withRunner((runner) => migration.up(runner));
            await withRunner((runner) => migration.up(runner));
            expect(await columnNames('agents')).toContain('lane');

            await withRunner((runner) => migration.down(runner));
            expect(await columnNames('agents')).not.toContain('lane');
            expect(await columnNames('agents')).toEqual(['id', 'name', 'slug', 'userId']);
        });
    });

    describe('CreateOnboardingChecklists1791200100000', () => {
        const migration = new CreateOnboardingChecklists1791200100000();

        /**
         * `now()` is a Postgres default the sqlite DDL harness cannot
         * evaluate, so the timestamps are supplied — the same workaround
         * the `CreateProductChangelogReads` spec uses.
         */
        function insertChecklist(id: string, scopeKey: string): Promise<unknown> {
            return dataSource.query(
                `INSERT INTO "onboarding_checklists" ("id","userId","organizationId","scopeKey","milestones","createdAt","updatedAt") ` +
                    `VALUES ('${id}','u1',NULL,'${scopeKey}','{}','2026-09-16 00:00:00','2026-09-16 00:00:00')`,
            );
        }

        async function createUsers(): Promise<void> {
            await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY)`);
            await dataSource.query(`INSERT INTO "users" VALUES ('u1')`);
        }

        it('creates the table with every column the entity declares', async () => {
            await createUsers();

            await withRunner((runner) => migration.up(runner));

            expect(await columnNames('onboarding_checklists')).toEqual([
                'completedAt',
                'createdAt',
                'dismissedAt',
                'evaluatedAt',
                'hiddenAt',
                'id',
                'milestones',
                'organizationId',
                'provisioning',
                'rosterAcknowledgedAt',
                'scopeKey',
                'updatedAt',
                'userId',
            ]);
        });

        it('allows one row per person per workspace scope, and no more', async () => {
            await createUsers();
            await withRunner((runner) => migration.up(runner));

            const insert = (id: string, scopeKey: string) => insertChecklist(id, scopeKey);

            await insert('c1', 'personal');
            await insert('c2', 'org-1');
            // Personal scope stores NULL in `organizationId`, and SQL treats
            // NULLs as distinct — `scopeKey` is what makes the uniqueness
            // rule actually hold.
            await expect(insert('c3', 'personal')).rejects.toThrow();
        });

        it('takes a checklist with the account it belongs to', async () => {
            await createUsers();
            await withRunner((runner) => migration.up(runner));
            await dataSource.query(`PRAGMA foreign_keys = ON`);
            await insertChecklist('c1', 'personal');

            await dataSource.query(`DELETE FROM "users" WHERE "id" = 'u1'`);

            const rows = await dataSource.query(
                `SELECT COUNT(*) AS n FROM "onboarding_checklists"`,
            );
            expect(Number(rows[0].n)).toBe(0);
        });

        it('is a no-op on a second run and drops only its own table on down', async () => {
            await createUsers();

            await withRunner((runner) => migration.up(runner));
            await withRunner((runner) => migration.up(runner));

            await withRunner((runner) => migration.down(runner));
            const tables = await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'table'`,
            );
            expect(tables.map((row: { name: string }) => row.name)).toContain('users');
            expect(tables.map((row: { name: string }) => row.name)).not.toContain(
                'onboarding_checklists',
            );
        });
    });
});
