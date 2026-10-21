import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { FleetNodeHealthSample } from '../../entities/fleet-node-health-sample.entity';
import {
    FleetNodeHealthSampleRepository,
    hourStart,
    rollUpHour,
} from '../fleet-node-health-sample.repository';
import { FleetNodeHealthService } from '../fleet-node-health.service';

/**
 * Computer health (FL-03) — the history SQL against a REAL schema
 * (better-sqlite3, synchronize from the entities, as CI and the e2e stack
 * run). What only a real database can prove: the roll-up's hour windows,
 * insert-or-ignore on the unique key (a re-run inserts nothing), and the
 * retention boundaries.
 */
describe('fleet node health history (better-sqlite3)', () => {
    const NODE_A = '11111111-1111-4111-8111-111111111111';
    const NODE_B = '22222222-2222-4222-8222-222222222222';
    const NOW = new Date('2026-10-18T09:41:00.000Z');
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;

    let dataSource: DataSource;
    let rows: Repository<FleetNodeHealthSample>;
    let repository: FleetNodeHealthSampleRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        rows = dataSource.getRepository(FleetNodeHealthSample);
        repository = new FleetNodeHealthSampleRepository(rows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(() => {
        process.env.FLEET_HEALTH_HISTORY_ENABLED = 'true';
    });

    afterEach(async () => {
        delete process.env.FLEET_HEALTH_HISTORY_ENABLED;
        await rows.clear();
    });

    const at = (iso: string) => new Date(iso);

    it('stores a raw row with every reported field, and the GPU list as JSON', async () => {
        await repository.insertRaw(NODE_A, at('2026-10-18T08:10:00.000Z'), {
            cpuPercent: 31.2,
            memPercent: 58,
            memTotalMiB: 16384,
            diskPercent: 40,
            diskFreeMiB: 120832,
            loadAvg1: 1.93,
            uptimeSec: 273600,
            gpu: [{ vendor: 'nvidia', name: 'RTX 4070', utilPercent: 12 }],
            pendingReboot: false,
            failedServices: 1,
        });
        const [row] = await repository.findForNodes([NODE_A]);
        expect(row).toMatchObject({
            nodeId: NODE_A,
            resolution: 'raw',
            cpuPercent: 31.2,
            gpu: [{ vendor: 'nvidia', name: 'RTX 4070', utilPercent: 12 }],
            pendingReboot: false,
            failedServices: 1,
            cpuMax: null,
        });
        expect(row.at.toISOString()).toBe('2026-10-18T08:10:00.000Z');
    });

    it('reads exactly one hour: the first instant in, the next hour’s first instant out', async () => {
        await repository.insertRaw(NODE_A, at('2026-10-18T07:59:59.999Z'), { cpuPercent: 1 });
        await repository.insertRaw(NODE_A, at('2026-10-18T08:00:00.000Z'), { cpuPercent: 2 });
        await repository.insertRaw(NODE_A, at('2026-10-18T08:59:59.999Z'), { cpuPercent: 3 });
        await repository.insertRaw(NODE_A, at('2026-10-18T09:00:00.000Z'), { cpuPercent: 4 });
        const inHour = await repository.rawInHour(at('2026-10-18T08:00:00.000Z'));
        expect(inHour.map((row) => row.cpuPercent)).toEqual([2, 3]);
    });

    it('rolls each node’s hour into one hourly row of means and peaks — and a re-run inserts nothing', async () => {
        for (const [minute, cpu, mem, disk] of [
            [5, 10, 40, 50],
            [25, 30, 60, 50],
            [45, 80, 50, 52],
        ] as const) {
            await repository.insertRaw(
                NODE_A,
                at(`2026-10-18T08:${String(minute).padStart(2, '0')}:00.000Z`),
                {
                    cpuPercent: cpu,
                    memPercent: mem,
                    diskPercent: disk,
                    failedServices: minute === 25 ? 2 : 0,
                    pendingReboot: minute === 45,
                },
            );
        }
        await repository.insertRaw(NODE_B, at('2026-10-18T08:30:00.000Z'), { cpuPercent: 7 });

        const service = new FleetNodeHealthService(repository);
        const first = await service.rollupAndPrune(NOW);
        expect(first).toMatchObject({ enabled: true, rolledHours: 1, hourlyRows: 2 });

        const hourly = (await repository.findForNodes([NODE_A, NODE_B])).filter(
            (row) => row.resolution === 'hourly',
        );
        const a = hourly.find((row) => row.nodeId === NODE_A);
        expect(a).toMatchObject({
            cpuPercent: 40,
            memPercent: 50,
            diskPercent: 50.7,
            cpuMax: 80,
            memMax: 60,
            diskMax: 52,
            failedServices: 2,
            pendingReboot: true,
            gpu: null,
        });
        expect(a?.at.toISOString()).toBe('2026-10-18T08:00:00.000Z');
        expect(hourly.find((row) => row.nodeId === NODE_B)).toMatchObject({
            cpuPercent: 7,
            cpuMax: 7,
            memPercent: null,
        });

        const second = await service.rollupAndPrune(NOW);
        expect(second).toMatchObject({ rolledHours: 0, hourlyRows: 0 });
        // Insert-or-ignore on the unique key: even a forced re-insert is a no-op.
        await repository.insertHourly([rollUpHour(NODE_A, at('2026-10-18T08:00:00.000Z'), [])]);
        expect(
            (await repository.findForNodes([NODE_A])).filter((row) => row.resolution === 'hourly'),
        ).toHaveLength(1);
    });

    it('prunes raw rows past 7 days and hourly rows past 90 days, at the boundary minute', async () => {
        const rawCutoff = NOW.getTime() - 7 * DAY;
        const hourlyCutoff = NOW.getTime() - 90 * DAY;
        await repository.insertRaw(NODE_A, new Date(rawCutoff - 60_000), { cpuPercent: 1 });
        await repository.insertRaw(NODE_A, new Date(rawCutoff + 60_000), { cpuPercent: 2 });
        await repository.insertHourly([
            rollUpHour(NODE_A, hourStart(hourlyCutoff - HOUR), []),
            rollUpHour(NODE_A, hourStart(hourlyCutoff + HOUR), []),
        ]);

        const summary = await new FleetNodeHealthService(repository).rollupAndPrune(NOW);
        expect(summary.prunedRaw).toBe(1);
        expect(summary.prunedHourly).toBe(1);
        const left = await repository.findForNodes([NODE_A]);
        expect(left.filter((row) => row.resolution === 'raw').map((row) => row.cpuPercent)).toEqual(
            [2],
        );
        // Only the surviving hourly row: the raw survivor sits in the hour the
        // cutoff cuts through, which is never rolled — its earlier minutes are
        // already gone, and a mean of what is left would misstate the hour.
        const hourlyLeft = left.filter((row) => row.resolution === 'hourly');
        expect(hourlyLeft.map((row) => row.at.toISOString())).toEqual([
            hourStart(hourlyCutoff + HOUR).toISOString(),
        ]);

        // Idempotent: the next pass deletes nothing more.
        expect(await new FleetNodeHealthService(repository).rollupAndPrune(NOW)).toMatchObject({
            prunedRaw: 0,
            prunedHourly: 0,
        });
    });

    it('hasHourly finds an hour by its exact start, through the same date handling as the writes', async () => {
        await repository.insertHourly([rollUpHour(NODE_A, at('2026-10-18T05:00:00.000Z'), [])]);
        expect(await repository.hasHourly(at('2026-10-18T05:00:00.000Z'))).toBe(true);
        expect(await repository.hasHourly(at('2026-10-18T06:00:00.000Z'))).toBe(false);
    });

    it('writes an hour for a large fleet in chunks — past one statement’s parameter cap — and stays idempotent', async () => {
        // 2 500 nodes × ~18 bound parameters is ~45 000: one statement would
        // pass sqlite's 32 766 cap; five chunks of 500 never come near it.
        const hour = at('2026-10-18T04:00:00.000Z');
        const fleet = Array.from({ length: 2_500 }, (_, index) =>
            rollUpHour(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, hour, [
                {
                    cpuPercent: index % 100,
                    memPercent: 50,
                    diskPercent: 40,
                } as FleetNodeHealthSample,
            ]),
        );
        await repository.insertHourly(fleet);
        expect(await rows.count({ where: { resolution: 'hourly' } })).toBe(2_500);
        // A re-run (a second replica, a retried task) inserts nothing new.
        await repository.insertHourly(fleet);
        expect(await rows.count({ where: { resolution: 'hourly' } })).toBe(2_500);
    });

    it('a failure in a LATER chunk writes nothing of the hour — it is never left half done', async () => {
        const hour = at('2026-10-18T03:00:00.000Z');
        const fleet = Array.from({ length: 900 }, (_, index) =>
            rollUpHour(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, hour, [
                { cpuPercent: 10, memPercent: 50, diskPercent: 40 } as FleetNodeHealthSample,
            ]),
        );
        // Row 700 sits in the second chunk and cannot be bound by the driver.
        (fleet[700] as unknown as { cpuPercent: unknown }).cpuPercent = { not: 'a number' };
        await expect(repository.insertHourly(fleet)).rejects.toThrow();
        // The first chunk rolled back with it, so the next pass still sees the
        // hour as not rolled and writes all of it.
        expect(await rows.count({ where: { resolution: 'hourly' } })).toBe(0);
        expect(await repository.hasHourly(hour)).toBe(false);
    });
});
