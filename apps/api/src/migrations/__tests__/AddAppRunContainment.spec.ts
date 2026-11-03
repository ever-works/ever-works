import { DataSource, Table } from 'typeorm';
import { AddAppRunContainment1792340000000 } from '../1792340000000-AddAppRunContainment';

/**
 * APW-08 T48 / T12 — `agent_runs.containment` and `works.appRunContainmentAllowances`.
 *
 * In-memory better-sqlite3 against the PHYSICAL schema (`PRAGMA table_info`): SQLite recreates a
 * table on an added column, which is the step that could lose a row.
 */
describe('AddAppRunContainment1792340000000', () => {
    let dataSource: DataSource;
    const migration = new AddAppRunContainment1792340000000();

    const columnsOf = async (table: string): Promise<Array<{ name: string; notnull: number }>> =>
        dataSource.query(`PRAGMA table_info("${table}")`);

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
                name: 'agent_runs',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'status', type: 'varchar', length: '16' },
                ],
            }),
        );
        await runner.createTable(
            new Table({
                name: 'works',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'kind', type: 'varchar', length: '32' },
                ],
            }),
        );
        await runner.query(`INSERT INTO agent_runs (id, status) VALUES ('run-1', 'completed')`);
        await runner.query(`INSERT INTO works (id, kind) VALUES ('work-1', 'app')`);
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    it('adds the two nullable text columns and keeps every existing row', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const runColumn = (await columnsOf('agent_runs')).find((c) => c.name === 'containment');
        const workColumn = (await columnsOf('works')).find(
            (c) => c.name === 'appRunContainmentAllowances',
        );
        expect(runColumn).toEqual(expect.objectContaining({ notnull: 0 }));
        expect(workColumn).toEqual(expect.objectContaining({ notnull: 0 }));
        expect(await dataSource.query(`SELECT id, containment FROM agent_runs`)).toEqual([
            { id: 'run-1', containment: null },
        ]);
        expect(
            await dataSource.query(`SELECT id, "appRunContainmentAllowances" AS a FROM works`),
        ).toEqual([{ id: 'work-1', a: null }]);
    });

    it('is idempotent: a second up() adds nothing and throws nothing', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.up(runner);
        await runner.release();
        const names = (await columnsOf('agent_runs')).map((c) => c.name);
        expect(names.filter((n) => n === 'containment')).toHaveLength(1);
    });

    it('down() drops only the two added columns', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);
        await migration.down(runner);
        await runner.release();
        expect((await columnsOf('agent_runs')).map((c) => c.name)).toEqual(['id', 'status']);
        expect((await columnsOf('works')).map((c) => c.name)).toEqual(['id', 'kind']);
    });
});
