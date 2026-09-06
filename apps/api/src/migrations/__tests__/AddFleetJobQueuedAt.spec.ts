import { DataSource, Table } from 'typeorm';
import { AddFleetJobQueuedAt1788200000000 } from '../1788200000000-AddFleetJobQueuedAt';

/**
 * Same in-memory better-sqlite3 harness as the sibling fleet migration
 * specs. What matters (self-build slice S):
 *
 *   - the column is nullable — an unknown age must be representable,
 *     because the sweep never destructively fails one;
 *   - rows that are `queued` at upgrade time are backfilled from
 *     `createdAt` (the stuck rows the SLA exists to settle), every other
 *     status keeps NULL;
 *   - the (status, queuedAt) index exists for the sweep;
 *   - re-running is a no-op and `down()` reverses all of it.
 */
describe('AddFleetJobQueuedAt1788200000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetJobQueuedAt1788200000000();

    const QUEUED_CREATED = '2026-09-01 10:00:00';
    const RUNNING_CREATED = '2026-09-01 11:00:00';

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
                name: 'fleet_jobs',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'status', type: 'varchar', length: '16' },
                    { name: 'createdAt', type: 'datetime' },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO fleet_jobs (id, "userId", status, "createdAt") VALUES (?, ?, ?, ?)`,
            ['job-queued', 'user-1', 'queued', QUEUED_CREATED],
        );
        await runner.query(
            `INSERT INTO fleet_jobs (id, "userId", status, "createdAt") VALUES (?, ?, ?, ?)`,
            ['job-running', 'user-1', 'running', RUNNING_CREATED],
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

    async function rows(): Promise<Array<{ id: string; queuedAt: string | null }>> {
        return dataSource.query(`SELECT id, "queuedAt" FROM fleet_jobs ORDER BY id`);
    }

    it('adds a nullable queuedAt and backfills ONLY the rows that are queued', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const jobs = await runner.getTable('fleet_jobs');
        await runner.release();

        expect(jobs?.findColumnByName('queuedAt')).toMatchObject({ isNullable: true });
        expect(await rows()).toEqual([
            // A queued row's clock starts where the row did.
            { id: 'job-queued', queuedAt: QUEUED_CREATED },
            // An active row is not in the queue; it gets a fresh stamp only
            // when reclaim returns it there.
            { id: 'job-running', queuedAt: null },
        ]);
    });

    it('creates the (status, queuedAt) index the sweep scans on', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const jobs = await runner.getTable('fleet_jobs');
        await runner.release();

        const index = jobs?.indices.find((entry) => entry.name === 'idx_fleet_jobs_queued_at');
        expect(index?.columnNames).toEqual(['status', 'queuedAt']);
    });

    it('is idempotent and down() drops the index and the column without touching rows', async () => {
        await runUp();
        await expect(runUp()).resolves.not.toThrow();
        // The backfill did not re-stamp the already-stamped row.
        expect((await rows())[0]).toEqual({ id: 'job-queued', queuedAt: QUEUED_CREATED });

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        const jobs = await runner.getTable('fleet_jobs');
        await runner.release();

        expect(jobs?.findColumnByName('queuedAt')).toBeUndefined();
        expect(jobs?.indices.some((entry) => entry.name === 'idx_fleet_jobs_queued_at')).toBe(
            false,
        );
        expect(await dataSource.query(`SELECT id, status FROM fleet_jobs ORDER BY id`)).toEqual([
            { id: 'job-queued', status: 'queued' },
            { id: 'job-running', status: 'running' },
        ]);
    });
});
