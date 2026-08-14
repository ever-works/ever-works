import { DataSource } from 'typeorm';
import { AddSkillInvocationSlugAndSkillFiles1785010000000 } from '../1785010000000-AddSkillInvocationSlugAndSkillFiles';

/**
 * Skills — invocation slugs + companion files. Runs on the in-memory
 * better-sqlite3 harness the sibling migration specs use: production is
 * Postgres, CI/e2e are sqlite, and the portable Table/TableColumn API is
 * what makes the same migration work on both — this spec proves it.
 *
 * The `skills` / `users` stubs mirror the minimum shape the migration
 * touches (the real tables exist by this point in the chain).
 */
describe('AddSkillInvocationSlugAndSkillFiles1785010000000', () => {
    let dataSource: DataSource;
    const migration = new AddSkillInvocationSlugAndSkillFiles1785010000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`,
        );
        await dataSource.query(
            `CREATE TABLE "skills" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "slug" varchar NOT NULL)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds skills.invocationSlug (nullable) and creates skill_files with every expected column', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const skillCols: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("skills")`,
        );
        expect(skillCols.map((c) => c.name)).toContain('invocationSlug');

        const table = await runner.getTable('skill_files');
        expect(table).toBeDefined();
        for (const column of [
            'id',
            'skillId',
            'userId',
            'uploadId',
            'filename',
            'kind',
            'sizeBytes',
            'mime',
            'tenantId',
            'organizationId',
            'createdAt',
            'updatedAt',
        ]) {
            expect(table?.findColumnByName(column)).toBeDefined();
        }
        await runner.release();
    });

    it('enforces unique(skillId, filename) — the duplicate-name 409 backstop', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        // Seed the FK parents — skill_files carries real FKs to users/skills.
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
        await dataSource.query(
            `INSERT INTO "skills" ("id", "userId", "slug") VALUES ('sk1', 'u1', 'cron')`,
        );

        const insert = (id: string, filename: string) =>
            dataSource.query(
                `INSERT INTO "skill_files" ("id", "skillId", "userId", "uploadId", "filename", "kind", "sizeBytes", "mime", "createdAt", "updatedAt")
                 VALUES ('${id}', 'sk1', 'u1', 'hash', '${filename}', 'reference', 10, 'text/plain', '2026-01-01', '2026-01-01')`,
            );
        await insert('f1', 'a.md');
        await insert('f2', 'b.md'); // different name, same skill — fine
        await expect(insert('f3', 'a.md')).rejects.toThrow();
    });

    it('is idempotent — a second up() does not throw or duplicate the column', async () => {
        const r1 = dataSource.createQueryRunner();
        await migration.up(r1);
        await r1.release();

        const r2 = dataSource.createQueryRunner();
        await expect(migration.up(r2)).resolves.toBeUndefined();
        await r2.release();

        const skillCols: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("skills")`,
        );
        expect(skillCols.filter((c) => c.name === 'invocationSlug')).toHaveLength(1);
    });

    it('down() drops the table and the column', async () => {
        const up = dataSource.createQueryRunner();
        await migration.up(up);
        await up.release();

        const down = dataSource.createQueryRunner();
        await migration.down(down);

        expect(await down.hasTable('skill_files')).toBe(false);
        const skillCols: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("skills")`,
        );
        expect(skillCols.map((c) => c.name)).not.toContain('invocationSlug');
        await down.release();
    });
});
