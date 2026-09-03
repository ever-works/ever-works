import { DataSource, Table } from 'typeorm';
import { AddFleetJobCancelRequestedAt1787700000000 } from '../1787700000000-AddFleetJobCancelRequestedAt';

/**
 * Same in-memory better-sqlite3 harness as the sibling fleet migration
 * specs. What matters: existing jobs survive with a NULL flag (no
 * cancel requested), re-running is a no-op, and `down()` reverses it.
 */
describe('AddFleetJobCancelRequestedAt1787700000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetJobCancelRequestedAt1787700000000();

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
                ],
            }),
        );
        await runner.query(`INSERT INTO fleet_jobs (id, "userId", status) VALUES (?, ?, ?)`, [
            'job-1',
            'user-1',
            'running',
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

    it('adds a nullable cancelRequestedAt and leaves existing jobs un-flagged', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const jobs = await runner.getTable('fleet_jobs');
        await runner.release();
        expect(jobs?.findColumnByName('cancelRequestedAt')).toMatchObject({ isNullable: true });
        expect(
            await dataSource.query(`SELECT id, "cancelRequestedAt" FROM fleet_jobs WHERE id = ?`, [
                'job-1',
            ]),
        ).toEqual([{ id: 'job-1', cancelRequestedAt: null }]);
    });

    it('is idempotent and down() drops the column without touching rows', async () => {
        await runUp();
        await expect(runUp()).resolves.not.toThrow();

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        const jobs = await runner.getTable('fleet_jobs');
        await runner.release();
        expect(jobs?.findColumnByName('cancelRequestedAt')).toBeUndefined();
        expect(await dataSource.query(`SELECT id FROM fleet_jobs WHERE id = ?`, ['job-1'])).toEqual(
            [{ id: 'job-1' }],
        );
    });
});
