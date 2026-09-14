import { DataSource } from 'typeorm';
import { CreateMemoryFacts1791110070000 } from '../1791110070000-CreateMemoryFacts';

/**
 * AW-07 — migration test for `memory_facts`, run against an
 * in-memory better-sqlite3 DataSource (same harness as
 * `CreateReleasePromotions.spec.ts`).
 *
 * The load-bearing assertions are the two CHECK constraints, exercised the
 * way rows actually arrive rather than by reading their definition: an
 * agent-scoped fact without an agent, a workspace-scoped fact WITH one, and
 * an empty or over-long body must all be refused by the database itself,
 * so a service bug can never persist a fact the recall path cannot place.
 *
 * Inserts pass `id` / timestamps explicitly because the table's
 * `uuid_generate_v4()` / `now()` defaults are Postgres functions.
 */
describe('CreateMemoryFacts1791110070000', () => {
    let dataSource: DataSource;
    const migration = new CreateMemoryFacts1791110070000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u-a')`);
        await dataSource.query(`CREATE TABLE "agents" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "agents" ("id") VALUES ('a-1')`);
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

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("memory_facts")`,
        );
        return rows.map((r) => r.name);
    }

    const STAMPS = `'2026-09-14 00:00:00', '2026-09-14 00:00:00'`;

    function insert(
        id: string,
        opts: { scope?: string; agentId?: string | null; body?: string } = {},
    ): Promise<unknown> {
        const scope = opts.scope ?? 'workspace';
        const agentId = opts.agentId ? `'${opts.agentId}'` : 'NULL';
        const body = (opts.body ?? 'We never quote a delivery date under ten days.').replace(
            /'/g,
            "''",
        );
        return dataSource.query(
            `INSERT INTO "memory_facts" ("id", "userId", "scope", "agentId", "body", "status", "origin", "pinned", "recallCount", "createdAt", "updatedAt") VALUES ('${id}', 'u-a', '${scope}', ${agentId}, '${body}', 'active', 'user', 0, 0, ${STAMPS})`,
        );
    }

    it('creates the table with the fact, provenance and vector-coordinate columns', async () => {
        await up();
        expect(await columnNames()).toEqual(
            expect.arrayContaining([
                'id',
                'userId',
                'tenantId',
                'organizationId',
                'scope',
                'agentId',
                'body',
                'status',
                'origin',
                'sourceRunId',
                'sourceConversationId',
                'sourceAgentId',
                'pinned',
                'vectorStoreId',
                'embeddingModel',
                'embeddingDims',
                'embeddedAt',
                'recallCount',
                'lastRecalledAt',
                'supersedesFactId',
                'forgottenAt',
                'createdAt',
                'updatedAt',
            ]),
        );
    });

    it('carries no raw vector column — vectors live behind the vector-store port', async () => {
        await up();
        expect(await columnNames()).not.toContain('embedding');
    });

    it('creates the owner, agent, purge and backfill indexes', async () => {
        await up();
        const rows: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_facts'`,
        );
        expect(rows.map((r) => r.name)).toEqual(
            expect.arrayContaining([
                'idx_memory_facts_owner_status',
                'idx_memory_facts_agent',
                'idx_memory_facts_forgotten_at',
                'idx_memory_facts_embedded_at',
            ]),
        );
    });

    it('accepts a workspace fact and an agent fact that names its agent', async () => {
        await up();
        await expect(insert('f-1')).resolves.toBeDefined();
        await expect(insert('f-2', { scope: 'agent', agentId: 'a-1' })).resolves.toBeDefined();
    });

    it('refuses an agent-scoped fact with no agent', async () => {
        await up();
        await expect(insert('f-1', { scope: 'agent', agentId: null })).rejects.toThrow(/CHECK/i);
    });

    it('refuses a workspace-scoped fact that names an agent', async () => {
        await up();
        await expect(insert('f-1', { scope: 'workspace', agentId: 'a-1' })).rejects.toThrow(
            /CHECK/i,
        );
    });

    it('refuses an empty body and a body over 500 characters', async () => {
        await up();
        await expect(insert('f-1', { body: '' })).rejects.toThrow(/CHECK/i);
        await expect(insert('f-2', { body: 'x'.repeat(501) })).rejects.toThrow(/CHECK/i);
        await expect(insert('f-3', { body: 'x'.repeat(500) })).resolves.toBeDefined();
    });

    it('is idempotent — a second up() over an applied schema is a no-op', async () => {
        await up();
        await insert('f-1');
        await up();
        const rows: Array<{ n: number }> = await dataSource.query(
            `SELECT COUNT(*) AS n FROM "memory_facts"`,
        );
        expect(Number(rows[0].n)).toBe(1);
    });

    it('down() drops the table', async () => {
        await up();
        await down();
        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_facts'`,
        );
        expect(tables).toEqual([]);
    });

    it('down() is safe on a database where up() never ran', async () => {
        await expect(down()).resolves.toBeUndefined();
    });
});
