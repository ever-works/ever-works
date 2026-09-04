import { DataSource, Table } from 'typeorm';
import { AddTaskExtraRepos1787900000000 } from '../1787900000000-AddTaskExtraRepos';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters: existing tasks survive with a NULL list (no extra
 * repositories), re-running is a no-op, and `down()` reverses it.
 */
describe('AddTaskExtraRepos1787900000000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskExtraRepos1787900000000();

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
                name: 'tasks',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'title', type: 'varchar', length: '200' },
                ],
            }),
        );
        await runner.query(`INSERT INTO tasks (id, "userId", title) VALUES (?, ?, ?)`, [
            'task-1',
            'user-1',
            'Add field X',
        ]);
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

    it('adds a nullable extraRepos column and leaves existing tasks without extra repositories', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const tasks = await runner.getTable('tasks');
        await runner.release();
        expect(tasks?.findColumnByName('extraRepos')).toMatchObject({ isNullable: true });
        expect(
            await dataSource.query(`SELECT id, "extraRepos" FROM tasks WHERE id = ?`, ['task-1']),
        ).toEqual([{ id: 'task-1', extraRepos: null }]);
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        const runner = dataSource.createQueryRunner();
        expect((await runner.getTable('tasks'))?.findColumnByName('extraRepos')).toBeDefined();
        await migration.down(runner);
        expect((await runner.getTable('tasks'))?.findColumnByName('extraRepos')).toBeUndefined();
        await migration.down(runner);
        expect((await runner.getTable('tasks'))?.findColumnByName('extraRepos')).toBeUndefined();
        await runner.release();
    });
});
