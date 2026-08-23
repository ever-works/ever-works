import { DataSource } from 'typeorm';
import { AddUserUploadScopeIndex1786950000000 } from '../1786950000000-AddUserUploadScopeIndex';

describe('AddUserUploadScopeIndex1786950000000', () => {
    let dataSource: DataSource;
    const migration = new AddUserUploadScopeIndex1786950000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`
            CREATE TABLE "user_uploads" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar,
                "tenantId" varchar,
                "organizationId" varchar,
                "sha256" varchar NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "user_uploads" ("id","userId","tenantId","organizationId","sha256") VALUES ('up1','u1',NULL,NULL,'abc')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the non-unique scope lookup index without changing existing rows', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('user_uploads');
        const index = table?.indices.find(
            (candidate) => candidate.name === 'idx_user_uploads_user_scope_sha',
        );
        expect(index?.columnNames).toEqual(['userId', 'tenantId', 'organizationId', 'sha256']);
        expect(index?.isUnique).toBe(false);
        await expect(
            dataSource.query(`SELECT * FROM "user_uploads" WHERE "id" = 'up1'`),
        ).resolves.toHaveLength(1);

        await runner.release();
    });

    it('is idempotent and only removes the additive index on rollback', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();
        await migration.down(runner);

        const table = await runner.getTable('user_uploads');
        expect(
            table?.indices.some(
                (candidate) => candidate.name === 'idx_user_uploads_user_scope_sha',
            ),
        ).toBe(false);
        await expect(
            dataSource.query(`SELECT * FROM "user_uploads" WHERE "id" = 'up1'`),
        ).resolves.toHaveLength(1);

        await runner.release();
    });
});
