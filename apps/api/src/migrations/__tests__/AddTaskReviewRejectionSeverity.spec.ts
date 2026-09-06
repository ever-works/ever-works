import { DataSource, Table } from 'typeorm';
import { AddTaskReviewRejectionSeverity1788100000000 } from '../1788100000000-AddTaskReviewRejectionSeverity';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters: existing rejections survive reading NULL for both new
 * columns (a human rejection with no stated severity), re-running is a
 * no-op, and `down()` reverses it.
 */
describe('AddTaskReviewRejectionSeverity1788100000000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskReviewRejectionSeverity1788100000000();

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
                name: 'task_review_rejections',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'taskId', type: 'uuid' },
                    { name: 'source', type: 'varchar', length: '16' },
                    { name: 'reviewerLabel', type: 'varchar', length: '200', isNullable: true },
                    { name: 'feedback', type: 'text' },
                    { name: 'prNumber', type: 'int', isNullable: true },
                    { name: 'consumedByRunId', type: 'uuid', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO task_review_rejections (id, "taskId", source, "reviewerLabel", feedback, "prNumber") VALUES (?, ?, ?, ?, ?, ?)`,
            ['rej-1', 'task-1', 'pull-request', 'octocat', 'the migration has no down()', 9],
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

    it('adds nullable severity + reviewerKind and leaves existing rejections unclassified', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('task_review_rejections');
        await runner.release();
        expect(table?.findColumnByName('severity')).toMatchObject({ isNullable: true });
        expect(table?.findColumnByName('reviewerKind')).toMatchObject({ isNullable: true });
        expect(
            await dataSource.query(
                `SELECT id, severity, "reviewerKind" FROM task_review_rejections WHERE id = ?`,
                ['rej-1'],
            ),
        ).toEqual([{ id: 'rej-1', severity: null, reviewerKind: null }]);
    });

    it('accepts a bot finding with its severity once applied', async () => {
        await runUp();
        await dataSource.query(
            `INSERT INTO task_review_rejections (id, "taskId", source, "reviewerLabel", feedback, "prNumber", severity, "reviewerKind") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ['rej-2', 'task-1', 'pull-request', 'coderabbitai[bot]', 'x', 9, 'major', 'bot'],
        );
        expect(
            await dataSource.query(
                `SELECT severity, "reviewerKind" FROM task_review_rejections WHERE id = ?`,
                ['rej-2'],
            ),
        ).toEqual([{ severity: 'major', reviewerKind: 'bot' }]);
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        const runner = dataSource.createQueryRunner();
        expect(
            (await runner.getTable('task_review_rejections'))?.findColumnByName('severity'),
        ).toBeDefined();
        await migration.down(runner);
        const afterDown = await runner.getTable('task_review_rejections');
        expect(afterDown?.findColumnByName('severity')).toBeUndefined();
        expect(afterDown?.findColumnByName('reviewerKind')).toBeUndefined();
        await migration.down(runner);
        expect(
            (await runner.getTable('task_review_rejections'))?.findColumnByName('reviewerKind'),
        ).toBeUndefined();
        await runner.release();
    });

    it('is a no-op when the table does not exist yet (ordering safety)', async () => {
        const runner = dataSource.createQueryRunner();
        await runner.dropTable('task_review_rejections');
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
        await runner.release();
    });
});
