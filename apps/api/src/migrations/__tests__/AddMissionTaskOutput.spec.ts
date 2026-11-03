import { DataSource, Table } from 'typeorm';
import { AddMissionTaskOutput1792360000000 } from '../1792360000000-AddMissionTaskOutput';

/**
 * APW-08 T34 — `missions.outputMode` / `taskOutput` / `taskOutputNoticeAt`.
 *
 * In-memory better-sqlite3 against the PHYSICAL schema: SQLite recreates a table on an added
 * column, which is the step that could lose a row — and an existing Mission must read `ideas`.
 */
describe('AddMissionTaskOutput1792360000000', () => {
    let dataSource: DataSource;
    const migration = new AddMissionTaskOutput1792360000000();

    const columnsOf = async (): Promise<
        Array<{ name: string; notnull: number; dflt_value: string | null }>
    > => dataSource.query(`PRAGMA table_info("missions")`);

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
                name: 'missions',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'title', type: 'varchar', length: '200' },
                ],
            }),
        );
        await runner.query(`INSERT INTO missions (id, title) VALUES ('m-1', 'Grow Bookings')`);
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    it('adds the three columns; an existing Mission reads outputMode ideas and NULL output', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const columns = await columnsOf();
        expect(columns.find((c) => c.name === 'outputMode')).toEqual(
            expect.objectContaining({ notnull: 1, dflt_value: "'ideas'" }),
        );
        expect(columns.find((c) => c.name === 'taskOutput')).toEqual(
            expect.objectContaining({ notnull: 0 }),
        );
        expect(columns.find((c) => c.name === 'taskOutputNoticeAt')).toEqual(
            expect.objectContaining({ notnull: 0 }),
        );
        expect(
            await dataSource.query(
                `SELECT id, title, "outputMode", "taskOutput", "taskOutputNoticeAt" FROM missions`,
            ),
        ).toEqual([
            {
                id: 'm-1',
                title: 'Grow Bookings',
                outputMode: 'ideas',
                taskOutput: null,
                taskOutputNoticeAt: null,
            },
        ]);
    });

    it('is re-runnable: a second up() adds nothing and throws nothing', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.up(runner);
        await runner.release();
        const names = (await columnsOf()).map((c) => c.name);
        expect(names.filter((n) => n === 'outputMode')).toHaveLength(1);
    });

    it('down() removes only what up() added and keeps the rows', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);
        await migration.down(runner);
        await runner.release();
        expect((await columnsOf()).map((c) => c.name)).toEqual(['id', 'title']);
        expect(await dataSource.query(`SELECT id FROM missions`)).toEqual([{ id: 'm-1' }]);
    });
});
