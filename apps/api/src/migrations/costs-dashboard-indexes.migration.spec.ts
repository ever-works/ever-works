import { DataSource, Table } from 'typeorm';
import { AddCostsDashboardIndexes1786910000000 } from './1786910000000-AddCostsDashboardIndexes';

/**
 * Executes the Costs-dashboard index migration against a real
 * (in-memory) database rather than only compiling it.
 *
 * The failure this catches is the one that hurts in production: a
 * migration that throws mid-run leaves the schema half-applied and, with
 * `migrationsRun: true`, crash-loops every API pod on boot. The three
 * cases below are exactly the states a real deployment can be in — the
 * indexes absent, the indexes already present (re-run / partially
 * applied), and the tables not yet created (fresh database whose table
 * migrations run in a different order).
 *
 * better-sqlite3 is what CI and the e2e stack run, so a Postgres-only
 * construct in the migration would fail here.
 */
describe('AddCostsDashboardIndexes1786910000000', () => {
    let dataSource: DataSource;

    const EXPECTED = [
        ['plugin_usage_events', 'idx_plugin_usage_events_user_agent_occurred'],
        ['plugin_usage_events', 'idx_plugin_usage_events_user_model_occurred'],
        ['agent_runs', 'idx_agent_runs_user_created'],
    ] as const;

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

    /** Minimal stand-ins carrying only the columns the indexes cover. */
    async function createTables(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await runner.createTable(
            new Table({
                name: 'plugin_usage_events',
                columns: [
                    { name: 'id', type: 'varchar', isPrimary: true },
                    { name: 'userId', type: 'varchar' },
                    { name: 'agentId', type: 'varchar', isNullable: true },
                    { name: 'modelId', type: 'varchar', isNullable: true },
                    { name: 'occurredAt', type: 'datetime' },
                ],
            }),
        );
        await runner.createTable(
            new Table({
                name: 'agent_runs',
                columns: [
                    { name: 'id', type: 'varchar', isPrimary: true },
                    { name: 'userId', type: 'varchar' },
                    { name: 'createdAt', type: 'datetime' },
                ],
            }),
        );
        await runner.release();
    }

    async function indexNames(table: string): Promise<string[]> {
        const runner = dataSource.createQueryRunner();
        const meta = await runner.getTable(table);
        await runner.release();
        return (meta?.indices ?? []).map((index) => index.name ?? '');
    }

    it('creates all three indexes on the expected columns', async () => {
        await createTables();
        const runner = dataSource.createQueryRunner();
        await new AddCostsDashboardIndexes1786910000000().up(runner);

        const usageIndexes = await runner.getTable('plugin_usage_events');
        const runIndexes = await runner.getTable('agent_runs');
        await runner.release();

        for (const [table, name] of EXPECTED) {
            await expect(indexNames(table)).resolves.toContain(name);
        }
        expect(
            usageIndexes?.indices.find(
                (index) => index.name === 'idx_plugin_usage_events_user_agent_occurred',
            )?.columnNames,
        ).toEqual(['userId', 'agentId', 'occurredAt']);
        expect(
            runIndexes?.indices.find((index) => index.name === 'idx_agent_runs_user_created')
                ?.columnNames,
        ).toEqual(['userId', 'createdAt']);
    });

    it('is idempotent — a second `up` is a no-op, not a duplicate-name error', async () => {
        await createTables();
        const migration = new AddCostsDashboardIndexes1786910000000();

        const first = dataSource.createQueryRunner();
        await migration.up(first);
        await first.release();

        const second = dataSource.createQueryRunner();
        await expect(migration.up(second)).resolves.toBeUndefined();
        await second.release();

        const names = await indexNames('plugin_usage_events');
        expect(
            names.filter((name) => name === 'idx_plugin_usage_events_user_agent_occurred'),
        ).toHaveLength(1);
    });

    it('skips tables that do not exist yet instead of aborting the run', async () => {
        // No `createTables()` — a fresh database mid-bootstrap.
        const runner = dataSource.createQueryRunner();
        await expect(
            new AddCostsDashboardIndexes1786910000000().up(runner),
        ).resolves.toBeUndefined();
        await runner.release();
    });

    it('down removes exactly what up added, and tolerates a missing index', async () => {
        await createTables();
        const migration = new AddCostsDashboardIndexes1786910000000();

        const up = dataSource.createQueryRunner();
        await migration.up(up);
        await up.release();

        const down = dataSource.createQueryRunner();
        await migration.down(down);
        await down.release();

        for (const [table, name] of EXPECTED) {
            await expect(indexNames(table)).resolves.not.toContain(name);
        }

        // Reverting twice must not throw either.
        const again = dataSource.createQueryRunner();
        await expect(migration.down(again)).resolves.toBeUndefined();
        await again.release();
    });
});
