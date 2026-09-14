import { DataSource, Table } from 'typeorm';
import { AddActivityLogFeedActor1791040000000 } from '../1791040000000-AddActivityLogFeedActor';

/**
 * Executes the Live Feed actor migration against a real (in-memory)
 * better-sqlite3 database — the driver CI and the e2e stack run — rather
 * than only compiling it. A migration that throws mid-run leaves the schema
 * half-applied and, with `migrationsRun: true`, crash-loops every API pod.
 *
 * Lives in `__tests__/` (pinned by `migrations-directory-contract.spec.ts`)
 * so its compiled output never lands in the flat runtime migration glob.
 */
describe('AddActivityLogFeedActor1791040000000', () => {
    let dataSource: DataSource;

    const COLUMNS = ['actorKind', 'actorAgentId', 'actorLabel'];
    const INDEXES = ['idx_activity_log_user_created_id', 'idx_activity_log_user_actor_created'];

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) {
            await dataSource.destroy();
        }
    });

    /** A minimal stand-in for `activity_log` carrying an existing row. */
    async function createActivityLog(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await runner.createTable(
            new Table({
                name: 'activity_log',
                columns: [
                    { name: 'id', type: 'varchar', isPrimary: true },
                    { name: 'userId', type: 'varchar' },
                    { name: 'actionType', type: 'varchar', length: '50' },
                    { name: 'summary', type: 'varchar', length: '500' },
                    { name: 'createdAt', type: 'datetime' },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO activity_log (id, userId, actionType, summary, createdAt) VALUES ('a-1', 'u-1', 'task_created', 'Task created', '2026-09-01 10:00:00.000')`,
        );
        await runner.release();
    }

    async function describeTable() {
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('activity_log');
        await runner.release();
        return table;
    }

    it('adds the three nullable actor columns and both indexes', async () => {
        await createActivityLog();
        const runner = dataSource.createQueryRunner();
        await new AddActivityLogFeedActor1791040000000().up(runner);
        await runner.release();

        const table = await describeTable();
        for (const name of COLUMNS) {
            const column = table?.findColumnByName(name);
            expect(column).toBeDefined();
            expect(column?.isNullable).toBe(true);
        }
        expect(table?.findColumnByName('actorKind')?.length).toBe('16');
        expect(table?.findColumnByName('actorLabel')?.length).toBe('120');

        const indexNames = (table?.indices ?? []).map((index) => index.name);
        expect(indexNames).toEqual(expect.arrayContaining(INDEXES));
        expect(
            table?.indices.find((index) => index.name === 'idx_activity_log_user_created_id')
                ?.columnNames,
        ).toEqual(['userId', 'createdAt', 'id']);
        expect(
            table?.indices.find((index) => index.name === 'idx_activity_log_user_actor_created')
                ?.columnNames,
        ).toEqual(['userId', 'actorAgentId', 'createdAt']);
    });

    it('keeps existing rows and leaves their actor columns NULL (no backfill)', async () => {
        await createActivityLog();
        const runner = dataSource.createQueryRunner();
        await new AddActivityLogFeedActor1791040000000().up(runner);
        const rows = await runner.query(
            `SELECT id, actorKind, actorAgentId, actorLabel FROM activity_log`,
        );
        await runner.release();

        expect(rows).toEqual([
            { id: 'a-1', actorKind: null, actorAgentId: null, actorLabel: null },
        ]);
    });

    it('is idempotent — a second `up` is a no-op, not a duplicate-column error', async () => {
        await createActivityLog();
        const migration = new AddActivityLogFeedActor1791040000000();

        const first = dataSource.createQueryRunner();
        await migration.up(first);
        await first.release();

        const second = dataSource.createQueryRunner();
        await expect(migration.up(second)).resolves.toBeUndefined();
        await second.release();

        const table = await describeTable();
        expect(
            (table?.indices ?? []).filter(
                (index) => index.name === 'idx_activity_log_user_created_id',
            ),
        ).toHaveLength(1);
    });

    it('skips a database without the table instead of aborting the run', async () => {
        const runner = dataSource.createQueryRunner();
        await expect(
            new AddActivityLogFeedActor1791040000000().up(runner),
        ).resolves.toBeUndefined();
        await expect(
            new AddActivityLogFeedActor1791040000000().down(runner),
        ).resolves.toBeUndefined();
        await runner.release();
    });

    it('down removes exactly what up added, keeps the rows, and tolerates a second run', async () => {
        await createActivityLog();
        const migration = new AddActivityLogFeedActor1791040000000();

        const up = dataSource.createQueryRunner();
        await migration.up(up);
        await up.release();

        const down = dataSource.createQueryRunner();
        await migration.down(down);
        await down.release();

        const table = await describeTable();
        for (const name of COLUMNS) {
            expect(table?.findColumnByName(name)).toBeUndefined();
        }
        const indexNames = (table?.indices ?? []).map((index) => index.name);
        for (const name of INDEXES) {
            expect(indexNames).not.toContain(name);
        }
        expect(table?.findColumnByName('summary')).toBeDefined();

        const again = dataSource.createQueryRunner();
        await expect(migration.down(again)).resolves.toBeUndefined();
        const rows = await again.query(`SELECT id FROM activity_log`);
        await again.release();
        expect(rows).toEqual([{ id: 'a-1' }]);
    });
});
