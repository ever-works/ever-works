import { DataSource } from 'typeorm';
import { AddToolGrantPresetOwnership1791150100000 } from '../1791150100000-AddToolGrantPresetOwnership';
import { AddConnectionCredentialTransportPolicy1791150200000 } from '../1791150200000-AddConnectionCredentialTransportPolicy';
import { CreateMcpServerConnections1786840000000 } from '../1786840000000-CreateMcpServerConnections';
import { AddMcpConnectionHealth1791150000000 } from '../1791150000000-AddMcpConnectionHealth';

/**
 * AW-15 slots 01 and 02, on the in-memory better-sqlite3 harness the sibling
 * specs use. Asserted against the PHYSICAL tables (`PRAGMA table_info`), and
 * against existing rows: neither migration may change what an existing row
 * means.
 */
describe('AW-15 access-level ownership + credential transport migrations', () => {
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

    describe('AddToolGrantPresetOwnership1791150100000', () => {
        const migration = new AddToolGrantPresetOwnership1791150100000();

        async function createToolGrants(): Promise<void> {
            await dataSource.query(
                `CREATE TABLE "tool_grants" ("id" varchar PRIMARY KEY, "userId" varchar, "scopeType" varchar(16), "scopeId" varchar, "allow" text, "deny" text, "note" text)`,
            );
            await dataSource.query(
                `INSERT INTO "tool_grants" VALUES ('g1','u1','agent','a1',NULL,'["commitToRepo"]','operator deny')`,
            );
        }

        it('adds a nullable presetOwnership column and leaves every existing row untouched', async () => {
            await createToolGrants();
            await withRunner((runner) => migration.up(runner));

            const info: Array<{ name: string; notnull: number }> = await dataSource.query(
                `PRAGMA table_info("tool_grants")`,
            );
            expect(info.find((column) => column.name === 'presetOwnership')?.notnull).toBe(0);

            const [row] = await dataSource.query(`SELECT * FROM "tool_grants" WHERE "id" = 'g1'`);
            // NULL = the access-level control never touched this row, so the
            // operator's commitToRepo deny stays operator-owned.
            expect(row.presetOwnership).toBeNull();
            expect(row.deny).toBe('["commitToRepo"]');
            expect(row.note).toBe('operator deny');
        });

        it('is idempotent, a no-op without the table, and down() removes only its column', async () => {
            await withRunner((runner) => migration.up(runner));
            await createToolGrants();
            const before = await columnNames('tool_grants');

            await withRunner((runner) => migration.up(runner));
            await withRunner((runner) => migration.up(runner));
            await withRunner((runner) => migration.down(runner));

            expect(await columnNames('tool_grants')).toEqual(before);
            expect(await dataSource.query(`SELECT "id" FROM "tool_grants"`)).toHaveLength(1);
        });
    });

    describe('AddConnectionCredentialTransportPolicy1791150200000', () => {
        const migration = new AddConnectionCredentialTransportPolicy1791150200000();

        async function createTables(): Promise<void> {
            await dataSource.query(
                `CREATE TABLE "organizations" ("id" varchar PRIMARY KEY, "tenantId" varchar, "slug" varchar(64), "displayName" varchar(200), "digest_settings" text)`,
            );
            await dataSource.query(
                `INSERT INTO "organizations" VALUES ('o1','t1','acme','Acme',NULL)`,
            );
            await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY)`);
            await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
            await withRunner((runner) => new CreateMcpServerConnections1786840000000().up(runner));
            await withRunner((runner) => new AddMcpConnectionHealth1791150000000().up(runner));
        }

        it('adds organizations.connection_policy as NULL (setting off) for every existing row', async () => {
            await createTables();
            await withRunner((runner) => migration.up(runner));

            const info: Array<{ name: string; notnull: number }> = await dataSource.query(
                `PRAGMA table_info("organizations")`,
            );
            expect(info.find((column) => column.name === 'connection_policy')?.notnull).toBe(0);
            const [org] = await dataSource.query(`SELECT * FROM "organizations"`);
            expect(org.connection_policy).toBeNull();
            expect(org.displayName).toBe('Acme');
        });

        it('lets the insecure_transport warning be stored and leaves existing health values alone', async () => {
            await createTables();
            await dataSource.query(
                `INSERT INTO "mcp_server_connections"
					("id","userId","name","url","transport","enabled","source","authHeaders","createdAt","updatedAt","health")
				 VALUES ('c1','u1','legacy','http://mcp.example.com','streamable-http',1,'manual',NULL,'2026-09-01','2026-09-01','expired')`,
            );
            await withRunner((runner) => migration.up(runner));

            const [preserved] = await dataSource.query(
                `SELECT "health" FROM "mcp_server_connections" WHERE "id" = 'c1'`,
            );
            expect(preserved.health).toBe('expired');

            await dataSource.query(
                `UPDATE "mcp_server_connections" SET "health" = 'insecure_transport' WHERE "id" = 'c1'`,
            );
            const [row] = await dataSource.query(`SELECT "health" FROM "mcp_server_connections"`);
            expect(row.health).toBe('insecure_transport');
        });

        it('is idempotent, a no-op without the tables, and down() removes only its column', async () => {
            await withRunner((runner) => migration.up(runner));
            await createTables();
            const before = await columnNames('organizations');

            await withRunner((runner) => migration.up(runner));
            await withRunner((runner) => migration.up(runner));
            await withRunner((runner) => migration.down(runner));

            expect(await columnNames('organizations')).toEqual(before);
            expect(await dataSource.query(`SELECT "id" FROM "organizations"`)).toHaveLength(1);
        });
    });
});
