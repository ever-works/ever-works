import { DataSource } from 'typeorm';
import { AddInboxItemsKeysetIndex1795130100000 } from '../1795130100000-AddInboxItemsKeysetIndex';

/**
 * EW-P3-1 — keyset index of the integration inbox list, on in-memory
 * better-sqlite3 (the PHYSICAL index through `PRAGMA`): created, idempotent,
 * dropped by `down`, and a no-op without the table.
 */
describe('AddInboxItemsKeysetIndex1795130100000', () => {
    let dataSource: DataSource;
    const migration = new AddInboxItemsKeysetIndex1795130100000();

    const indexColumns = async (index: string): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_info("${index}")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );
    const indexNames = async (): Promise<string[]> =>
        (
            (await dataSource.query(`PRAGMA index_list("inbox_items")`)) as Array<{
                name: string;
            }>
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
        await dataSource.query(
            `CREATE TABLE "inbox_items" ("id" varchar PRIMARY KEY, "userId" varchar, "organizationId" varchar, "updatedAt" datetime)`,
        );
        await dataSource.query(
            `INSERT INTO "inbox_items" ("id", "userId", "organizationId", "updatedAt") VALUES ('item-1', 'user-1', 'org-1', '2026-10-16 09:00:00')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates the (organizationId, updatedAt, id) index and is idempotent', async () => {
        await run('up');
        await run('up');
        expect(await indexColumns('idx_inbox_items_org_updated')).toEqual([
            'organizationId',
            'updatedAt',
            'id',
        ]);
        expect(
            (await indexNames()).filter((name) => name === 'idx_inbox_items_org_updated'),
        ).toHaveLength(1);
    });

    it('down() drops the index and keeps the rows', async () => {
        await run('up');
        await run('down');
        expect(await indexNames()).not.toContain('idx_inbox_items_org_updated');
        expect(await dataSource.query(`SELECT id FROM inbox_items`)).toEqual([{ id: 'item-1' }]);
        await expect(run('down')).resolves.toBeUndefined();
    });

    it('is a no-op without the table or without its columns', async () => {
        await dataSource.query(`DROP TABLE inbox_items`);
        await expect(run('up')).resolves.toBeUndefined();
        await dataSource.query(`CREATE TABLE "inbox_items" ("id" varchar PRIMARY KEY)`);
        await expect(run('up')).resolves.toBeUndefined();
        expect(await indexNames()).not.toContain('idx_inbox_items_org_updated');
    });
});
