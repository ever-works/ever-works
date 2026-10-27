import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FLEET_DESKTOP_RECORDING_GC_CRON } from '@ever-works/contracts';

/**
 * Desktop view & control (FL-07 P2.C, T-40) — pins the recording retention
 * sweep's schedule and body: the cron resolves the `DesktopRecordingService`
 * RPC proxy, calls `sweepExpired()` (and nothing else), logs counters only,
 * and returns the summary. What a pass deletes — object first, row second, a
 * failed object delete left for the next night — is the agent package's
 * (`desktop-recording.service.spec.ts`).
 */
const {
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    loggerInfoMock,
    StubInternalModule,
    StubDesktopRecordingService,
} = vi.hoisted(() => {
    class StubInternalModule {}
    class StubDesktopRecordingService {}
    return {
        schedulesTaskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn(),
        loggerInfoMock: vi.fn(),
        StubInternalModule,
        StubDesktopRecordingService,
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    schedules: { task: schedulesTaskMock },
    task: vi.fn(),
    logger: { info: loggerInfoMock, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: createApplicationContextMock },
}));

vi.mock('@ever-works/agent/computer', () => ({
    DesktopRecordingService: StubDesktopRecordingService,
}));

vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: StubInternalModule,
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: createTriggerLoggerMock,
}));

vi.mock('../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: async (
        loggerName: string,
        fn: (ctx: unknown) => Promise<unknown>,
        module: unknown,
    ) => {
        const ctx = await createApplicationContextMock(module);
        ctx.useLogger(createTriggerLoggerMock(loggerName));
        try {
            return await fn(ctx);
        } finally {
            await ctx.close();
        }
    },
}));

type ScheduleConfig = { id: string; cron: string; run: () => Promise<unknown> };

const importTask = async () => {
    vi.resetModules();
    schedulesTaskMock.mockReset();
    const mod = await import('../tasks/trigger/computer-recording-gc.task');
    const cfg = schedulesTaskMock.mock.calls[schedulesTaskMock.mock.calls.length - 1][0] as ScheduleConfig;
    return { cfg, mod };
};

describe('computerRecordingGcTask', () => {
    let sweepExpired: ReturnType<typeof vi.fn>;
    let appContext: { useLogger: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();
        sweepExpired = vi.fn().mockResolvedValue({ deleted: 2, failed: 1 });
        appContext = {
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) => (token === StubDesktopRecordingService ? { sweepExpired } : undefined)),
            close: vi.fn().mockResolvedValue(undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
    });

    it('registers nightly at 03:23, the cron the API fallback shares', async () => {
        const { cfg, mod } = await importTask();
        expect(cfg.id).toBe('computer-recording-gc');
        expect(cfg.cron).toBe('23 3 * * *');
        expect(cfg.cron).toBe(FLEET_DESKTOP_RECORDING_GC_CRON);
        expect(mod.COMPUTER_RECORDING_GC_CRON).toBe(FLEET_DESKTOP_RECORDING_GC_CRON);
        // Clear of the terminal transcript sweep (03:17).
        expect(cfg.cron).not.toBe('17 3 * * *');
    });

    it('boots TriggerInternalModule, sweeps through the proxy and returns the summary', async () => {
        const { cfg } = await importTask();
        const result = await cfg.run();
        expect(createApplicationContextMock).toHaveBeenCalledWith(StubInternalModule);
        expect(createTriggerLoggerMock).toHaveBeenCalledWith('ComputerRecordingGc');
        expect(sweepExpired).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ status: 'completed', deleted: 2, failed: 1 });
        expect(appContext.close).toHaveBeenCalled();
        const [, payload] = loggerInfoMock.mock.calls[0];
        expect(Object.keys(payload).sort()).toEqual(['deleted', 'failed']);
    });

    it('stays quiet with nothing to do', async () => {
        sweepExpired.mockResolvedValueOnce({ deleted: 0, failed: 0 });
        const { cfg } = await importTask();
        await cfg.run();
        expect(loggerInfoMock).not.toHaveBeenCalled();
    });
});
