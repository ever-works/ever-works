import { DataSource, Table } from 'typeorm';
import { AddTaskLinkedPullRequests1787800000000 } from '../1787800000000-AddTaskLinkedPullRequests';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters: existing tasks survive with a NULL list (no linked pull
 * requests), re-running is a no-op, and `down()` reverses it.
 */
describe('AddTaskLinkedPullRequests1787800000000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskLinkedPullRequests1787800000000();

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
                    { name: 'prUrl', type: 'varchar', length: '512', isNullable: true },
                ],
            }),
        );
        await runner.query(`INSERT INTO tasks (id, "userId", title, "prUrl") VALUES (?, ?, ?, ?)`, [
            'task-1',
            'user-1',
            'Add field X',
            'https://github.com/ever-works/ever-works/pull/1',
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

    it('adds a nullable linkedPullRequests column and leaves existing tasks without linked PRs', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const tasks = await runner.getTable('tasks');
        await runner.release();
        expect(tasks?.findColumnByName('linkedPullRequests')).toMatchObject({ isNullable: true });
        expect(
            await dataSource.query(
                `SELECT id, "prUrl", "linkedPullRequests" FROM tasks WHERE id = ?`,
                ['task-1'],
            ),
        ).toEqual([
            {
                id: 'task-1',
                prUrl: 'https://github.com/ever-works/ever-works/pull/1',
                linkedPullRequests: null,
            },
        ]);
    });

    it('stores a JSON list once written', async () => {
        await runUp();
        const list = JSON.stringify([
            {
                repositoryId: 'ever-works/directory-web-template',
                branch: 'task/add-field-x',
                prNumber: 42,
                prUrl: 'https://github.com/ever-works/directory-web-template/pull/42',
                state: 'pr-open',
            },
        ]);
        await dataSource.query(`UPDATE tasks SET "linkedPullRequests" = ? WHERE id = ?`, [
            list,
            'task-1',
        ]);
        const [row] = await dataSource.query(
            `SELECT "linkedPullRequests" FROM tasks WHERE id = ?`,
            ['task-1'],
        );
        expect(JSON.parse(row.linkedPullRequests)).toEqual([
            expect.objectContaining({
                repositoryId: 'ever-works/directory-web-template',
                prNumber: 42,
            }),
        ]);
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        const runner = dataSource.createQueryRunner();
        expect(
            (await runner.getTable('tasks'))?.findColumnByName('linkedPullRequests'),
        ).toBeDefined();
        await migration.down(runner);
        expect(
            (await runner.getTable('tasks'))?.findColumnByName('linkedPullRequests'),
        ).toBeUndefined();
        await migration.down(runner);
        expect(
            (await runner.getTable('tasks'))?.findColumnByName('linkedPullRequests'),
        ).toBeUndefined();
        await runner.release();
    });
});
