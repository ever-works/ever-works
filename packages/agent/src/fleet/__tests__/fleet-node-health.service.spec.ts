import { Logger } from '@nestjs/common';
import { FLEET_HEALTH_SAMPLE_MIN_INTERVAL_MS } from '@ever-works/contracts';
import { FleetNodeHealthService } from '../fleet-node-health.service';
import type { FleetNodeHealthSampleRepository } from '../fleet-node-health-sample.repository';

/**
 * Computer health (FL-03) — the history writer's contract, against a fake
 * repository. The real SQL (roll-up, retention, idempotence) is exercised on
 * sqlite in `fleet-node-health-sample.repository.integration.spec.ts`.
 */
describe('FleetNodeHealthService', () => {
    const NOW = new Date('2026-10-18T09:41:00.000Z');
    let samples: {
        insertRaw: jest.Mock;
        hasHourly: jest.Mock;
        rawInHour: jest.Mock;
        insertHourly: jest.Mock;
        deleteBefore: jest.Mock;
    };
    let warn: jest.SpyInstance;

    beforeEach(() => {
        samples = {
            insertRaw: jest.fn(async () => undefined),
            hasHourly: jest.fn(async () => true),
            rawInHour: jest.fn(async () => []),
            insertHourly: jest.fn(async () => undefined),
            deleteBefore: jest.fn(async () => 0),
        };
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        process.env.FLEET_HEALTH_HISTORY_ENABLED = 'true';
    });

    afterEach(() => {
        warn.mockRestore();
        delete process.env.FLEET_HEALTH_HISTORY_ENABLED;
    });

    const build = () =>
        new FleetNodeHealthService(samples as unknown as FleetNodeHealthSampleRepository);

    describe('shouldSample (FR-18, FR-22)', () => {
        it('samples a node that has never been sampled', () => {
            expect(build().shouldSample(null, NOW)).toBe(true);
            expect(build().shouldSample({}, NOW)).toBe(true);
        });

        it('holds the 55 s floor from the row’s own marker', () => {
            const at = (ms: number) => ({ sampledAt: new Date(NOW.getTime() - ms).toISOString() });
            expect(build().shouldSample(at(FLEET_HEALTH_SAMPLE_MIN_INTERVAL_MS - 1), NOW)).toBe(
                false,
            );
            expect(build().shouldSample(at(FLEET_HEALTH_SAMPLE_MIN_INTERVAL_MS), NOW)).toBe(true);
            expect(build().shouldSample(at(60_000), NOW)).toBe(true);
        });

        it('never samples with the flag off', () => {
            delete process.env.FLEET_HEALTH_HISTORY_ENABLED;
            expect(build().shouldSample(null, NOW)).toBe(false);
        });
    });

    describe('record (U11)', () => {
        it('writes one raw row', () => {
            build().record('n1', NOW, { cpuPercent: 31 });
            expect(samples.insertRaw).toHaveBeenCalledWith('n1', NOW, { cpuPercent: 31 });
        });

        it('never throws — not on a synchronous throw, not on a rejection', async () => {
            samples.insertRaw.mockImplementationOnce(() => {
                throw new Error('pool exhausted');
            });
            expect(() => build().record('n1', NOW, { cpuPercent: 31 })).not.toThrow();
            samples.insertRaw.mockRejectedValueOnce(new Error('disk full'));
            const service = build();
            expect(() => service.record('n2', NOW, { cpuPercent: 31 })).not.toThrow();
            await new Promise((resolve) => setImmediate(resolve));
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
        });

        it('logs a dropped sample once per node per hour, and never the snapshot itself', async () => {
            samples.insertRaw.mockRejectedValue(new Error('disk full'));
            const service = build();
            service.record('n1', NOW, { cpuPercent: 31 });
            service.record('n1', new Date(NOW.getTime() + 60_000), { cpuPercent: 32 });
            service.record('n2', NOW, { cpuPercent: 33 });
            service.record('n1', new Date(NOW.getTime() + 61 * 60_000), { cpuPercent: 34 });
            await new Promise((resolve) => setImmediate(resolve));
            expect(warn).toHaveBeenCalledTimes(3);
            expect(warn.mock.calls.flat().join(' ')).not.toContain('cpuPercent');
        });
    });

    describe('rollupAndPrune', () => {
        it('with the flag off rolls nothing, but rows from before still age out (FR-22)', async () => {
            delete process.env.FLEET_HEALTH_HISTORY_ENABLED;
            samples.deleteBefore.mockImplementation(async (resolution: string) =>
                resolution === 'raw' ? 4 : 1,
            );
            expect(await build().rollupAndPrune(NOW)).toEqual({
                enabled: false,
                rolledHours: 0,
                hourlyRows: 0,
                prunedRaw: 4,
                prunedHourly: 1,
            });
            expect(samples.hasHourly).not.toHaveBeenCalled();
            expect(samples.rawInHour).not.toHaveBeenCalled();
            expect(samples.insertHourly).not.toHaveBeenCalled();
            expect(samples.deleteBefore).toHaveBeenCalledWith(
                'raw',
                new Date(NOW.getTime() - 7 * 24 * 3_600_000),
            );
            expect(samples.deleteBefore).toHaveBeenCalledWith(
                'hourly',
                new Date(NOW.getTime() - 90 * 24 * 3_600_000),
            );
        });

        it('skips hours already rolled up and hours with no samples, and prunes 7 d raw / 90 d hourly', async () => {
            samples.deleteBefore.mockImplementation(async (resolution: string) =>
                resolution === 'raw' ? 5 : 2,
            );
            const summary = await build().rollupAndPrune(NOW);
            expect(summary).toEqual({
                enabled: true,
                rolledHours: 0,
                hourlyRows: 0,
                prunedRaw: 5,
                prunedHourly: 2,
            });
            expect(samples.insertHourly).not.toHaveBeenCalled();
            expect(samples.deleteBefore).toHaveBeenCalledWith(
                'raw',
                new Date(NOW.getTime() - 7 * 24 * 3_600_000),
            );
            expect(samples.deleteBefore).toHaveBeenCalledWith(
                'hourly',
                new Date(NOW.getTime() - 90 * 24 * 3_600_000),
            );
        });

        it('only rolls up hours that have ENDED (with a settle margin), never the current one', async () => {
            samples.hasHourly.mockResolvedValue(false);
            await build().rollupAndPrune(NOW);
            const hours = samples.hasHourly.mock.calls.map(([hour]) =>
                (hour as Date).toISOString(),
            );
            // 09:41 now: the newest hour rolled is 08:00-09:00; 09:00-10:00 is still open.
            expect(hours[hours.length - 1]).toBe('2026-10-18T08:00:00.000Z');
            expect(hours).not.toContain('2026-10-18T09:00:00.000Z');
        });

        const lastHourAsked = async (at: string) => {
            samples.hasHourly.mockReset().mockResolvedValue(false);
            await build().rollupAndPrune(new Date(at));
            const hours = samples.hasHourly.mock.calls.map(([hour]) =>
                (hour as Date).toISOString(),
            );
            return hours[hours.length - 1];
        };

        it('waits the settle margin past the hour: at 09:03 the 08:00 hour is still settling, at 09:06 it rolls', async () => {
            // A beat stamped 08:59:58 may still be in flight at 09:00:01; five
            // minutes past the hour every replica has written it.
            expect(await lastHourAsked('2026-10-18T09:03:00.000Z')).toBe(
                '2026-10-18T07:00:00.000Z',
            );
            expect(await lastHourAsked('2026-10-18T09:04:59.999Z')).toBe(
                '2026-10-18T07:00:00.000Z',
            );
            expect(await lastHourAsked('2026-10-18T09:05:00.000Z')).toBe(
                '2026-10-18T08:00:00.000Z',
            );
            expect(await lastHourAsked('2026-10-18T09:06:00.000Z')).toBe(
                '2026-10-18T08:00:00.000Z',
            );
        });

        it('rolls at most 48 hours a run, OLDEST first, so a backlog drains over several runs', async () => {
            samples.hasHourly.mockResolvedValue(false);
            samples.rawInHour.mockImplementation(async (hour: Date) => [
                {
                    nodeId: 'n1',
                    at: hour,
                    resolution: 'raw',
                    cpuPercent: 10,
                    memPercent: 20,
                    diskPercent: 30,
                },
            ]);
            const summary = await build().rollupAndPrune(NOW);
            expect(summary.rolledHours).toBe(48);
            expect(samples.insertHourly).toHaveBeenCalledTimes(48);
            const rolled = samples.rawInHour.mock.calls.map(([hour]) => (hour as Date).getTime());
            // The first hour rolled is the oldest whose raw rows retention keeps.
            const oldestKept =
                Math.floor((NOW.getTime() - 7 * 24 * 3_600_000) / 3_600_000) * 3_600_000 +
                3_600_000;
            expect(rolled[0]).toBe(oldestKept);
            expect([...rolled].sort((a, b) => a - b)).toEqual(rolled);
            // Retention still ran after the capped roll.
            expect(samples.deleteBefore).toHaveBeenCalledTimes(2);
        });

        it('a roll-up that throws still runs retention, then fails the run', async () => {
            samples.hasHourly.mockResolvedValue(false);
            samples.rawInHour.mockRejectedValue(new Error('database went away'));
            await expect(build().rollupAndPrune(NOW)).rejects.toThrow('database went away');
            expect(samples.deleteBefore).toHaveBeenCalledWith('raw', expect.any(Date));
            expect(samples.deleteBefore).toHaveBeenCalledWith('hourly', expect.any(Date));
        });
    });
});
