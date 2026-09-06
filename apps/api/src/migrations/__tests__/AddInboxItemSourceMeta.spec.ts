import { DataSource, Table } from 'typeorm';
import { AddInboxItemSourceMeta1788000000000 } from '../1788000000000-AddInboxItemSourceMeta';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters: existing inbox items survive with NULL provenance (they
 * were not asked by a fleet run), re-running is a no-op, and `down()`
 * reverses it.
 */
describe('AddInboxItemSourceMeta1788000000000', () => {
    let dataSource: DataSource;
    const migration = new AddInboxItemSourceMeta1788000000000();

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
                    { name: 'kind', type: 'varchar', length: '16' },
                    { name: 'title', type: 'varchar', length: '300' },
                    { name: 'body', type: 'text' },
                    { name: 'sourceType', type: 'varchar', length: '24' },
                    { name: 'status', type: 'varchar', length: '16', default: "'open'" },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO inbox_items (id, "userId", kind, title, body, "sourceType", status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                'item-1',
                'user-1',
                'question',
                'Which database?',
                'Which database?',
                'agent-run',
                'open',
            ],
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

    it('adds a nullable sourceMeta column and leaves existing items without fleet provenance', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const items = await runner.getTable('inbox_items');
        await runner.release();
        expect(items?.findColumnByName('sourceMeta')).toMatchObject({ isNullable: true });
        expect(
            await dataSource.query(`SELECT id, "sourceMeta" FROM inbox_items WHERE id = ?`, [
                'item-1',
            ]),
        ).toEqual([{ id: 'item-1', sourceMeta: null }]);
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        const runner = dataSource.createQueryRunner();
        expect(
            (await runner.getTable('inbox_items'))?.findColumnByName('sourceMeta'),
        ).toBeDefined();
        await migration.down(runner);
        expect(
            (await runner.getTable('inbox_items'))?.findColumnByName('sourceMeta'),
        ).toBeUndefined();
        await migration.down(runner);
        expect(
            (await runner.getTable('inbox_items'))?.findColumnByName('sourceMeta'),
        ).toBeUndefined();
        await runner.release();
    });
});
