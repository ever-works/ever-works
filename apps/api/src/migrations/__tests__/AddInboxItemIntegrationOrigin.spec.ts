import { DataSource, Table } from 'typeorm';
import { AddInboxItemIntegrationOrigin1797200000000 } from '../1797200000000-AddInboxItemIntegrationOrigin';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs. What
 * matters: every existing item reads `origin = 'platform'` with no integration
 * fields, the partial unique index refuses a second item for the same
 * (tenant, key, externalId) while leaving platform rows (NULL externalId)
 * unconstrained, re-running is a no-op, and `down()` reverses it.
 */
describe('AddInboxItemIntegrationOrigin1797200000000', () => {
    let dataSource: DataSource;
    const migration = new AddInboxItemIntegrationOrigin1797200000000();
    const ADDED = [
        'origin',
        'integrationKeyId',
        'externalId',
        'sourceUrl',
        'sourceLabel',
        'emailMeta',
        'occurredAt',
        'goalId',
    ];

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        const runner = dataSource.createQueryRunner();
        await runner.createTable(
            new Table({
                name: 'inbox_items',
                columns: [
                    { name: 'id', type: 'varchar', isPrimary: true },
                    { name: 'userId', type: 'varchar' },
                    { name: 'kind', type: 'varchar', length: '16' },
                    { name: 'title', type: 'varchar', length: '300' },
                    { name: 'body', type: 'text' },
                    { name: 'sourceType', type: 'varchar', length: '24' },
                    { name: 'status', type: 'varchar', length: '16', default: "'open'" },
                    { name: 'tenantId', type: 'varchar', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO inbox_items (id, "userId", kind, title, body, "sourceType", status, "tenantId") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ['item-1', 'user-1', 'question', 'Which tier?', 'Which tier?', 'agent-run', 'open', 't-1'],
        );
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    const insert = (id: string, tenantId: string, keyId: string | null, externalId: string | null) =>
        dataSource.query(
            `INSERT INTO inbox_items (id, "userId", kind, title, body, "sourceType", status, "tenantId", origin, "integrationKeyId", "externalId") VALUES (?, 'user-1', 'notice', 't', 'b', 'integration', 'open', ?, 'integration', ?, ?)`,
            [id, tenantId, keyId, externalId],
        );

    it('adds the origin columns; existing items read origin = platform with no integration fields', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('inbox_items');
        await runner.release();
        for (const name of ADDED) expect(table?.findColumnByName(name)).toBeDefined();
        expect(table?.findColumnByName('origin')).toMatchObject({ isNullable: false });
        expect(
            await dataSource.query(
                `SELECT origin, "integrationKeyId", "externalId", "sourceUrl", "emailMeta" FROM inbox_items WHERE id = ?`,
                ['item-1'],
            ),
        ).toEqual([
            {
                origin: 'platform',
                integrationKeyId: null,
                externalId: null,
                sourceUrl: null,
                emailMeta: null,
            },
        ]);
    });

    it('refuses a second item for the same tenant + key + externalId, and leaves NULL externalIds alone', async () => {
        await runUp();
        await insert('a', 't-1', 'key-1', 'gauzy-1');
        await expect(insert('b', 't-1', 'key-1', 'gauzy-1')).rejects.toThrow(/UNIQUE/i);
        // Another key, or another tenant, may use the same externalId.
        await expect(insert('c', 't-1', 'key-2', 'gauzy-1')).resolves.toBeDefined();
        await expect(insert('d', 't-2', 'key-1', 'gauzy-1')).resolves.toBeDefined();
        // Platform rows carry no externalId: any number of them.
        await expect(insert('e', 't-1', null, null)).resolves.toBeDefined();
        await expect(insert('f', 't-1', null, null)).resolves.toBeDefined();
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        const runner = dataSource.createQueryRunner();
        let table = await runner.getTable('inbox_items');
        expect(
            table?.indices.some((index) => index.name === 'uq_inbox_items_integration_external'),
        ).toBe(true);
        await migration.down(runner);
        table = await runner.getTable('inbox_items');
        for (const name of ADDED) expect(table?.findColumnByName(name)).toBeUndefined();
        expect(table?.indices.map((index) => index.name)).not.toContain(
            'uq_inbox_items_integration_external',
        );
        // The pre-existing row and columns survive the round trip.
        expect(await dataSource.query(`SELECT id, kind FROM inbox_items`)).toEqual([
            { id: 'item-1', kind: 'question' },
        ]);
        await migration.down(runner);
        await runner.release();
    });
});
