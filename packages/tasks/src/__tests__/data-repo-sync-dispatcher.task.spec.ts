import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 4 (EW-628) tests — pin the schedule registration shape and the
 * lifecycle behaviour of {@link dataRepoSyncDispatcherTask}. Logic is
 * intentionally inert in this commit (the body is a TODO waiting on
 * DataSyncDispatcherService); these tests pin the contract so the
 * follow-up commit can swap the body in without breaking the cron id
 * or the schedule registration.
 */
const {
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    triggerLoggerInstance,
    StubInternalModule,
} = vi.hoisted(() => {
    class StubInternalModule {}
    return {
        schedulesTaskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn(),
        triggerLoggerInstance: { __kind: 'trigger-logger-instance' },
        StubInternalModule,
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    schedules: { task: schedulesTaskMock },
    task: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: createApplicationContextMock },
}));

vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: StubInternalModule,
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: createTriggerLoggerMock,
}));

type ScheduleConfig = {
    id: string;
    cron: string;
    run: () => Promise<unknown>;
};

const importTask = async (cronOverride?: string): Promise<ScheduleConfig> => {
    if (cronOverride !== undefined) {
        process.env.DATA_SYNC_DISPATCHER_CRON = cronOverride;
    } else {
        delete process.env.DATA_SYNC_DISPATCHER_CRON;
    }
    vi.resetModules();
    schedulesTaskMock.mockReset();
    await import('../tasks/trigger/data-repo-sync-dispatcher.task');
    const lastCall = schedulesTaskMock.mock.calls[schedulesTaskMock.mock.calls.length - 1];
    return lastCall[0] as ScheduleConfig;
};

describe('dataRepoSyncDispatcherTask (EW-628 Phase 4)', () => {
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        appContext = {
            useLogger: vi.fn(),
            get: vi.fn().mockReturnValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
        createTriggerLoggerMock.mockReturnValue(triggerLoggerInstance);
    });

    describe('registration', () => {
        it('registers a schedule task with id "data-repo-sync-dispatcher"', async () => {
            const cfg = await importTask();
            expect(cfg.id).toBe('data-repo-sync-dispatcher');
        });

        it('defaults cron to "*/1 * * * *" per spec §7 (Dispatcher cron)', async () => {
            const cfg = await importTask();
            expect(cfg.cron).toBe('*/1 * * * *');
        });

        it('honours DATA_SYNC_DISPATCHER_CRON env override (soak knob without redeploy)', async () => {
            const cfg = await importTask('*/5 * * * *');
            expect(cfg.cron).toBe('*/5 * * * *');
        });

        it('exposes a run() handler', async () => {
            const cfg = await importTask();
            expect(typeof cfg.run).toBe('function');
        });
    });

    describe('run() — Phase 4 inert body', () => {
        it('boots a Nest application context using TriggerInternalModule', async () => {
            const cfg = await importTask();
            await cfg.run();

            expect(createApplicationContextMock).toHaveBeenCalledTimes(1);
            expect(createApplicationContextMock).toHaveBeenCalledWith(StubInternalModule);
        });

        it('installs the trigger logger named "DataRepoSyncDispatcher"', async () => {
            const cfg = await importTask();
            await cfg.run();

            expect(createTriggerLoggerMock).toHaveBeenCalledWith('DataRepoSyncDispatcher');
            expect(appContext.useLogger).toHaveBeenCalledWith(triggerLoggerInstance);
        });

        it('returns the inert summary envelope while the body is a TODO', async () => {
            const cfg = await importTask('*/1 * * * *');
            const result = await cfg.run();

            expect(result).toEqual({ cron: '*/1 * * * *', dispatched: 0, skipped: 0 });
        });

        it('always closes the appContext (try/finally) — even when close() rejects, the error surfaces', async () => {
            const cfg = await importTask();
            const closeErr = new Error('close-failed');
            appContext.close.mockRejectedValueOnce(closeErr);

            await expect(cfg.run()).rejects.toBe(closeErr);
            expect(appContext.close).toHaveBeenCalledTimes(1);
        });

        it('does not leak the context across calls — each run() opens + closes a fresh one', async () => {
            const cfg = await importTask();
            await cfg.run();
            await cfg.run();

            expect(createApplicationContextMock).toHaveBeenCalledTimes(2);
            expect(appContext.close).toHaveBeenCalledTimes(2);
        });
    });
});
