import { DataSource } from 'typeorm';
import { AddMemoryFolderIdToUploads1786600001000 } from '../1786600001000-AddMemoryFolderIdToUploads';

/**
 * Migration test for the `folderId` membership columns on BOTH upload
 * spines (`user_uploads` + `work_knowledge_uploads`).
 *
 * Same in-memory better-sqlite3 harness as the sibling specs. The
 * migration's postgres-only FK branch is deliberately NOT exercised
 * here — sqlite cannot ALTER in an FK without a table rebuild, which is
 * exactly why the migration gates it on the driver; this spec proves
 * the sqlite path (column + index, no FK) works and stays idempotent.
 */
describe('AddMemoryFolderIdToUploads1786600001000', () => {
    let dataSource: DataSource;
    const migration = new AddMemoryFolderIdToUploads1786600001000();

    const createUploadTables = async () => {
        // Minimal stand-ins for the real tables — only what the migration
        // touches plus a payload column to prove data survives.
        await dataSource.query(
            `CREATE TABLE "user_uploads" ("id" varchar PRIMARY KEY, "sha256" varchar)`,
        );
        await dataSource.query(
            `CREATE TABLE "work_knowledge_uploads" ("id" varchar PRIMARY KEY, "originalFilename" varchar)`,
        );
    };

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

    it('adds a nullable folderId column + index to both spines', async () => {
        await createUploadTables();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        for (const tableName of ['user_uploads', 'work_knowledge_uploads']) {
            const table = await runner.getTable(tableName);
            const column = table?.findColumnByName('folderId');
            expect(column).toBeDefined();
            expect(column?.isNullable).toBe(true);
            expect(table?.indices.some((i) => i.name === `idx_${tableName}_folder`)).toBe(true);
        }

        await runner.release();
    });

    it('preserves existing rows (folderId backfills as NULL = unfiled)', async () => {
        await createUploadTables();
        await dataSource.query(`INSERT INTO "user_uploads" ("id","sha256") VALUES ('up1','abc')`);

        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const rows = await dataSource.query(
            `SELECT "sha256", "folderId" FROM "user_uploads" WHERE "id" = 'up1'`,
        );
        expect(rows[0].sha256).toBe('abc');
        expect(rows[0].folderId).toBeNull();

        await runner.release();
    });

    it('is idempotent — a second up() does not throw', async () => {
        await createUploadTables();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();
        await runner.release();
    });

    it('no-ops safely when the upload tables do not exist yet', async () => {
        const runner = dataSource.createQueryRunner();
        await expect(migration.up(runner)).resolves.not.toThrow();
        await runner.release();
    });

    it('down() removes the column and index from both spines', async () => {
        await createUploadTables();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        for (const tableName of ['user_uploads', 'work_knowledge_uploads']) {
            const table = await runner.getTable(tableName);
            expect(table?.findColumnByName('folderId')).toBeUndefined();
        }

        await runner.release();
    });
});
