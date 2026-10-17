import { DataSource } from 'typeorm';
import { CreateIntegrationApiFoundation1795080200000 } from '../1795080200000-CreateIntegrationApiFoundation';

/**
 * Migration test for the integration API v1 foundation (EW-P1-4) on
 * in-memory better-sqlite3, asserting the PHYSICAL schema through `PRAGMA`.
 */
describe('CreateIntegrationApiFoundation1795080200000', () => {
    let dataSource: DataSource;
    const migration = new CreateIntegrationApiFoundation1795080200000();

    const columns = async (
        table: string,
    ): Promise<Array<{ name: string; dflt_value: string | null }>> =>
        dataSource.query(`PRAGMA table_info("${table}")`);
    const indexes = async (table: string): Promise<Array<{ name: string; unique: number }>> =>
        dataSource.query(`PRAGMA index_list("${table}")`);
    const tables = async (): Promise<string[]> =>
        (
            (await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'table'`,
            )) as Array<{ name: string }>
        ).map((row) => row.name);
    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
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

    it('creates external_record_links, unique on both sides, installationKey defaulting to empty', async () => {
        await run('up');
        const names = (await columns('external_record_links')).map((c) => c.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'id',
                'tenantId',
                'organizationId',
                'entityType',
                'entityId',
                'source',
                'installationKey',
                'externalId',
                'externalUrl',
                'integrationKeyId',
                'createdAt',
                'updatedAt',
            ]),
        );
        const unique = (await indexes('external_record_links'))
            .filter((i) => i.unique === 1)
            .map((i) => i.name);
        expect(unique).toEqual(
            expect.arrayContaining([
                'uq_external_record_links_external',
                'uq_external_record_links_entity',
            ]),
        );
        const insert = (id: string, entityId: string, externalId: string) =>
            dataSource.query(
                `INSERT INTO "external_record_links" ("id", "organizationId", "entityType", "entityId", "source", "externalId") VALUES (?, 'org', 'task', ?, 'gauzy', ?)`,
                [id, entityId, externalId],
            );
        await insert('l-1', 'e-1', 'x-1');
        const [row] = await dataSource.query(
            `SELECT "installationKey" FROM "external_record_links"`,
        );
        expect(row).toEqual({ installationKey: '' });
        // No installation still collides — '' is a value, NULL would not be.
        await expect(insert('l-2', 'e-2', 'x-1')).rejects.toThrow(/UNIQUE/i);
        await expect(insert('l-3', 'e-1', 'x-2')).rejects.toThrow(/UNIQUE/i);
    });

    it('creates integration_idempotency_keys, unique per (integrationKeyId, idempotencyKey)', async () => {
        await run('up');
        expect((await columns('integration_idempotency_keys')).map((c) => c.name)).toEqual(
            expect.arrayContaining([
                'integrationKeyId',
                'idempotencyKey',
                'requestHash',
                'state',
                'responseStatus',
                'responseBody',
                'expiresAt',
            ]),
        );
        const insert = (id: string, key: string) =>
            dataSource.query(
                `INSERT INTO "integration_idempotency_keys" ("id", "integrationKeyId", "idempotencyKey", "requestHash", "expiresAt") VALUES (?, 'k', ?, 'h', 1)`,
                [id, key],
            );
        await insert('i-1', 'a');
        await expect(insert('i-2', 'a')).rejects.toThrow(/UNIQUE/i);
        await insert('i-3', 'b');
    });

    it('is idempotent, and down drops both tables', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();
        await run('down');
        const left = await tables();
        expect(left).not.toContain('external_record_links');
        expect(left).not.toContain('integration_idempotency_keys');
    });
});
