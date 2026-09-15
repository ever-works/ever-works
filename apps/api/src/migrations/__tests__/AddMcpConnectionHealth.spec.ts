import { DataSource } from 'typeorm';
import { CreateMcpServerConnections1786840000000 } from '../1786840000000-CreateMcpServerConnections';
import { AddMcpConnectionHealth1791150000000 } from '../1791150000000-AddMcpConnectionHealth';

/**
 * Connection health on `mcp_server_connections` (AW-15, slot 00) — run on
 * the in-memory better-sqlite3 harness the sibling specs use, AFTER the
 * migration that creates the table, because this one is an ALTER and
 * asserting it in isolation would prove nothing about the table it lands on.
 *
 * Shape is asserted against the PHYSICAL table (`PRAGMA table_info`).
 */
describe('AddMcpConnectionHealth1791150000000', () => {
    let dataSource: DataSource;
    const base = new CreateMcpServerConnections1786840000000();
    const migration = new AddMcpConnectionHealth1791150000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
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

    const createTable = () => withRunner((runner) => base.up(runner));
    const up = () => withRunner((runner) => migration.up(runner));
    const down = () => withRunner((runner) => migration.down(runner));

    async function columns(): Promise<
        Array<{ name: string; notnull: number; dflt_value: string | null }>
    > {
        return dataSource.query(`PRAGMA table_info("mcp_server_connections")`);
    }

    function insertExistingRow(id = 'c1'): Promise<unknown> {
        return dataSource.query(
            `INSERT INTO "mcp_server_connections"
				("id","userId","name","url","transport","enabled","source","lastError","createdAt","updatedAt")
			 VALUES ('${id}','u1','docs-${id}','https://mcp.example.com','streamable-http',1,'manual','Server unreachable (connection failed).','2026-09-01','2026-09-01')`,
        );
    }

    it('adds the four health columns with safe defaults', async () => {
        await createTable();
        await up();

        const byName = new Map((await columns()).map((column) => [column.name, column]));
        expect(byName.get('health')?.notnull).toBe(1);
        expect(byName.get('health')?.dflt_value).toBe("'unknown'");
        expect(byName.get('healthCheckedAt')?.notnull).toBe(0);
        expect(byName.get('healthFailureCount')?.notnull).toBe(1);
        expect(String(byName.get('healthFailureCount')?.dflt_value)).toBe('0');
        expect(byName.get('lastErrorCode')?.notnull).toBe(0);
    });

    it('backfills existing rows to "not checked yet" and keeps their data', async () => {
        await createTable();
        await insertExistingRow();
        await up();

        const [row] = await dataSource.query(
            `SELECT * FROM "mcp_server_connections" WHERE "id" = 'c1'`,
        );
        expect(row.health).toBe('unknown');
        expect(row.healthCheckedAt).toBeNull();
        expect(row.healthFailureCount).toBe(0);
        expect(row.lastErrorCode).toBeNull();
        // Nothing that existed before is touched.
        expect(row.name).toBe('docs-c1');
        expect(row.lastError).toBe('Server unreachable (connection failed).');
    });

    it('is idempotent — a second up() adds nothing and does not throw', async () => {
        await createTable();
        await up();
        const before = (await columns()).length;
        await up();
        expect((await columns()).length).toBe(before);
    });

    it('is a no-op when the table does not exist', async () => {
        await expect(up()).resolves.toBeUndefined();
    });

    it('down() removes exactly the columns up() added and keeps the rows', async () => {
        await createTable();
        const original = (await columns()).map((column) => column.name).sort();
        await insertExistingRow();
        await up();
        await down();

        expect((await columns()).map((column) => column.name).sort()).toEqual(original);
        const rows = await dataSource.query(`SELECT "id" FROM "mcp_server_connections"`);
        expect(rows).toHaveLength(1);
    });
});
