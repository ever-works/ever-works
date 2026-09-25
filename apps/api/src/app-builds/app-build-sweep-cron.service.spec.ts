jest.mock('@ever-works/agent/app-builds', () => ({}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: {
            shouldUseTrigger: jest.fn(),
        },
    },
}));

import { APP_BUILD_SWEEP_CRON } from '@ever-works/contracts';
import { config } from '@ever-works/agent/config';
import type { AppBuildSweepService } from '@ever-works/agent/app-builds';
import { AppBuildSweepCronService } from './app-build-sweep-cron.service';

/**
 * APW-05 T21 (first slice) — the Builds sweep on installs where Trigger.dev is
 * not the runtime (plan §7.4, `APW05-G20`).
 *
 * Mirrors `skill-readiness-sweep-cron.service.spec.ts` and
 * `memory-fact-gc-cron.service.spec.ts`: the same gate (`shouldUseTrigger()` →
 * the Trigger.dev schedule owns the pass) and the same cron as the Trigger task.
 * One difference, deliberate: this cron takes NO lock of its own —
 * `AppBuildSweepService.runSweep` takes `app-builds:sweep` itself (the Trigger
 * task reaches it over RPC, where a lock callback cannot travel), and a second
 * `runExclusive` on the same key around it would never acquire.
 */
describe('AppBuildSweepCronService', () => {
    const shouldUseTrigger = (config as any).trigger.shouldUseTrigger as jest.Mock;
    let sweeps: { runSweep: jest.Mock };
    let service: AppBuildSweepCronService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    const summary = (over: Record<string, unknown> = {}) => ({
        skipped: null,
        passesFailed: 0,
        redriveBuilds: 0,
        redriveWorks: 0,
        redriveRequested: 0,
        redriveFailed: 0,
        lostCandidates: 0,
        lostMarked: 0,
        lostFinalized: 0,
        lostFailed: 0,
        ...over,
    });

    beforeEach(() => {
        sweeps = { runSweep: jest.fn().mockResolvedValue(summary()) };
        service = new AppBuildSweepCronService(sweeps as unknown as AppBuildSweepService);
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
        warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        shouldUseTrigger.mockReturnValue(false);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('fires on the same cron as the Trigger.dev schedule', () => {
        expect(APP_BUILD_SWEEP_CRON).toBe('*/2 * * * *');
        const handler = AppBuildSweepCronService.prototype.runSweepTick;
        const cronMeta = Reflect.getMetadataKeys(handler)
            .map((key) => Reflect.getMetadata(key, handler))
            .find((value) => value && typeof value === 'object' && 'cronTime' in value);
        expect(cronMeta?.cronTime).toBe(APP_BUILD_SWEEP_CRON);
    });

    it('leaves the pass to the Trigger.dev schedule when Trigger.dev is the runtime', async () => {
        shouldUseTrigger.mockReturnValue(true);

        await service.runSweepTick();

        expect(sweeps.runSweep).not.toHaveBeenCalled();
    });

    it('runs exactly one sweep on any other install, reading the clock API-side', async () => {
        await service.runSweepTick();

        expect(sweeps.runSweep).toHaveBeenCalledTimes(1);
        expect(sweeps.runSweep).toHaveBeenCalledWith();
        // Quiet when nothing happened.
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('logs counters only for a tick that did something', async () => {
        sweeps.runSweep.mockResolvedValue(
            summary({ redriveWorks: 2, redriveRequested: 2, lostMarked: 1, lostFinalized: 1 }),
        );

        await service.runSweepTick();

        expect(logSpy).toHaveBeenCalledWith(
            'app-build-sweep pass: 2/2 work(s) re-driven, 1 lost (1 finalized), 0 failure(s)',
        );
    });

    it('says so when the service could not take its lock', async () => {
        sweeps.runSweep.mockResolvedValue(summary({ skipped: 'lockUnavailable' }));

        await service.runSweepTick();

        expect(warnSpy).toHaveBeenCalledWith('app-build-sweep pass skipped: lockUnavailable');
    });

    it('never throws out of the scheduler when the pass fails', async () => {
        const boom = new Error('db down');
        sweeps.runSweep.mockRejectedValue(boom);

        await expect(service.runSweepTick()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('app-build-sweep pass failed', boom.stack);
    });
});
