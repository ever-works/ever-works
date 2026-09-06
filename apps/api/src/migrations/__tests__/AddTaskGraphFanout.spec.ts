import { DataSource, Table } from 'typeorm';
import { AddTaskGraphFanout1789100000000 } from '../1789100000000-AddTaskGraphFanout';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters: existing template steps survive with no per-step Work and
 * no extra repositories, existing Goals survive with a NULL concurrency
 * ceiling (which the loop reads as the serial 1 it has always run),
 * re-running is a no-op, and `down()` reverses all three.
 */
describe('AddTaskGraphFanout1789100000000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskGraphFanout1789100000000();

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
                name: 'task_template_steps',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'templateId', type: 'uuid' },
                    { name: 'position', type: 'int' },
                    { name: 'title', type: 'varchar', length: '200' },
                ],
            }),
        );
        await runner.createTable(
            new Table({
                name: 'goals',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'title', type: 'varchar', length: '200' },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO task_template_steps (id, "templateId", position, title) VALUES (?, ?, ?, ?)`,
            ['step-1', 'tpl-1', 0, 'Write spec'],
        );
        await runner.query(`INSERT INTO goals (id, "userId", title) VALUES (?, ?, ?)`, [
            'goal-1',
            'user-1',
            'Ship the fleet',
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

    it('adds nullable per-step workId + extraRepos and leaves existing steps single-repo', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const steps = await runner.getTable('task_template_steps');
        await runner.release();

        expect(steps?.findColumnByName('workId')).toMatchObject({ isNullable: true });
        expect(steps?.findColumnByName('extraRepos')).toMatchObject({ isNullable: true });
        expect(
            await dataSource.query(
                `SELECT id, "workId", "extraRepos" FROM task_template_steps WHERE id = ?`,
                ['step-1'],
            ),
        ).toEqual([{ id: 'step-1', workId: null, extraRepos: null }]);
    });

    it('adds a nullable goals.maxConcurrentIterations that leaves existing Goals serial', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const goals = await runner.getTable('goals');
        await runner.release();

        expect(goals?.findColumnByName('maxConcurrentIterations')).toMatchObject({
            isNullable: true,
        });
        // NULL is what the orchestrator reads as "one iteration at a
        // time" — no existing Goal changes speed on deploy.
        expect(
            await dataSource.query(`SELECT id, "maxConcurrentIterations" FROM goals WHERE id = ?`, [
                'goal-1',
            ]),
        ).toEqual([{ id: 'goal-1', maxConcurrentIterations: null }]);
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        const runner = dataSource.createQueryRunner();
        expect(
            (await runner.getTable('task_template_steps'))?.findColumnByName('workId'),
        ).toBeDefined();
        expect(
            (await runner.getTable('goals'))?.findColumnByName('maxConcurrentIterations'),
        ).toBeDefined();

        await migration.down(runner);
        expect(
            (await runner.getTable('task_template_steps'))?.findColumnByName('workId'),
        ).toBeUndefined();
        expect(
            (await runner.getTable('task_template_steps'))?.findColumnByName('extraRepos'),
        ).toBeUndefined();
        expect(
            (await runner.getTable('goals'))?.findColumnByName('maxConcurrentIterations'),
        ).toBeUndefined();

        await migration.down(runner);
        expect(
            (await runner.getTable('task_template_steps'))?.findColumnByName('workId'),
        ).toBeUndefined();
        await runner.release();
    });
});
