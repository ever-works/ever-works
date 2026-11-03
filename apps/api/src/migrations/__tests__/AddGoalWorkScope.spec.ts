import { DataSource, Table } from 'typeorm';
import { AddGoalWorkScope1792350000000 } from '../1792350000000-AddGoalWorkScope';

/**
 * APW-08 T31 — `goals.workId` and `idx_goals_work`.
 *
 * In-memory better-sqlite3 against the PHYSICAL schema (`PRAGMA table_info` / `index_list`):
 * SQLite recreates a table on an added column, which is the step that could lose a row.
 */
describe('AddGoalWorkScope1792350000000', () => {
    let dataSource: DataSource;
    const migration = new AddGoalWorkScope1792350000000();

    const columnsOf = async (): Promise<Array<{ name: string; notnull: number }>> =>
        dataSource.query(`PRAGMA table_info("goals")`);
    const indexesOf = async (): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_list("goals")`)) as Array<{ name: string }>).map(
            (index) => index.name,
        );

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
                name: 'goals',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'title', type: 'varchar', length: '200' },
                ],
            }),
        );
        await runner.query(`INSERT INTO goals (id, title) VALUES ('goal-1', 'Ship it')`);
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    it('adds the nullable column and its index, and keeps every existing row (NULL = no Work)', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        expect((await columnsOf()).find((column) => column.name === 'workId')).toEqual(
            expect.objectContaining({ notnull: 0 }),
        );
        expect(await indexesOf()).toContain('idx_goals_work');
        expect(await dataSource.query(`SELECT id, title, "workId" FROM goals`)).toEqual([
            { id: 'goal-1', title: 'Ship it', workId: null },
        ]);
    });

    it('is re-runnable: a second up() adds nothing and throws nothing', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.up(runner);
        await runner.release();
        expect((await columnsOf()).filter((column) => column.name === 'workId')).toHaveLength(1);
        expect((await indexesOf()).filter((name) => name === 'idx_goals_work')).toHaveLength(1);
    });

    it('down() removes only what up() added and keeps the rows; no table is ever dropped', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);
        await migration.down(runner);
        await runner.release();
        expect((await columnsOf()).map((column) => column.name)).toEqual(['id', 'title']);
        expect(await indexesOf()).not.toContain('idx_goals_work');
        expect(await dataSource.query(`SELECT id FROM goals`)).toEqual([{ id: 'goal-1' }]);
    });
});
