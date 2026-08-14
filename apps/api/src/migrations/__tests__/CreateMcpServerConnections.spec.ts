import { DataSource } from 'typeorm';
import { CreateMcpServerConnections1785100000000 } from '../1785100000000-CreateMcpServerConnections';

/**
 * Migration test for the Agent Plugins MCP slice tables
 * (`mcp_server_connections` + `agent_mcp_server_bindings`).
 *
 * Runs on the same in-memory better-sqlite3 harness the sibling specs
 * use — production is Postgres, CI/e2e are sqlite, so a migration
 * written with raw Postgres-only DDL would pass in prod and fail every
 * CI run. TypeORM's portable Table API is what makes both work, and
 * this spec is what proves it.
 *
 * The migration declares FKs to `users`, and TypeORM turns the sqlite
 * `foreign_keys` pragma ON — so the harness creates a stub `users`
 * table before inserting rows.
 */
describe('CreateMcpServerConnections1785100000000', () => {
	let dataSource: DataSource;
	const migration = new CreateMcpServerConnections1785100000000();

	beforeEach(async () => {
		dataSource = new DataSource({
			type: 'better-sqlite3',
			database: ':memory:',
			entities: [],
			synchronize: false
		});
		await dataSource.initialize();
		// Stub referenced table so FK-checked inserts work under sqlite.
		await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY)`);
		await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
	});

	afterEach(async () => {
		if (dataSource?.isInitialized) await dataSource.destroy();
	});

	it('creates both tables with every expected column', async () => {
		const runner = dataSource.createQueryRunner();
		await migration.up(runner);

		const connections = await runner.getTable('mcp_server_connections');
		expect(connections).toBeDefined();
		for (const column of [
			'id',
			'userId',
			'name',
			'url',
			'transport',
			'authHeaders',
			'enabled',
			'source',
			'lastConnectedAt',
			'lastError',
			'tenantId',
			'organizationId',
			'createdAt',
			'updatedAt'
		]) {
			expect(connections?.findColumnByName(column)).toBeDefined();
		}

		const bindings = await runner.getTable('agent_mcp_server_bindings');
		expect(bindings).toBeDefined();
		for (const column of [
			'id',
			'connectionId',
			'targetType',
			'targetId',
			'userId',
			'enabled',
			'tenantId',
			'organizationId',
			'createdAt'
		]) {
			expect(bindings?.findColumnByName(column)).toBeDefined();
		}

		await runner.release();
	});

	it('creates the unique + lookup indexes', async () => {
		const runner = dataSource.createQueryRunner();
		await migration.up(runner);

		const connections = await runner.getTable('mcp_server_connections');
		const bindings = await runner.getTable('agent_mcp_server_bindings');
		const names = (table: typeof connections) => table?.indices.map((idx) => idx.name) ?? [];

		expect(names(connections)).toEqual(
			expect.arrayContaining(['uq_mcp_connection_user_name', 'idx_mcp_connection_user'])
		);
		expect(names(bindings)).toEqual(
			expect.arrayContaining(['uq_mcp_binding', 'idx_mcp_binding_target', 'idx_mcp_binding_user'])
		);
		expect(connections?.indices.find((idx) => idx.name === 'uq_mcp_connection_user_name')?.isUnique).toBe(true);
		expect(bindings?.indices.find((idx) => idx.name === 'uq_mcp_binding')?.isUnique).toBe(true);

		await runner.release();
	});

	it('is idempotent — a second up() does not throw', async () => {
		const runner = dataSource.createQueryRunner();
		await migration.up(runner);
		await expect(migration.up(runner)).resolves.not.toThrow();
		await runner.release();
	});

	// NOTE: raw inserts supply createdAt/updatedAt explicitly. The columns
	// default to `now()`, which Postgres has and sqlite does not — harmless
	// because every real insert goes through TypeORM, whose @CreateDateColumn
	// supplies the value from the ORM side.
	it('enforces unique (userId, name) on connections', async () => {
		const runner = dataSource.createQueryRunner();
		await migration.up(runner);

		const insert = (id: string, name: string) =>
			dataSource.query(
				`INSERT INTO "mcp_server_connections"
					("id","userId","name","url","transport","enabled","source","createdAt","updatedAt")
				 VALUES ('${id}','u1','${name}','https://mcp.example.com','streamable-http',1,'manual','2026-08-14','2026-08-14')`
			);

		await expect(insert('c1', 'github')).resolves.not.toThrow();
		await expect(insert('c2', 'github')).rejects.toThrow();
		await expect(insert('c3', 'linear')).resolves.not.toThrow();

		await runner.release();
	});

	it('enforces unique (connectionId, targetType, targetId) on bindings', async () => {
		const runner = dataSource.createQueryRunner();
		await migration.up(runner);

		await dataSource.query(
			`INSERT INTO "mcp_server_connections"
				("id","userId","name","url","transport","enabled","source","createdAt","updatedAt")
			 VALUES ('c1','u1','github','https://mcp.example.com','streamable-http',1,'manual','2026-08-14','2026-08-14')`
		);
		const insert = (id: string, targetType: string, targetId: string | null) =>
			dataSource.query(
				`INSERT INTO "agent_mcp_server_bindings"
					("id","connectionId","targetType","targetId","userId","enabled","createdAt")
				 VALUES ('${id}','c1','${targetType}',${targetId === null ? 'NULL' : `'${targetId}'`},'u1',1,'2026-08-14')`
			);

		await expect(insert('b1', 'tenant', null)).resolves.not.toThrow();
		await expect(insert('b2', 'agent', 'a1')).resolves.not.toThrow();
		await expect(insert('b3', 'agent', 'a1')).rejects.toThrow();

		await runner.release();
	});

	it('down() drops both tables', async () => {
		const runner = dataSource.createQueryRunner();
		await migration.up(runner);
		await migration.down(runner);

		expect(await runner.hasTable('agent_mcp_server_bindings')).toBe(false);
		expect(await runner.hasTable('mcp_server_connections')).toBe(false);

		await runner.release();
	});
});
