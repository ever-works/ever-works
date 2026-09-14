import { DataSource } from 'typeorm';
import { CreateVectorNamespaceChunks1791110080000 } from '../1791110080000-CreateVectorNamespaceChunks';

/**
 * AW-07 — migration test for `vector_namespace_chunks`, run against an
 * in-memory better-sqlite3 DataSource (same harness as
 * `CreateMemoryFacts.spec.ts`).
 *
 * Load-bearing assertions:
 *  - the table accepts a chunk whose namespace is NOT a Work and whose
 *    document is NOT a KB document — the whole reason it exists (no FKs);
 *  - the composite primary key is `(namespace_id, id)`: the same chunk id may
 *    exist in two namespaces, but never twice in one;
 *  - `work_knowledge_chunks` is not touched by up or down.
 *
 * The Postgres-only half (`vector(1536)` + the ivfflat index) cannot run on
 * SQLite; the `postgres` branch is asserted against a recording query runner.
 */
describe('CreateVectorNamespaceChunks1791110080000', () => {
    let dataSource: DataSource;
    const migration = new CreateVectorNamespaceChunks1791110080000();

    const NS_A = 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb';
    const NS_B = 'cccccccc-cccc-5ccc-8ccc-cccccccccccc';
    const DOC = '11111111-1111-4111-8111-111111111111';

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        // A stand-in for the Knowledge Base table the migration must not touch.
        await dataSource.query(
            `CREATE TABLE "work_knowledge_chunks" ("id" varchar NOT NULL, "work_id" varchar NOT NULL, PRIMARY KEY ("work_id","id"))`,
        );
        await dataSource.query(`INSERT INTO "work_knowledge_chunks" VALUES ('c-1', 'w-1')`);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    async function run(direction: 'up' | 'down'): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    }

    function insert(namespaceId: string, id: string): Promise<unknown> {
        return dataSource.query(
            `INSERT INTO "vector_namespace_chunks" ("id", "namespace_id", "document_id", "chunk_index", "content", "embedding", "token_count", "metadata", "tenantId", "organizationId") VALUES ('${id}', '${namespaceId}', '${DOC}', 0, 'We never quote under ten days', '[0.1,0.2]', 6, '{"kind":"memory-fact"}', 't-1', 'o-1')`,
        );
    }

    it('creates the table with the namespace-keyed chunk columns', async () => {
        await run('up');
        const columns: Array<{ name: string; pk: number }> = await dataSource.query(
            `PRAGMA table_info("vector_namespace_chunks")`,
        );
        expect(columns.map((c) => c.name)).toEqual([
            'id',
            'namespace_id',
            'document_id',
            'chunk_index',
            'content',
            'embedding',
            'token_count',
            'metadata',
            'tenantId',
            'organizationId',
            'createdAt',
        ]);
        const pk = columns
            .filter((c) => c.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((c) => c.name);
        expect(pk).toEqual(['namespace_id', 'id']);
    });

    it('accepts a chunk in a namespace that is not a Work (no foreign keys)', async () => {
        await run('up');
        await dataSource.query('PRAGMA foreign_keys = ON');
        await expect(insert(NS_A, DOC)).resolves.toBeDefined();
        const fks: unknown[] = await dataSource.query(
            `PRAGMA foreign_key_list("vector_namespace_chunks")`,
        );
        expect(fks).toEqual([]);
    });

    it('keys rows by (namespace, id): the same id in two namespaces, never twice in one', async () => {
        await run('up');
        await insert(NS_A, DOC);
        await expect(insert(NS_B, DOC)).resolves.toBeDefined();
        await expect(insert(NS_A, DOC)).rejects.toThrow(/UNIQUE|PRIMARY/i);
    });

    it('creates the (namespace_id, document_id) index', async () => {
        await run('up');
        const indexes: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("vector_namespace_chunks")`,
        );
        expect(indexes.map((i) => i.name)).toContain('idx_vnc_namespace_doc');
    });

    it('is idempotent and leaves work_knowledge_chunks untouched on up and down', async () => {
        await run('up');
        await run('up');
        expect(await dataSource.query(`SELECT * FROM "work_knowledge_chunks"`)).toEqual([
            { id: 'c-1', work_id: 'w-1' },
        ]);

        await run('down');
        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        expect(tables.map((t) => t.name)).not.toContain('vector_namespace_chunks');
        expect(tables.map((t) => t.name)).toContain('work_knowledge_chunks');
        expect(await dataSource.query(`SELECT * FROM "work_knowledge_chunks"`)).toEqual([
            { id: 'c-1', work_id: 'w-1' },
        ]);
    });

    it('on Postgres, types the embedding as vector(1536) with an ivfflat cosine index', async () => {
        const statements: string[] = [];
        const runner = {
            connection: { options: { type: 'postgres' } },
            hasTable: jest.fn().mockResolvedValue(false),
            query: jest.fn(async (sql: string) => {
                statements.push(sql.replace(/\s+/g, ' ').trim());
            }),
        };
        await migration.up(runner as never);

        expect(statements[0]).toContain('"embedding" vector(1536) NULL');
        expect(statements[0]).toContain('PRIMARY KEY ("namespace_id","id")');
        expect(statements[0]).not.toMatch(/REFERENCES/);
        expect(statements).toContainEqual(
            expect.stringContaining(
                'CREATE INDEX "idx_vnc_embedding" ON "vector_namespace_chunks" USING ivfflat ("embedding" vector_cosine_ops)',
            ),
        );
    });
});
