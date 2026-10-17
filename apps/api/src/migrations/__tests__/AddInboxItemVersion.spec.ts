import { DataSource, Table } from 'typeorm';
import { AddInboxItemVersion1795090000000 } from '../1795090000000-AddInboxItemVersion';

/**
 * EW-P3-1 — `inbox_items.version`. In-memory better-sqlite3 harness,
 * asserting the PHYSICAL schema through `PRAGMA`.
 */
describe('AddInboxItemVersion1795090000000', () => {
    let dataSource: DataSource;
    const migration = new AddInboxItemVersion1795090000000();

    const columns = async (): Promise<
        Array<{ name: string; notnull: number; dflt_value: unknown }>
    > => dataSource.query(`PRAGMA table_info("inbox_items")`);

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
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'title', type: 'varchar', length: '300' },
                ],
            }),
        );
        await runner.query(`INSERT INTO inbox_items (id, "userId", title) VALUES (?, ?, ?)`, [
            'item-1',
            'user-1',
            'Which tier?',
        ]);
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function run(step: 'up' | 'down'): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration[step](runner);
        await runner.release();
    }

    it('adds a NOT NULL version defaulting to 1; existing rows read 1', async () => {
        await run('up');
        const column = (await columns()).find((c) => c.name === 'version');
        expect(column).toBeDefined();
        expect(column?.notnull).toBe(1);
        expect(String(column?.dflt_value)).toBe('1');
        expect(await dataSource.query(`SELECT version FROM inbox_items`)).toEqual([{ version: 1 }]);
    });

    it('is idempotent and down() removes the column but keeps the rows', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();
        expect((await columns()).filter((c) => c.name === 'version')).toHaveLength(1);
        await run('down');
        expect((await columns()).map((c) => c.name)).not.toContain('version');
        expect(await dataSource.query(`SELECT id FROM inbox_items`)).toEqual([{ id: 'item-1' }]);
    });

    it('is a no-op without the table', async () => {
        await dataSource.query(`DROP TABLE inbox_items`);
        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();
    });
});
