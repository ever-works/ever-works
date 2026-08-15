import { DataSource } from 'typeorm';
import { CreateMemoryFolders1786830000000 } from '../1786830000000-CreateMemoryFolders';

/**
 * Migration test for the `memory_folders` table (Memory Files area).
 *
 * Runs on the in-memory better-sqlite3 harness the sibling specs use —
 * production is Postgres, CI/e2e are sqlite, and the portable Table API
 * is what makes the same migration work on both. This spec proves it.
 *
 * Also pinned, mirroring the CreateWorkflows lessons:
 *  - NO scope XOR CHECK (ScopeStampingSubscriber stamps organizationId
 *    on ordinary rows, so both scope columns being set is the normal
 *    shape, not an error);
 *  - `(userId, path)` is UNIQUE — the materialized-path invariant the
 *    folders service relies on for duplicate detection;
 *  - NO self-FK on parentId (subtree deletes are one statement).
 */
describe('CreateMemoryFolders1786830000000', () => {
    let dataSource: DataSource;
    const migration = new CreateMemoryFolders1786830000000();

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

    it('creates the table with every expected column', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('memory_folders');
        expect(table).toBeDefined();
        for (const column of [
            'id',
            'userId',
            'tenantId',
            'organizationId',
            'name',
            'parentId',
            'path',
            'ownerAgentId',
            'syncRepo',
            'createdAt',
            'updatedAt',
        ]) {
            expect(table?.findColumnByName(column)).toBeDefined();
        }

        await runner.release();
    });

    it('is idempotent — a second up() does not throw', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();
        await runner.release();
    });

    // Raw inserts supply createdAt/updatedAt explicitly: the columns
    // default to `now()` (Postgres); real inserts go through TypeORM,
    // whose @CreateDateColumn supplies the value from the ORM side.
    it('enforces path uniqueness PER USER (same path, two users, is fine)', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await dataSource.query(
            `INSERT INTO "memory_folders" ("id","userId","name","path","createdAt","updatedAt")
			 VALUES ('f1','u1','docs','/docs','2026-08-14','2026-08-14')`,
        );
        // Same path for ANOTHER user must be allowed.
        await expect(
            dataSource.query(
                `INSERT INTO "memory_folders" ("id","userId","name","path","createdAt","updatedAt")
				 VALUES ('f2','u2','docs','/docs','2026-08-14','2026-08-14')`,
            ),
        ).resolves.not.toThrow();
        // Duplicate path for the SAME user must be rejected.
        await expect(
            dataSource.query(
                `INSERT INTO "memory_folders" ("id","userId","name","path","createdAt","updatedAt")
				 VALUES ('f3','u1','docs','/docs','2026-08-14','2026-08-14')`,
            ),
        ).rejects.toThrow();

        await runner.release();
    });

    it('accepts a row with BOTH tenantId and organizationId set (no XOR CHECK)', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await expect(
            dataSource.query(
                `INSERT INTO "memory_folders"
					("id","userId","tenantId","organizationId","name","path","createdAt","updatedAt")
				 VALUES ('f4','u1','t1','org-1','both','/both','2026-08-14','2026-08-14')`,
            ),
        ).resolves.not.toThrow();

        await runner.release();
    });

    it('accepts an agent-private child row (parentId + ownerAgentId, no self-FK)', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        // parentId points at a row that does not exist — legal by design
        // (no self-FK); the service owns the subtree invariant.
        await expect(
            dataSource.query(
                `INSERT INTO "memory_folders"
					("id","userId","name","parentId","path","ownerAgentId","createdAt","updatedAt")
				 VALUES ('f5','u1','private','missing-parent','/x/private','agent-1','2026-08-14','2026-08-14')`,
            ),
        ).resolves.not.toThrow();

        await runner.release();
    });

    it('down() drops the table', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        expect(await runner.hasTable('memory_folders')).toBe(false);

        await runner.release();
    });
});
