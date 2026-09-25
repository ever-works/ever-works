import { DataSource, Table } from 'typeorm';
import { AddTaskBranchGuardRefusal1792110100000 } from '../1792110100000-AddTaskBranchGuardRefusal';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters: existing tasks survive with a NULL marker (no refusal on
 * record, which is the true history), the column takes the text written
 * later, re-running is a no-op, and `down()` drops only that column.
 */
describe('AddTaskBranchGuardRefusal1792110100000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskBranchGuardRefusal1792110100000();

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
                    { name: 'branchState', type: 'varchar', length: '16', isNullable: true },
                    { name: 'prUrl', type: 'varchar', length: '512', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO tasks (id, "userId", title, "branchState", "prUrl") VALUES (?, ?, ?, ?, ?)`,
            ['task-1', 'user-1', 'Add field X', 'pr-open', 'https://github.com/acme/app/pull/1'],
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

    async function column() {
        const runner = dataSource.createQueryRunner();
        const tasks = await runner.getTable('tasks');
        await runner.release();
        return tasks?.findColumnByName('branchGuardRefusal');
    }

    it('adds a nullable text column and leaves every existing task without a refusal', async () => {
        await runUp();

        expect(await column()).toMatchObject({ isNullable: true, type: 'text' });
        expect(
            await dataSource.query(
                `SELECT id, "branchState", "prUrl", "branchGuardRefusal" FROM tasks WHERE id = ?`,
                ['task-1'],
            ),
        ).toEqual([
            {
                id: 'task-1',
                branchState: 'pr-open',
                prUrl: 'https://github.com/acme/app/pull/1',
                branchGuardRefusal: null,
            },
        ]);
    });

    it('stores a multi-line refusal once written, and clears back to NULL', async () => {
        await runUp();
        const reason = [
            'This change edits paths this Work protects. The branch was pushed, and pull request #1 now contains this change.',
            '',
            'Paths:',
            '- `.github/workflows/ci.yml`',
        ].join('\n');

        await dataSource.query(`UPDATE tasks SET "branchGuardRefusal" = ? WHERE id = ?`, [
            reason,
            'task-1',
        ]);
        const [written] = await dataSource.query(
            `SELECT "branchGuardRefusal" FROM tasks WHERE id = ?`,
            ['task-1'],
        );
        expect(written.branchGuardRefusal).toBe(reason);

        await dataSource.query(`UPDATE tasks SET "branchGuardRefusal" = NULL WHERE id = ?`, [
            'task-1',
        ]);
        const [cleared] = await dataSource.query(
            `SELECT "branchGuardRefusal" FROM tasks WHERE id = ?`,
            ['task-1'],
        );
        expect(cleared.branchGuardRefusal).toBeNull();
    });

    it('is idempotent on re-run and reversible, dropping only its own column', async () => {
        await runUp();
        await runUp();
        expect(await column()).toBeDefined();

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await migration.down(runner);
        const tasks = await runner.getTable('tasks');
        await runner.release();

        expect(tasks?.findColumnByName('branchGuardRefusal')).toBeUndefined();
        expect(tasks?.columns.map((c) => c.name).sort()).toEqual(
            ['branchState', 'id', 'prUrl', 'title', 'userId'].sort(),
        );
        expect(await dataSource.query(`SELECT id FROM tasks`)).toEqual([{ id: 'task-1' }]);
    });

    it('does nothing when the tasks table does not exist', async () => {
        const runner = dataSource.createQueryRunner();
        await runner.dropTable('tasks');
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
        expect(await runner.hasTable('tasks')).toBe(false);
        await runner.release();
    });
});
