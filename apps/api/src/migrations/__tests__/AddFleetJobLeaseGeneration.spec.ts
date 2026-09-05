import { DataSource, Table } from 'typeorm';
import { AddFleetJobLeaseGeneration1788400000000 } from '../1788400000000-AddFleetJobLeaseGeneration';

/**
 * Same in-memory better-sqlite3 harness as the sibling fleet migration
 * specs. What matters: existing jobs survive at generation 0 (no claim
 * minted under the new protocol — which the service refuses, by design),
 * the column is NOT NULL so no row can ever read "unknown generation",
 * re-running is a no-op, and `down()` reverses it without touching rows.
 */
describe('AddFleetJobLeaseGeneration1788400000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetJobLeaseGeneration1788400000000();

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
                    { name: 'nodeId', type: 'uuid', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO fleet_jobs (id, "userId", status, "nodeId") VALUES (?, ?, ?, ?)`,
            ['job-1', 'user-1', 'running', 'node-1'],
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

    it('adds a NOT NULL leaseGeneration that backfills existing jobs to generation 0', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const jobs = await runner.getTable('fleet_jobs');
        await runner.release();
        expect(jobs?.findColumnByName('leaseGeneration')).toMatchObject({
            isNullable: false,
            type: 'int',
        });
        expect(
            await dataSource.query(
                `SELECT id, status, "nodeId", "leaseGeneration" FROM fleet_jobs WHERE id = ?`,
                ['job-1'],
            ),
        ).toEqual([{ id: 'job-1', status: 'running', nodeId: 'node-1', leaseGeneration: 0 }]);
    });

    it('lets a new claim be minted as previous + 1 on the migrated table', async () => {
        await runUp();
        // The lease CAS the service performs: pin the generation it read,
        // write the next one. A plain UPDATE is enough to prove the column
        // accepts the protocol's writes on this driver.
        const result: unknown = await dataSource.query(
            `UPDATE fleet_jobs SET "leaseGeneration" = 1 WHERE id = ? AND "leaseGeneration" = 0`,
            ['job-1'],
        );
        expect(result).toBeDefined();
        expect(
            await dataSource.query(`SELECT "leaseGeneration" FROM fleet_jobs WHERE id = ?`, [
                'job-1',
            ]),
        ).toEqual([{ leaseGeneration: 1 }]);
    });

    it('is idempotent and down() drops the column without touching rows', async () => {
        await runUp();
        await expect(runUp()).resolves.not.toThrow();

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        const jobs = await runner.getTable('fleet_jobs');
        await runner.release();
        expect(jobs?.findColumnByName('leaseGeneration')).toBeUndefined();
        expect(await dataSource.query(`SELECT id FROM fleet_jobs WHERE id = ?`, ['job-1'])).toEqual(
            [{ id: 'job-1' }],
        );
    });
});
