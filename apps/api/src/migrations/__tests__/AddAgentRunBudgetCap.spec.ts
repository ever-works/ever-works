import { DataSource, Table } from 'typeorm';
import { AddAgentRunBudgetCap1792370000000 } from '../1792370000000-AddAgentRunBudgetCap';

/**
 * APW-08 T35 (APW08-G15) — `agent_runs.budgetCapCents`, on the PHYSICAL schema (SQLite recreates
 * the table on an added column, the step that could lose a row).
 */
describe('AddAgentRunBudgetCap1792370000000', () => {
    let dataSource: DataSource;
    const migration = new AddAgentRunBudgetCap1792370000000();

    const columnsOf = async (): Promise<Array<{ name: string; notnull: number }>> =>
        dataSource.query(`PRAGMA table_info("agent_runs")`);

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
        await runner.query(`INSERT INTO agent_runs (id, status) VALUES ('run-1', 'completed')`);
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    it('adds the nullable column, keeps every row (NULL = no cap), and is re-runnable', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.up(runner);
        await runner.release();
        expect((await columnsOf()).filter((c) => c.name === 'budgetCapCents')).toEqual([
            expect.objectContaining({ notnull: 0 }),
        ]);
        expect(await dataSource.query(`SELECT id, "budgetCapCents" FROM agent_runs`)).toEqual([
            { id: 'run-1', budgetCapCents: null },
        ]);
    });

    it('down() removes only the column and keeps the rows', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);
        await migration.down(runner);
        await runner.release();
        expect((await columnsOf()).map((c) => c.name)).toEqual(['id', 'status']);
        expect(await dataSource.query(`SELECT id FROM agent_runs`)).toEqual([{ id: 'run-1' }]);
    });
});
