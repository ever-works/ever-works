jest.mock('@ever-works/agent/cache', () => ({}));
jest.mock('@ever-works/agent/skills', () => ({}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: {
            shouldUseTrigger: jest.fn(),
        },
    },
}));

import { SKILL_READINESS_SWEEP_CRON } from '@ever-works/contracts';
import { config } from '@ever-works/agent/config';
import type { DistributedTaskLockService } from '@ever-works/agent/cache';
import type { SkillReadinessService } from '@ever-works/agent/skills';
import { SkillReadinessSweepCronService } from './skill-readiness-sweep-cron.service';

/**
 * Skills shelf — the hourly readiness sweep on installs where Trigger.dev is
 * not the runtime.
 *
 * Mirrors `work-schedule-dispatcher-cron.service.spec.ts`: the same gate
 * (`shouldUseTrigger()` → the Trigger.dev schedule owns the pass), the same
 * distributed lock, and the pass itself is `SkillReadinessService.sweepStale`.
 */
describe('SkillReadinessSweepCronService', () => {
    const shouldUseTrigger = (config as any).trigger.shouldUseTrigger as jest.Mock;
    let readiness: { sweepStale: jest.Mock };
    let taskLockService: { runExclusive: jest.Mock };
    let service: SkillReadinessSweepCronService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    const summary = (over: Record<string, number> = {}) => ({
        scanned: 0,
        changed: 0,
        failed: 0,
        byState: {},
        durationMs: 4,
        ...over,
    });

    beforeEach(() => {
        readiness = { sweepStale: jest.fn().mockResolvedValue(summary()) };
        taskLockService = {
            runExclusive: jest.fn(async (_key: string, fn: () => Promise<unknown>) => {
                const result = await fn();
                return { acquired: true, result };
            }),
        };
        service = new SkillReadinessSweepCronService(
            readiness as unknown as SkillReadinessService,
            taskLockService as unknown as DistributedTaskLockService,
        );
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
        debugSpy = jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
        shouldUseTrigger.mockReturnValue(false);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('fires on the same cron as the Trigger.dev schedule', () => {
        expect(SKILL_READINESS_SWEEP_CRON).toBe('17 * * * *');
        const handler = SkillReadinessSweepCronService.prototype.runHourlySweep;
        const cronMeta = Reflect.getMetadataKeys(handler)
            .map((key) => Reflect.getMetadata(key, handler))
            .find((value) => value && typeof value === 'object' && 'cronTime' in value);
        expect(cronMeta?.cronTime).toBe(SKILL_READINESS_SWEEP_CRON);
    });

    it('leaves the pass to the Trigger.dev schedule when Trigger.dev is the runtime', async () => {
        shouldUseTrigger.mockReturnValue(true);
        await service.runHourlySweep();
        expect(taskLockService.runExclusive).not.toHaveBeenCalled();
        expect(readiness.sweepStale).not.toHaveBeenCalled();
    });

    it('runs one sweep under the distributed lock on any other install', async () => {
        await service.runHourlySweep();
        expect(taskLockService.runExclusive).toHaveBeenCalledWith(
            'skills:readiness-sweep',
            expect.any(Function),
            expect.objectContaining({ ttlMs: 30 * 60 * 1000 }),
        );
        expect(readiness.sweepStale).toHaveBeenCalledTimes(1);
        // Quiet when nothing happened.
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('skips the pass when another replica holds the lock', async () => {
        taskLockService.runExclusive.mockImplementation(
            async (_key: string, _fn: () => Promise<unknown>, opts: { onLocked?: () => void }) => {
                opts.onLocked?.();
                return { acquired: false };
            },
        );
        await service.runHourlySweep();
        expect(readiness.sweepStale).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalledWith(
            'Skipping skill-readiness-sweep pass because another instance holds the task lock',
        );
    });

    it('logs counters only for a pass that did something', async () => {
        readiness.sweepStale.mockResolvedValue(summary({ scanned: 7, changed: 2, failed: 1 }));
        await service.runHourlySweep();
        expect(logSpy).toHaveBeenCalledWith(
            'skill-readiness-sweep pass: 7 scanned, 2 changed, 1 failed (4ms)',
        );
    });

    it('never throws out of the scheduler when the pass fails', async () => {
        const boom = new Error('db down');
        readiness.sweepStale.mockRejectedValue(boom);
        await expect(service.runHourlySweep()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('skill-readiness-sweep pass failed', boom.stack);
    });
});
