import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * EW-628 tests — pin the schedule registration shape and the lifecycle
 * behaviour of {@link dataRepoSyncDispatcherTask}. G7 wires the body to
 * the API-side `DataSyncDispatcherService` via the trigger internal RPC
 * channel; these tests assert that the cron resolves the proxy and
 * fans out to `dispatchDue()`.
 */
const DATA_SYNC_DISPATCHER_SERVICE_TOKEN = 'DataSyncDispatcherService';

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
    DATA_SYNC_DISPATCHER_SERVICE: DATA_SYNC_DISPATCHER_SERVICE_TOKEN,
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

describe('dataRepoSyncDispatcherTask (EW-628)', () => {
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };
    let dispatchDueMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        dispatchDueMock = vi.fn().mockResolvedValue({
            limit: 25,
            dueCount: 0,
            dispatched: 0,
            skipped: 0,
            failed: 0,
            entries: [],
        });
        appContext = {
            useLogger: vi.fn(),
            // EW-628 G7: the cron resolves DataSyncDispatcherService via
            // the proxy token. For the "NestFactoryStaticLogger" lookup
            // (logger fallback) return undefined so console is used.
            get: vi.fn().mockImplementation((token: unknown) => {
                if (token === DATA_SYNC_DISPATCHER_SERVICE_TOKEN) {
                    return { dispatchDue: dispatchDueMock };
                }
                return undefined;
            }),
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

    describe('run() — G7 wired body', () => {
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

        it('resolves DataSyncDispatcherService through the proxy token and calls dispatchDue', async () => {
            const cfg = await importTask();
            await cfg.run();

            expect(appContext.get).toHaveBeenCalledWith(DATA_SYNC_DISPATCHER_SERVICE_TOKEN);
            expect(dispatchDueMock).toHaveBeenCalledTimes(1);
        });

        it('returns the summary envelope from dispatchDue (dueCount/dispatched/skipped/failed)', async () => {
            dispatchDueMock.mockResolvedValueOnce({
                limit: 25,
                dueCount: 4,
                dispatched: 3,
                skipped: 1,
                failed: 0,
                entries: [],
            });
            const cfg = await importTask('*/1 * * * *');
            const result = await cfg.run();

            expect(result).toEqual({
                cron: '*/1 * * * *',
                dueCount: 4,
                dispatched: 3,
                skipped: 1,
                failed: 0,
            });
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
