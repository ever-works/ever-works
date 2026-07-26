import { DataSource } from 'typeorm';
import { CreateIngestInstallBindings1784200000000 } from '../1784200000000-CreateIngestInstallBindings';

/**
 * Inbound receivers — migration test for `ingest_install_bindings`, run
 * against an in-memory better-sqlite3 DataSource (same harness as
 * `AddRunSteeringColumns.spec.ts`).
 *
 * The load-bearing assertion is the UNIQUE `(provider,
 * externalWorkspaceId)` index: uniqueness is what makes workspace→owner
 * resolution EXACT rather than a guess. Without it two platform users
 * could claim the same Slack workspace or GitHub installation and the
 * multi-tenancy defect this table fixes would come straight back.
 *
 * The inserts below pass `createdAt`/`updatedAt` explicitly: the table's
 * `now()` / `uuid_generate_v4()` defaults are Postgres functions (the
 * shape every migration in this folder ships), and sqlite is used here
 * only as a cheap DDL harness.
 */
describe('CreateIngestInstallBindings1784200000000', () => {
    let dataSource: DataSource;
    const migration = new CreateIngestInstallBindings1784200000000();

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
            `PRAGMA table_info("ingest_install_bindings")`,
        );
        return rows.map((r) => r.name);
    }

    it('creates the table with the binding columns', async () => {
        await up();
        expect(await columnNames()).toEqual(
            expect.arrayContaining([
                'id',
                'provider',
                'externalWorkspaceId',
                'externalEnterpriseId',
                'userId',
                'pluginId',
                'externalWorkspaceName',
                'createdAt',
                'updatedAt',
            ]),
        );
    });

    const COLUMNS =
        '"id", "provider", "externalWorkspaceId", "userId", "pluginId", "createdAt", "updatedAt"';
    const STAMPS = `'2026-07-26 00:00:00', '2026-07-26 00:00:00'`;

    it('⭐ enforces one owner per (provider, workspace) — two tenants cannot claim the same workspace', async () => {
        await up();
        await dataSource.query(
            `INSERT INTO "ingest_install_bindings" (${COLUMNS})
             VALUES ('b-1', 'slack', 'T-AAA', 'u-a', 'slack-connector', ${STAMPS})`,
        );

        await expect(
            dataSource.query(
                `INSERT INTO "ingest_install_bindings" (${COLUMNS})
                 VALUES ('b-2', 'slack', 'T-AAA', 'u-b', 'slack-connector', ${STAMPS})`,
            ),
        ).rejects.toThrow();
    });

    it('keeps the slack and github namespaces independent', async () => {
        await up();
        await dataSource.query(
            `INSERT INTO "ingest_install_bindings" (${COLUMNS})
             VALUES ('b-1', 'slack', 'shared-id', 'u-a', 'slack-connector', ${STAMPS}),
                    ('b-2', 'github', 'shared-id', 'u-b', 'github', ${STAMPS})`,
        );
        const rows = await dataSource.query(`SELECT COUNT(*) AS n FROM "ingest_install_bindings"`);
        expect(Number(rows[0].n)).toBe(2);
    });

    it('is idempotent — running up() twice does not throw', async () => {
        await up();
        const runner = dataSource.createQueryRunner();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await runner.release();
        expect(await columnNames()).toContain('externalWorkspaceId');
    });

    it('down() drops the table', async () => {
        await up();
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();

        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='ingest_install_bindings'`,
        );
        expect(tables).toHaveLength(0);
    });
});
