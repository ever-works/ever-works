import { DataSource, Table } from 'typeorm';
import { AddSchedulePauseColumns1791110010000 } from '../1791110010000-AddSchedulePauseColumns';

/**
 * Schedules — reversible pause columns.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs,
 * asserting against the PHYSICAL schema so a column created under a
 * different name, or as NOT NULL, cannot pass by accident. The load-bearing
 * property is that every existing row reads as "not paused" after `up()`:
 * a deploy must not silently stop anything that fires today.
 */
describe('AddSchedulePauseColumns1791110010000', () => {
    let dataSource: DataSource;
    const migration = new AddSchedulePauseColumns1791110010000();

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
                    { name: 'title', type: 'varchar', length: '500' },
                    { name: 'isRecurring', type: 'boolean', default: false },
                    { name: 'recurrenceCron', type: 'varchar', length: '120', isNullable: true },
                    { name: 'nextOccurrenceAt', type: 'timestamp', isNullable: true },
                ],
            }),
        );
        await runner.createTable(
            new Table({
                name: 'agents',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'status', type: 'varchar', length: '16' },
                    { name: 'heartbeatCadence', type: 'varchar', length: '64', isNullable: true },
                    { name: 'nextHeartbeatAt', type: 'timestamp', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO tasks (id, title, "isRecurring", "recurrenceCron", "nextOccurrenceAt") VALUES (?, ?, ?, ?, ?)`,
            ['task-1', 'Morning inbox scan', 1, '0 7 * * *', '2026-09-15 07:00:00'],
        );
        await runner.query(
            `INSERT INTO agents (id, status, "heartbeatCadence", "nextHeartbeatAt") VALUES (?, ?, ?, ?)`,
            ['agent-1', 'active', '*/15 * * * *', '2026-09-14 10:15:00'],
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

    async function columns(table: string): Promise<Record<string, { notnull: number }>> {
        const rows: Array<{ name: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return Object.fromEntries(rows.map((row) => [row.name, { notnull: row.notnull }]));
    }

    async function indexColumns(index: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_info("${index}")`,
        );
        return rows.map((row) => row.name);
    }

    it('adds both pause columns as nullable', async () => {
        await runUp();
        const tasks = await columns('tasks');
        const agents = await columns('agents');
        expect(tasks.recurrencePausedAt).toBeDefined();
        expect(tasks.recurrencePausedAt.notnull).toBe(0);
        expect(agents.heartbeatPausedAt).toBeDefined();
        expect(agents.heartbeatPausedAt.notnull).toBe(0);
    });

    it('leaves every existing row un-paused with its cadence and next fire intact', async () => {
        await runUp();
        expect(
            await dataSource.query(
                `SELECT "recurrenceCron", "nextOccurrenceAt", "recurrencePausedAt" FROM tasks WHERE id = ?`,
                ['task-1'],
            ),
        ).toEqual([
            {
                recurrenceCron: '0 7 * * *',
                nextOccurrenceAt: '2026-09-15 07:00:00',
                recurrencePausedAt: null,
            },
        ]);
        expect(
            await dataSource.query(
                `SELECT status, "heartbeatCadence", "heartbeatPausedAt" FROM agents WHERE id = ?`,
                ['agent-1'],
            ),
        ).toEqual([
            { status: 'active', heartbeatCadence: '*/15 * * * *', heartbeatPausedAt: null },
        ]);
    });

    it('creates the two due-scan indexes with the pause column in the middle', async () => {
        await runUp();
        expect(await indexColumns('idx_tasks_recurrence_due_active')).toEqual([
            'isRecurring',
            'recurrencePausedAt',
            'nextOccurrenceAt',
        ]);
        expect(await indexColumns('idx_agents_heartbeat_due')).toEqual([
            'status',
            'heartbeatPausedAt',
            'nextHeartbeatAt',
        ]);
    });

    it('is idempotent on re-run and reversible, and a second down() is a no-op', async () => {
        await runUp();
        await runUp();
        expect(Object.keys(await columns('tasks'))).toContain('recurrencePausedAt');

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();

        expect((await columns('tasks')).recurrencePausedAt).toBeUndefined();
        expect((await columns('agents')).heartbeatPausedAt).toBeUndefined();
        expect(await indexColumns('idx_tasks_recurrence_due_active')).toEqual([]);
        expect(await indexColumns('idx_agents_heartbeat_due')).toEqual([]);
        // The data the migration never owned is still there.
        expect(await dataSource.query(`SELECT id FROM tasks`)).toEqual([{ id: 'task-1' }]);

        const again = dataSource.createQueryRunner();
        await expect(migration.down(again)).resolves.toBeUndefined();
        await again.release();
    });

    it('is a no-op when the owning tables do not exist yet (ordering safety)', async () => {
        const runner = dataSource.createQueryRunner();
        await runner.dropTable('tasks');
        await runner.dropTable('agents');
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
        await runner.release();
    });
});
