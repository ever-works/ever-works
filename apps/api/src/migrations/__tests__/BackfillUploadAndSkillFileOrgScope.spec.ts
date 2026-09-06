import { DataSource } from 'typeorm';
import { BackfillUploadAndSkillFileOrgScope1788800000000 } from '../1788800000000-BackfillUploadAndSkillFileOrgScope';

/**
 * Data-migration test on the in-memory better-sqlite3 harness the sibling
 * specs use. Each row class the migration reasons about is seeded once, so
 * the assertions pin exactly what changes and — more importantly — what
 * does not: the migration must NARROW visibility to the right Organization
 * and never widen it, and a second run must be a no-op.
 */
describe('BackfillUploadAndSkillFileOrgScope1788800000000', () => {
    let dataSource: DataSource;
    const migration = new BackfillUploadAndSkillFileOrgScope1788800000000();

    const T = 'tenant-a';
    const T_OTHER = 'tenant-b';
    const ORG = 'org-1';

    const createTables = async () => {
        // Minimal stand-ins — only the columns the migration reads or writes.
        await dataSource.query(
            `CREATE TABLE "organizations" ("id" varchar PRIMARY KEY, "tenantId" varchar NOT NULL)`,
        );
        await dataSource.query(
            `CREATE TABLE "works" ("id" varchar PRIMARY KEY, "tenantId" varchar, "organizationId" varchar)`,
        );
        await dataSource.query(
            `CREATE TABLE "user_uploads" ("id" varchar PRIMARY KEY, "userId" varchar, "workId" varchar, "sha256" varchar, "tenantId" varchar, "organizationId" varchar)`,
        );
        await dataSource.query(
            `CREATE TABLE "skills" ("id" varchar PRIMARY KEY, "tenantId" varchar, "organizationId" varchar)`,
        );
        await dataSource.query(
            `CREATE TABLE "skill_files" ("id" varchar PRIMARY KEY, "userId" varchar NOT NULL, "skillId" varchar NOT NULL, "tenantId" varchar, "organizationId" varchar)`,
        );
    };

    const seed = async () => {
        await dataSource.query(`INSERT INTO "organizations" VALUES ('${ORG}', '${T}')`);
        await dataSource.query(`INSERT INTO "works" VALUES
            ('work-org',           '${T}', '${ORG}'),
            ('work-org-no-tenant', NULL,   '${ORG}'),
            ('work-personal',      '${T}', NULL)`);
        await dataSource.query(`INSERT INTO "user_uploads" VALUES
            ('inherits',          'u1', 'work-org',           'sha-1', '${T}',       NULL),
            ('inherits-no-tenant','u1', 'work-org',           'sha-2', NULL,         NULL),
            ('coalesces-tenant',  'u1', 'work-org-no-tenant', 'sha-3', NULL,         NULL),
            ('already-stamped',   'u1', 'work-org',           'sha-4', '${T}',       '${ORG}'),
            ('personal-parent',   'u1', 'work-personal',      'sha-5', '${T}',       NULL),
            ('dangling-work',     'u1', 'work-gone',          'sha-6', '${T}',       NULL),
            ('tenant-mismatch',   'u1', 'work-org',           'sha-7', '${T_OTHER}', NULL),
            ('anonymous',         NULL, 'work-org',           'sha-8', NULL,         NULL),
            ('no-parent',         'u1', NULL,                 'sha-9', '${T}',       NULL)`);
        await dataSource.query(`INSERT INTO "skills" VALUES
            ('skill-org',      '${T}', '${ORG}'),
            ('skill-personal', '${T}', NULL)`);
        await dataSource.query(`INSERT INTO "skill_files" VALUES
            ('sf-inherits',        'u1', 'skill-org',      NULL,   NULL),
            ('sf-already-stamped', 'u1', 'skill-org',      '${T}', '${ORG}'),
            ('sf-personal-parent', 'u1', 'skill-personal', '${T}', NULL)`);
    };

    const scopeOf = async (table: string, id: string) => {
        const rows = (await dataSource.query(
            `SELECT "tenantId", "organizationId" FROM "${table}" WHERE "id" = '${id}'`,
        )) as Array<{ tenantId: string | null; organizationId: string | null }>;
        return rows[0];
    };

    const snapshot = async () =>
        JSON.stringify([
            await dataSource.query(`SELECT * FROM "user_uploads" ORDER BY "id"`),
            await dataSource.query(`SELECT * FROM "skill_files" ORDER BY "id"`),
        ]);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('a personal-stamped upload under an org Work inherits the Work scope', async () => {
        await createTables();
        await seed();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        expect(await scopeOf('user_uploads', 'inherits')).toEqual({
            tenantId: T,
            organizationId: ORG,
        });
        expect(await scopeOf('user_uploads', 'inherits-no-tenant')).toEqual({
            tenantId: T,
            organizationId: ORG,
        });
        await runner.release();
    });

    it('falls back to the Organization’s tenant when the parent has none', async () => {
        await createTables();
        await seed();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        expect(await scopeOf('user_uploads', 'coalesces-tenant')).toEqual({
            tenantId: T,
            organizationId: ORG,
        });
        await runner.release();
    });

    it('leaves every other row class untouched — it narrows, never widens', async () => {
        await createTables();
        await seed();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        expect(await scopeOf('user_uploads', 'already-stamped')).toEqual({
            tenantId: T,
            organizationId: ORG,
        });
        expect(await scopeOf('user_uploads', 'personal-parent')).toEqual({
            tenantId: T,
            organizationId: null,
        });
        expect(await scopeOf('user_uploads', 'dangling-work')).toEqual({
            tenantId: T,
            organizationId: null,
        });
        expect(await scopeOf('user_uploads', 'tenant-mismatch')).toEqual({
            tenantId: T_OTHER,
            organizationId: null,
        });
        expect(await scopeOf('user_uploads', 'anonymous')).toEqual({
            tenantId: null,
            organizationId: null,
        });
        expect(await scopeOf('user_uploads', 'no-parent')).toEqual({
            tenantId: T,
            organizationId: null,
        });
        await runner.release();
    });

    it('does the same for skill companion files under an org Skill', async () => {
        await createTables();
        await seed();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        expect(await scopeOf('skill_files', 'sf-inherits')).toEqual({
            tenantId: T,
            organizationId: ORG,
        });
        expect(await scopeOf('skill_files', 'sf-already-stamped')).toEqual({
            tenantId: T,
            organizationId: ORG,
        });
        expect(await scopeOf('skill_files', 'sf-personal-parent')).toEqual({
            tenantId: T,
            organizationId: null,
        });
        await runner.release();
    });

    it('logs the candidate and tenant-mismatch counts for the operator', async () => {
        await createTables();
        await seed();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const lines = (console.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
        expect(lines).toEqual([
            expect.stringContaining(
                'user_uploads: 3 row(s) inherit works scope; 1 tenant-mismatched',
            ),
            expect.stringContaining(
                'skill_files: 1 row(s) inherit skills scope; 0 tenant-mismatched',
            ),
        ]);
        await runner.release();
    });

    it('is idempotent — a second up() changes nothing', async () => {
        await createTables();
        await seed();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        const after = await snapshot();

        await migration.up(runner);

        expect(await snapshot()).toBe(after);
        await runner.release();
    });

    it('is a silent no-op on a partial schema', async () => {
        await dataSource.query(`CREATE TABLE "user_uploads" ("id" varchar PRIMARY KEY)`);
        const runner = dataSource.createQueryRunner();

        await expect(migration.up(runner)).resolves.toBeUndefined();
        await runner.release();
    });
});
