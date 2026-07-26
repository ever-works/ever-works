import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * PR insights (kanban run cockpit, plan 04 M5/M7) — the
 * `task-pr-status-sync` cron.
 *
 * Pins the registration shape (id + cron), the worker-context boot, the
 * RPC resolution of `TaskPrStatusService`, and — the point of the whole
 * milestone — that the THROTTLE KNOBS reach the service. A cron that
 * silently ignores its batch/staleness env vars would burn a provider's
 * rate limit with no operator recourse.
 */

const {
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    triggerLoggerInstance,
    StubInternalModule,
    TaskPrStatusServiceToken,
    loggerInfoMock,
} = vi.hoisted(() => {
    class StubInternalModule {}
    class TaskPrStatusServiceToken {}
    return {
        schedulesTaskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn(),
        triggerLoggerInstance: { __kind: 'trigger-logger-instance' },
        StubInternalModule,
        TaskPrStatusServiceToken,
        loggerInfoMock: vi.fn(),
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

vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: StubInternalModule,
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: createTriggerLoggerMock,
}));

vi.mock('@ever-works/agent/tasks-domain', () => ({
    TaskPrStatusService: TaskPrStatusServiceToken,
}));

type ScheduleConfig = {
    id: string;
    cron: string;
    run: () => Promise<unknown>;
};

const EMPTY_SUMMARY = { scanned: 0, refreshed: 0, merged: 0, completed: 0, failed: 0 };

let syncMock: ReturnType<typeof vi.fn>;

const importTask = async (): Promise<ScheduleConfig> => {
    vi.resetModules();
    schedulesTaskMock.mockReset();
    await import('../tasks/trigger/task-pr-status-sync.task');
    const lastCall = schedulesTaskMock.mock.calls[schedulesTaskMock.mock.calls.length - 1];
    return lastCall[0] as ScheduleConfig;
};

describe('taskPrStatusSyncTask (kanban M5)', () => {
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };

    // Cold-import the task graph ONCE inside a hook. Task specs pay a
    // real transform cost on first import (the repo's vitest config
    // documents cold imports measured past 30s on saturated runners);
    // hooks get the 120s budget, individual tests only get 30s, so the
    // warm-up belongs here rather than inside the first `it`.
    beforeAll(async () => {
        syncMock = vi.fn().mockResolvedValue(EMPTY_SUMMARY);
        createApplicationContextMock.mockResolvedValue({
            useLogger: vi.fn(),
            get: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        });
        createTriggerLoggerMock.mockReturnValue(triggerLoggerInstance);
        await importTask();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.TASK_PR_STATUS_SYNC_BATCH;
        delete process.env.TASK_PR_STATUS_SYNC_STALE_SECONDS;
        syncMock = vi.fn().mockResolvedValue(EMPTY_SUMMARY);
        appContext = {
            useLogger: vi.fn(),
            get: vi.fn().mockImplementation((token: unknown) => {
                if (token === TaskPrStatusServiceToken) {
                    return { syncDuePrStatuses: syncMock };
                }
                return undefined;
            }),
            close: vi.fn().mockResolvedValue(undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
        createTriggerLoggerMock.mockReturnValue(triggerLoggerInstance);
    });

    afterEach(() => {
        delete process.env.TASK_PR_STATUS_SYNC_BATCH;
        delete process.env.TASK_PR_STATUS_SYNC_STALE_SECONDS;
    });

    describe('registration', () => {
        it('registers a schedule task with id "task-pr-status-sync"', async () => {
            expect((await importTask()).id).toBe('task-pr-status-sync');
        });

        it('runs every two minutes — the board must not lag CI by more', async () => {
            expect((await importTask()).cron).toBe('*/2 * * * *');
        });

        it('exposes a run() handler', async () => {
            expect(typeof (await importTask()).run).toBe('function');
        });
    });

    describe('run()', () => {
        it('boots the worker context on TriggerInternalModule', async () => {
            await (await importTask()).run();
            expect(createApplicationContextMock).toHaveBeenCalledWith(StubInternalModule);
        });

        it('installs the trigger logger named "TaskPrStatusSync"', async () => {
            await (await importTask()).run();
            expect(createTriggerLoggerMock).toHaveBeenCalledWith('TaskPrStatusSync');
            expect(appContext.useLogger).toHaveBeenCalledWith(triggerLoggerInstance);
        });

        it('resolves TaskPrStatusService over RPC and sweeps', async () => {
            await (await importTask()).run();
            expect(appContext.get).toHaveBeenCalledWith(TaskPrStatusServiceToken);
            expect(syncMock).toHaveBeenCalledTimes(1);
        });

        it('leaves the throttle to the service defaults when no env is set', async () => {
            await (await importTask()).run();
            expect(syncMock).toHaveBeenCalledWith({ limit: undefined, staleSeconds: undefined });
        });

        it('forwards the operator batch + staleness knobs', async () => {
            process.env.TASK_PR_STATUS_SYNC_BATCH = '5';
            process.env.TASK_PR_STATUS_SYNC_STALE_SECONDS = '600';
            await (await importTask()).run();
            expect(syncMock).toHaveBeenCalledWith({ limit: 5, staleSeconds: 600 });
        });

        it('ignores junk env values instead of passing NaN into the sweep', async () => {
            process.env.TASK_PR_STATUS_SYNC_BATCH = 'lots';
            await (await importTask()).run();
            expect(syncMock).toHaveBeenCalledWith({ limit: undefined, staleSeconds: undefined });
        });

        it('returns the sweep summary', async () => {
            syncMock.mockResolvedValueOnce({
                scanned: 4,
                refreshed: 4,
                merged: 1,
                completed: 1,
                failed: 0,
            });
            const result = await (await importTask()).run();
            expect(result).toMatchObject({ scanned: 4, refreshed: 4, merged: 1, completed: 1 });
        });

        it('stays silent on an idle tick — no log noise every 2 minutes', async () => {
            await (await importTask()).run();
            expect(loggerInfoMock).not.toHaveBeenCalled();
        });

        it('logs when it actually refreshed something', async () => {
            syncMock.mockResolvedValueOnce({ ...EMPTY_SUMMARY, scanned: 1, refreshed: 1 });
            await (await importTask()).run();
            expect(loggerInfoMock).toHaveBeenCalledWith(
                'task-pr-status-sync refreshed pull-request status',
                expect.objectContaining({ refreshed: 1 }),
            );
        });

        it('logs failures even when nothing refreshed', async () => {
            syncMock.mockResolvedValueOnce({ ...EMPTY_SUMMARY, scanned: 2, failed: 2 });
            await (await importTask()).run();
            expect(loggerInfoMock).toHaveBeenCalledTimes(1);
        });
    });
});
