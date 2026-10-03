import { DataSource } from 'typeorm';
import { CreateEverInstanceAndStats1792300000000 } from '../1792300000000-CreateEverInstanceAndStats';

/**
 * Anonymous usage statistics — `1792300000000-CreateEverInstanceAndStats`
 * against an in-memory better-sqlite3 DataSource (the sibling migration specs'
 * harness): the three tables and their columns, no tenant/organization/user
 * column anywhere, the defaults the module relies on, and an idempotent,
 * exact `down()`.
 */
describe('CreateEverInstanceAndStats1792300000000', () => {
    let dataSource: DataSource;
    const migration = new CreateEverInstanceAndStats1792300000000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    const columnsOf = async (table: string) =>
        (
            (await dataSource.query(`PRAGMA table_info("${table}")`)) as Array<{
                name: string;
                notnull: number;
                dflt_value: string | null;
            }>
        ).map((column) => column.name);

    const tables = async () =>
        (
            (await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
            )) as Array<{ name: string }>
        ).map((table) => table.name);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query('CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)');
    });
    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates the instance row table with the statistics key and the reserved connection columns', async () => {
        await run('up');

        expect((await columnsOf('ever_instance')).sort()).toEqual(
            [
                'connectKeyId',
                'connectPrivateKeyEncrypted',
                'connectPublicKey',
                'createdAt',
                'id',
                'instanceId',
                'resetCount',
                'statsEnabledUi',
                'statsKeyId',
                'statsPrivateKeyEncrypted',
                'statsPublicKey',
                'updatedAt',
            ].sort(),
        );

        await dataSource.query(
            `INSERT INTO "ever_instance" ("id", "instanceId", "statsPublicKey", "statsPrivateKeyEncrypted", "statsKeyId")
             VALUES ('self', '41b54444-0795-416c-bdb8-72fe2925a157', 'pub', 'enc::v1::x', 'kid')`,
        );
        const [row] = await dataSource.query(`SELECT * FROM "ever_instance"`);
        // The operator switch defaults ON (anonymous statistics are on by default)
        // and the reserved connection key stays empty.
        expect(Number(row.statsEnabledUi)).toBe(1);
        expect(Number(row.resetCount)).toBe(0);
        expect(row.connectPublicKey).toBeNull();
        expect(row.connectPrivateKeyEncrypted).toBeNull();
    });

    it('creates the report and lease tables', async () => {
        await run('up');

        expect((await columnsOf('ever_stats_report')).sort()).toEqual(
            [
                'attempt',
                'attemptedAt',
                'bytes',
                'errorCode',
                'errors',
                'final',
                'httpStatus',
                'moduleVersion',
                'payload',
                'period',
                'reportId',
                'status',
            ].sort(),
        );
        expect((await columnsOf('ever_stats_lease')).sort()).toEqual(
            [
                'expiresAt',
                'failures',
                'holder',
                'id',
                'lastManualSendAt',
                'nextSendAt',
                'rejectedModuleVersion',
                'updatedAt',
            ].sort(),
        );
    });

    it('stores nothing that names a tenant, an organization or a person', async () => {
        await run('up');

        for (const table of ['ever_instance', 'ever_stats_report', 'ever_stats_lease']) {
            const columns = await columnsOf(table);
            expect(
                columns.filter((name) => /tenant|organization|user|email|name/i.test(name)),
            ).toEqual([]);
        }
    });

    it('is idempotent and its down drops exactly the three tables', async () => {
        await run('up');
        await run('up');
        const indexes: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ever_stats_report'`,
        );
        expect(indexes.map((index) => index.name)).toContain('idx_ever_stats_report_attempted');

        await run('down');
        await run('down');
        expect(await tables()).toEqual(['users']);
    });
});
