import { DataSource } from 'typeorm';
import { AddEverConnectProvision1797400000000 } from '../1797400000000-AddEverConnectProvision';

/**
 * The four tables exist; one record per creation key, per request and per Ever
 * organization, one active link per tenant, one import per key; `up()` re-runs as
 * a no-op; `down()` removes the tables.
 */
describe('AddEverConnectProvision1797400000000', () => {
    let dataSource: DataSource;
    const migration = new AddEverConnectProvision1797400000000();
    const TABLES = [
        'ever_connect_provision_intents',
        'ever_connect_provision_records',
        'ever_connect_links',
        'organization_company_imports',
    ];

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
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

    it('creates the tables, runs again as a no-op, and goes down', async () => {
        await run('up');
        await run('up');
        const runner = dataSource.createQueryRunner();
        for (const table of TABLES) expect(await runner.hasTable(table)).toBe(true);
        await run('down');
        for (const table of TABLES) expect(await runner.hasTable(table)).toBe(false);
        await runner.release();
    });

    it('holds one active link per tenant, an archived one does not count', async () => {
        await run('up');
        const insert = (id: string, org: string, status: string) =>
            dataSource.query(
                `INSERT INTO ever_connect_links (id, "organizationId", "tenantId", "everOrgId", handle, "createdVia", status)
                 VALUES (?, ?, 'tenant-1', ?, 'acme', 'provisioning', ?)`,
                [id, org, `ever-${id}`, status],
            );
        await insert('a', 'org-a', 'active');
        await expect(insert('b', 'org-b', 'active')).rejects.toThrow(/UNIQUE/);
        await insert('c', 'org-c', 'archived');
    });

    it('holds one import per Organization and key', async () => {
        await run('up');
        const insert = (id: string) =>
            dataSource.query(
                `INSERT INTO organization_company_imports (id, "organizationId", "importKey", "templateSlug", status)
                 VALUES (?, 'org-a', 'key-1', 'starter-company', 'running')`,
                [id],
            );
        await insert('a');
        await expect(insert('b')).rejects.toThrow(/UNIQUE/);
    });
});
