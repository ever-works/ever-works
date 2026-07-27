import { DataSource } from 'typeorm';
import { CreateExternalIssueLinks1784730000000 } from '../1784730000000-CreateExternalIssueLinks';

/**
 * External-issue ↔ Task mapping — migration test for
 * `external_issue_links`, run against an in-memory better-sqlite3
 * DataSource (same harness as `CreateIngestInstallBindings.spec.ts`).
 *
 * The load-bearing assertions are the two index shapes:
 *   - UNIQUE `(userId, source, externalIssueId)` — one Task per external
 *     issue per owner, which is what makes the ingest-side "is this
 *     already linked?" lookup exact and re-linking idempotent;
 *   - the reverse direction is deliberately NON-unique — one Task may
 *     mirror several issues.
 *
 * The inserts pass `createdAt`/`updatedAt` explicitly: the table's
 * `now()` / `uuid_generate_v4()` defaults are Postgres functions (the
 * shape every migration in this folder ships), and sqlite is used here
 * only as a cheap DDL harness.
 */
describe('CreateExternalIssueLinks1784730000000', () => {
    let dataSource: DataSource;
    const migration = new CreateExternalIssueLinks1784730000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u-a'), ('u-b')`);
        await dataSource.query(`CREATE TABLE "tasks" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "tasks" ("id") VALUES ('t-1'), ('t-2')`);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    async function up(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("external_issue_links")`,
        );
        return rows.map((r) => r.name);
    }

    const COLUMNS =
        '"id", "userId", "taskId", "source", "externalIssueId", "createdAt", "updatedAt"';
    const STAMPS = `'2026-07-26 00:00:00', '2026-07-26 00:00:00'`;

    it('creates the table with the mapping + provenance columns', async () => {
        await up();
        expect(await columnNames()).toEqual(
            expect.arrayContaining([
                'id',
                'userId',
                'taskId',
                'source',
                'externalIssueId',
                'externalKey',
                'title',
                'url',
                'lastIngestedEventId',
                'lastSeenAt',
                'tenantId',
                'organizationId',
                'createdAt',
                'updatedAt',
            ]),
        );
    });

    it('⭐ enforces one Task per external issue per owner', async () => {
        await up();
        await dataSource.query(
            `INSERT INTO "external_issue_links" (${COLUMNS})
             VALUES ('l-1', 'u-a', 't-1', 'linear-connector', 'issue-42', ${STAMPS})`,
        );

        await expect(
            dataSource.query(
                `INSERT INTO "external_issue_links" (${COLUMNS})
                 VALUES ('l-2', 'u-a', 't-2', 'linear-connector', 'issue-42', ${STAMPS})`,
            ),
        ).rejects.toThrow();
    });

    it('⭐ scopes that uniqueness per OWNER — two tenants may link the same external issue', async () => {
        await up();
        await dataSource.query(
            `INSERT INTO "external_issue_links" (${COLUMNS})
             VALUES ('l-1', 'u-a', 't-1', 'github', 'issue-42', ${STAMPS}),
                    ('l-2', 'u-b', 't-2', 'github', 'issue-42', ${STAMPS})`,
        );
        const rows = await dataSource.query(`SELECT COUNT(*) AS n FROM "external_issue_links"`);
        expect(Number(rows[0].n)).toBe(2);
    });

    it('keeps source namespaces independent for the same issue id', async () => {
        await up();
        await dataSource.query(
            `INSERT INTO "external_issue_links" (${COLUMNS})
             VALUES ('l-1', 'u-a', 't-1', 'linear-connector', 'shared-id', ${STAMPS}),
                    ('l-2', 'u-a', 't-2', 'jira-connector', 'shared-id', ${STAMPS})`,
        );
        const rows = await dataSource.query(`SELECT COUNT(*) AS n FROM "external_issue_links"`);
        expect(Number(rows[0].n)).toBe(2);
    });

    it('⭐ allows ONE Task to mirror several issues (reverse direction is not unique)', async () => {
        await up();
        await dataSource.query(
            `INSERT INTO "external_issue_links" (${COLUMNS})
             VALUES ('l-1', 'u-a', 't-1', 'jira-connector', 'EPIC-1', ${STAMPS}),
                    ('l-2', 'u-a', 't-1', 'github', 'tracking-9', ${STAMPS})`,
        );
        const rows = await dataSource.query(
            `SELECT COUNT(*) AS n FROM "external_issue_links" WHERE "taskId" = 't-1'`,
        );
        expect(Number(rows[0].n)).toBe(2);
    });

    it('is idempotent — running up() twice does not throw', async () => {
        await up();
        const runner = dataSource.createQueryRunner();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await runner.release();
        expect(await columnNames()).toContain('externalIssueId');
    });

    it('down() drops the table', async () => {
        await up();
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();

        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='external_issue_links'`,
        );
        expect(tables).toHaveLength(0);
    });
});
