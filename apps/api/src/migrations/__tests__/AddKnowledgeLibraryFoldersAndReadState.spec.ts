import { DataSource, QueryRunner, Table, TableColumn } from 'typeorm';
import { CreateMemoryFolders1786830000000 } from '../1786830000000-CreateMemoryFolders';
import { AddKnowledgeLibraryFoldersAndReadState1791110060000 } from '../1791110060000-AddKnowledgeLibraryFoldersAndReadState';

/**
 * Knowledge library — shared folders, document revisions, archive
 * bookkeeping and the reader-state table.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs,
 * asserting against the PHYSICAL schema (`PRAGMA table_info`,
 * `PRAGMA index_list`, `PRAGMA foreign_key_list`). The Postgres-only FK
 * DDL on the existing documents table is asserted separately against a
 * recording query runner, because sqlite never takes that branch.
 */
describe('AddKnowledgeLibraryFoldersAndReadState1791110060000', () => {
    let dataSource: DataSource;
    const migration = new AddKnowledgeLibraryFoldersAndReadState1791110060000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        const runner = dataSource.createQueryRunner();
        await runner.createTable(
            new Table({
                name: 'users',
                columns: [{ name: 'id', type: 'uuid', isPrimary: true }],
            }),
        );
        await new CreateMemoryFolders1786830000000().up(runner);
        await runner.createTable(
            new Table({
                name: 'work_knowledge_documents',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'workId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'title', type: 'varchar', length: '255' },
                    { name: 'status', type: 'varchar', default: "'active'" },
                    { name: 'createdAt', type: 'datetime' },
                    { name: 'updatedAt', type: 'datetime' },
                ],
            }),
        );
        await runner.query(`INSERT INTO "users" ("id") VALUES ('u1'), ('u2')`);
        await runner.query(
            `INSERT INTO "memory_folders" ("id","userId","name","path","createdAt","updatedAt")
             VALUES ('f1','u1','Docs','/Docs','2026-08-14','2026-08-14')`,
        );
        await runner.query(
            `INSERT INTO "work_knowledge_documents" ("id","workId","title","status","createdAt","updatedAt")
             VALUES ('d1','w1','Voice guide','active','2026-08-01 10:00:00','2026-09-01 06:04:00'),
                    ('d2','w1','Old refund policy','archived','2026-07-01 10:00:00','2026-08-04 09:00:00')`,
        );
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    async function runDown(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
    }

    async function columns(
        table: string,
    ): Promise<Record<string, { notnull: number; dflt_value: string | null }>> {
        const rows: Array<{ name: string; notnull: number; dflt_value: string | null }> =
            await dataSource.query(`PRAGMA table_info("${table}")`);
        return Object.fromEntries(
            rows.map((row) => [row.name, { notnull: row.notnull, dflt_value: row.dflt_value }]),
        );
    }

    async function indexes(
        table: string,
    ): Promise<Record<string, { unique: number; partial: number }>> {
        const rows: Array<{ name: string; unique: number; partial: number }> =
            await dataSource.query(`PRAGMA index_list("${table}")`);
        return Object.fromEntries(
            rows.map((row) => [row.name, { unique: row.unique, partial: row.partial }]),
        );
    }

    describe('memory_folders', () => {
        it('adds a NOT NULL scope column defaulting to user and backfills existing rows', async () => {
            await runUp();
            const cols = await columns('memory_folders');
            expect(cols.scope).toBeDefined();
            expect(cols.scope.notnull).toBe(1);
            expect(cols.scope.dflt_value).toBe("'user'");
            const [row] = await dataSource.query(
                `SELECT "scope" FROM "memory_folders" WHERE "id" = 'f1'`,
            );
            expect(row.scope).toBe('user');
        });

        it('recreates the per-person path index as a PARTIAL unique index and adds the shared ones', async () => {
            await runUp();
            const idx = await indexes('memory_folders');
            expect(idx.uq_memory_folders_user_path).toEqual({ unique: 1, partial: 1 });
            expect(idx.uq_memory_folders_org_path).toEqual({ unique: 1, partial: 1 });
            expect(idx.idx_memory_folders_org_parent).toEqual({ unique: 0, partial: 1 });
            expect(idx.idx_memory_folders_user_parent).toBeDefined();
        });

        it('still refuses a duplicate personal path for the same person', async () => {
            await runUp();
            await expect(
                dataSource.query(
                    `INSERT INTO "memory_folders" ("id","userId","name","path","createdAt","updatedAt")
                     VALUES ('f2','u1','Docs','/Docs','2026-08-14','2026-08-14')`,
                ),
            ).rejects.toThrow();
        });

        it('lets the same person create a shared folder at a path they already use personally', async () => {
            await runUp();
            await expect(
                dataSource.query(
                    `INSERT INTO "memory_folders" ("id","userId","organizationId","scope","name","path","createdAt","updatedAt")
                     VALUES ('f3','u1','org-1','organization','Docs','/Docs','2026-08-14','2026-08-14')`,
                ),
            ).resolves.not.toThrow();
        });

        it('refuses two shared folders at one path in one Organization, even from different people', async () => {
            await runUp();
            await dataSource.query(
                `INSERT INTO "memory_folders" ("id","userId","organizationId","scope","name","path","createdAt","updatedAt")
                 VALUES ('f4','u1','org-1','organization','Playbooks','/Playbooks','2026-08-14','2026-08-14')`,
            );
            await expect(
                dataSource.query(
                    `INSERT INTO "memory_folders" ("id","userId","organizationId","scope","name","path","createdAt","updatedAt")
                     VALUES ('f5','u2','org-1','organization','Playbooks','/Playbooks','2026-08-14','2026-08-14')`,
                ),
            ).rejects.toThrow();
            // Another Organization may use the same path.
            await expect(
                dataSource.query(
                    `INSERT INTO "memory_folders" ("id","userId","organizationId","scope","name","path","createdAt","updatedAt")
                     VALUES ('f6','u2','org-2','organization','Playbooks','/Playbooks','2026-08-14','2026-08-14')`,
                ),
            ).resolves.not.toThrow();
        });

        it('creates the case-insensitive shared-path index idempotently on Postgres', async () => {
            const statements: string[] = [];
            await migration.up(recordingPostgresRunner(statements));
            const ddl = statements.find((sql) => sql.includes('"uq_memory_folders_org_path_ci"'));
            expect(ddl).toMatch(
                /CREATE UNIQUE INDEX IF NOT EXISTS "uq_memory_folders_org_path_ci"/,
            );
            expect(ddl).toMatch(/\("organizationId", lower\("path"\)\)/);
            expect(ddl).toMatch(/WHERE "scope" = 'organization'/);
        });

        it('drops the case-insensitive shared-path index on a Postgres revert', async () => {
            const statements: string[] = [];
            await migration.down(recordingPostgresRunner(statements));
            expect(statements).toContain('DROP INDEX IF EXISTS "uq_memory_folders_org_path_ci"');
        });

        it('leaves the expression index off SQLite, so a later column still rebuilds the table', async () => {
            await runUp();
            expect((await indexes('memory_folders')).uq_memory_folders_org_path_ci).toBeUndefined();
            // SQLite adds a column by rebuilding the table, which TypeORM
            // cannot do around an expression index.
            const runner = dataSource.createQueryRunner();
            await expect(
                runner.addColumn(
                    'memory_folders',
                    new TableColumn({ name: 'later_column', type: 'varchar', isNullable: true }),
                ),
            ).resolves.not.toThrow();
            await runner.release();
            // The exact-path rule survives the rebuild.
            await dataSource.query(
                `INSERT INTO "memory_folders" ("id","userId","organizationId","scope","name","path","createdAt","updatedAt")
                 VALUES ('r1','u1','org-1','organization','Guides','/Guides','2026-08-14','2026-08-14')`,
            );
            await expect(
                dataSource.query(
                    `INSERT INTO "memory_folders" ("id","userId","organizationId","scope","name","path","createdAt","updatedAt")
                     VALUES ('r2','u2','org-1','organization','Guides','/Guides','2026-08-14','2026-08-14')`,
                ),
            ).rejects.toThrow();
        });
    });

    describe('work_knowledge_documents', () => {
        it('adds the six library columns with the right nullability and defaults', async () => {
            await runUp();
            const cols = await columns('work_knowledge_documents');
            expect(cols.folder_id).toMatchObject({ notnull: 0 });
            expect(cols.revision).toMatchObject({ notnull: 1, dflt_value: '1' });
            expect(cols.revision_at).toMatchObject({ notnull: 0 });
            expect(cols.normalized_content_hash).toMatchObject({ notnull: 0 });
            expect(cols.archived_at).toMatchObject({ notnull: 0 });
            expect(cols.archived_by_id).toMatchObject({ notnull: 0 });
        });

        it('starts every existing document at revision 1 with the hash left NULL', async () => {
            await runUp();
            const rows = await dataSource.query(
                `SELECT "id","revision","normalized_content_hash" FROM "work_knowledge_documents" ORDER BY "id"`,
            );
            expect(rows).toEqual([
                { id: 'd1', revision: 1, normalized_content_hash: null },
                { id: 'd2', revision: 1, normalized_content_hash: null },
            ]);
        });

        it('backfills revision_at from updatedAt and archived_at for archived rows only', async () => {
            await runUp();
            const rows = await dataSource.query(
                `SELECT "id","revision_at","archived_at" FROM "work_knowledge_documents" ORDER BY "id"`,
            );
            expect(rows[0].revision_at).toBe('2026-09-01 06:04:00');
            expect(rows[0].archived_at).toBeNull();
            expect(rows[1].revision_at).toBe('2026-08-04 09:00:00');
            expect(rows[1].archived_at).toBe('2026-08-04 09:00:00');
        });

        it('creates the folder and revision-sort indexes', async () => {
            await runUp();
            const idx = await indexes('work_knowledge_documents');
            expect(idx.idx_wkd_folder).toBeDefined();
            expect(idx.idx_wkd_org_status_revision_at).toBeDefined();
            expect(idx.idx_wkd_work_status_revision_at).toBeDefined();
        });

        it('adds both document FKs as ON DELETE SET NULL on Postgres', async () => {
            const statements: string[] = [];
            const runner = recordingPostgresRunner(statements);
            await migration.up(runner);
            const folderFk = statements.find(
                (sql) => sql.includes('"fk_wkd_folder"') && sql.includes('ADD'),
            );
            const archivedByFk = statements.find(
                (sql) => sql.includes('"fk_wkd_archived_by"') && sql.includes('ADD'),
            );
            expect(folderFk).toMatch(/REFERENCES "memory_folders"\("id"\)\s+ON DELETE SET NULL/);
            expect(archivedByFk).toMatch(/REFERENCES "users"\("id"\)\s+ON DELETE SET NULL/);
        });
    });

    describe('knowledge_document_reader_states', () => {
        it('creates the table with every column the entity declares', async () => {
            await runUp();
            const cols = await columns('knowledge_document_reader_states');
            expect(Object.keys(cols).sort()).toEqual(
                [
                    'createdAt',
                    'documentId',
                    'id',
                    'lastOpenedAt',
                    'lastReadRevision',
                    'organizationId',
                    'pinnedAt',
                    'tenantId',
                    'updatedAt',
                    'userId',
                ].sort(),
            );
            expect(cols.lastReadRevision).toMatchObject({ notnull: 1, dflt_value: '0' });
        });

        it('allows one row per person per document', async () => {
            await runUp();
            const idx = await indexes('knowledge_document_reader_states');
            expect(idx.uq_knowledge_reader_state_user_doc).toMatchObject({ unique: 1 });
            expect(idx.idx_knowledge_reader_state_user_pinned).toBeDefined();
            expect(idx.idx_knowledge_reader_state_doc).toBeDefined();
            await dataSource.query(
                `INSERT INTO "knowledge_document_reader_states" ("id","userId","documentId") VALUES ('r1','u1','d1')`,
            );
            await expect(
                dataSource.query(
                    `INSERT INTO "knowledge_document_reader_states" ("id","userId","documentId") VALUES ('r2','u1','d1')`,
                ),
            ).rejects.toThrow();
        });

        it('cascades from both the person and the document', async () => {
            await runUp();
            const fks: Array<{ table: string; on_delete: string }> = await dataSource.query(
                `PRAGMA foreign_key_list("knowledge_document_reader_states")`,
            );
            const byTable = Object.fromEntries(fks.map((fk) => [fk.table, fk.on_delete]));
            expect(byTable).toEqual({ users: 'CASCADE', work_knowledge_documents: 'CASCADE' });
        });
    });

    it('is idempotent — a second up() does not throw or duplicate anything', async () => {
        await runUp();
        await expect(runUp()).resolves.not.toThrow();
        const fks: unknown[] = await dataSource.query(
            `PRAGMA foreign_key_list("knowledge_document_reader_states")`,
        );
        expect(fks).toHaveLength(2);
    });

    it('down() removes everything up() added and restores the full per-person unique index', async () => {
        await runUp();
        await dataSource.query(
            `INSERT INTO "memory_folders" ("id","userId","organizationId","scope","name","path","createdAt","updatedAt")
             VALUES ('f7','u1','org-1','organization','Playbooks','/Playbooks','2026-08-14','2026-08-14')`,
        );
        await runDown();

        expect(
            await dataSource.createQueryRunner().hasTable('knowledge_document_reader_states'),
        ).toBe(false);
        const docCols = await columns('work_knowledge_documents');
        for (const name of [
            'folder_id',
            'revision',
            'revision_at',
            'normalized_content_hash',
            'archived_at',
            'archived_by_id',
        ]) {
            expect(docCols[name]).toBeUndefined();
        }
        // Documents themselves survive the revert.
        const [{ count }] = await dataSource.query(
            `SELECT COUNT(*) AS count FROM "work_knowledge_documents"`,
        );
        expect(Number(count)).toBe(2);

        const folderCols = await columns('memory_folders');
        expect(folderCols.scope).toBeUndefined();
        const idx = await indexes('memory_folders');
        expect(idx.uq_memory_folders_user_path).toEqual({ unique: 1, partial: 0 });
        expect(idx.uq_memory_folders_org_path).toBeUndefined();
        expect(idx.uq_memory_folders_org_path_ci).toBeUndefined();
        // Shared folders are discarded; the personal one stays.
        const ids = (await dataSource.query(`SELECT "id" FROM "memory_folders"`)).map(
            (row: { id: string }) => row.id,
        );
        expect(ids).toEqual(['f1']);
    });
});

/**
 * A query runner that reports a Postgres connection, pretends every table
 * exists with no columns yet, and records every raw statement.
 */
function recordingPostgresRunner(statements: string[]): QueryRunner {
    const emptyTable = {
        indices: [] as Array<{ name: string }>,
        foreignKeys: [] as Array<{ name: string }>,
        findColumnByName: () => undefined,
    };
    return {
        connection: { options: { type: 'postgres' } },
        hasTable: async () => true,
        hasColumn: async (_table: string, column: string) => column === 'scope',
        addColumn: async () => undefined,
        getTable: async () => emptyTable,
        createIndex: async () => undefined,
        dropIndex: async () => undefined,
        createTable: async () => undefined,
        dropTable: async () => undefined,
        dropColumn: async () => undefined,
        createForeignKey: async () => undefined,
        query: async (sql: string) => {
            statements.push(sql);
            return [];
        },
    } as unknown as QueryRunner;
}
