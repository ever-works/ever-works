import { DataSource, Table } from 'typeorm';
import { AddMissionTaskOutputLease1792380000000 } from '../1792380000000-AddMissionTaskOutputLease';

/**
 * APW-08 T35 (review of #3061) — `missions.taskOutputLeaseUntil`, on the PHYSICAL schema (SQLite
 * recreates the table on an added column, the step that could lose a row), and the lease's
 * compare-and-set as the tick writes it: a second claim while the first is held changes nothing.
 */
describe('AddMissionTaskOutputLease1792380000000', () => {
    let dataSource: DataSource;
    const migration = new AddMissionTaskOutputLease1792380000000();

    const columnsOf = async (): Promise<Array<{ name: string; notnull: number }>> =>
        dataSource.query(`PRAGMA table_info("missions")`);

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
                name: 'missions',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'title', type: 'varchar', length: '200' },
                ],
            }),
        );
        await runner.query(`INSERT INTO missions (id, title) VALUES ('m-1', 'Grow Bookings')`);
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    it('adds the nullable column, keeps every row (NULL = free), and is re-runnable', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.up(runner);
        await runner.release();
        expect((await columnsOf()).filter((c) => c.name === 'taskOutputLeaseUntil')).toEqual([
            expect.objectContaining({ notnull: 0 }),
        ]);
        expect(await dataSource.query(`SELECT id, "taskOutputLeaseUntil" FROM missions`)).toEqual([
            { id: 'm-1', taskOutputLeaseUntil: null },
        ]);
    });

    it('holds one claim at a time, and an expired claim can be taken over', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
        // The tick's claim (`MissionTickService.claimTaskOutputLease`), both instants bound as
        // epoch milliseconds.
        const claim = async (nowMs: number): Promise<boolean> => {
            await dataSource.query(
                `UPDATE missions SET "taskOutputLeaseUntil" = ? WHERE id = ? AND ("taskOutputLeaseUntil" IS NULL OR "taskOutputLeaseUntil" < ?)`,
                [nowMs + 600_000, 'm-1', nowMs],
            );
            const [{ n }] = await dataSource.query(`SELECT changes() AS n`);
            return Number(n) === 1;
        };
        const t0 = Date.UTC(2026, 10, 3, 10, 0, 0);
        expect(await claim(t0)).toBe(true);
        expect(await claim(t0 + 1_000)).toBe(false);
        expect(await claim(t0 + 600_001)).toBe(true);
    });

    it('down() removes only the column and keeps the rows', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);
        await migration.down(runner);
        await runner.release();
        expect((await columnsOf()).map((c) => c.name)).toEqual(['id', 'title']);
        expect(await dataSource.query(`SELECT id FROM missions`)).toEqual([{ id: 'm-1' }]);
    });
});
