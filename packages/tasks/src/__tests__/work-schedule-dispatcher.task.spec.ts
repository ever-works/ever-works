import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    triggerLoggerInstance,
    getDispatchIntervalMinutesMock,
    WorkScheduleDispatcherServiceToken,
    StubInternalModule,
} = vi.hoisted(() => {
    class WorkScheduleDispatcherServiceToken {}
    class StubInternalModule {}
    return {
        schedulesTaskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn(),
        triggerLoggerInstance: { __kind: 'trigger-logger-instance' },
        getDispatchIntervalMinutesMock: vi.fn(),
        WorkScheduleDispatcherServiceToken,
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

vi.mock('@ever-works/agent/config', () => ({
    config: {
        subscriptions: {
            getDispatchIntervalMinutes: getDispatchIntervalMinutesMock,
        },
    },
}));

vi.mock('@ever-works/agent/services', () => ({
    WorkScheduleDispatcherService: WorkScheduleDispatcherServiceToken,
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

let registeredConfig: ScheduleConfig;

const importTask = async (intervalMinutes: number) => {
    getDispatchIntervalMinutesMock.mockReturnValue(intervalMinutes);
    vi.resetModules();
    schedulesTaskMock.mockReset();
    await import('../tasks/trigger/work-schedule-dispatcher.task');
    const lastCall = schedulesTaskMock.mock.calls[schedulesTaskMock.mock.calls.length - 1];
    return lastCall[0] as ScheduleConfig;
};

describe('workScheduleDispatcherTask', () => {
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };
    let dispatcher: { dispatchDue: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
        vi.clearAllMocks();

        appContext = {
            useLogger: vi.fn(),
            get: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        dispatcher = { dispatchDue: vi.fn() };
        appContext.get.mockImplementation((token: any) => {
            if (token === WorkScheduleDispatcherServiceToken) return dispatcher;
            throw new Error(`Unexpected DI token: ${String(token)}`);
        });
        createApplicationContextMock.mockResolvedValue(appContext);
        createTriggerLoggerMock.mockReturnValue(triggerLoggerInstance);
    });

    describe('registration', () => {
        it('registers a schedule task with id "work-schedule-dispatcher"', async () => {
            registeredConfig = await importTask(5);
            expect(registeredConfig.id).toBe('work-schedule-dispatcher');
        });

        it('builds a "*/<n> * * * *" cron expression from getDispatchIntervalMinutes()', async () => {
            registeredConfig = await importTask(5);
            expect(registeredConfig.cron).toBe('*/5 * * * *');
        });

        it('floors the interval at 1 minute when getDispatchIntervalMinutes() returns 0', async () => {
            registeredConfig = await importTask(0);
            expect(registeredConfig.cron).toBe('*/1 * * * *');
        });

        it('floors the interval at 1 minute when getDispatchIntervalMinutes() returns a negative value', async () => {
            registeredConfig = await importTask(-30);
            expect(registeredConfig.cron).toBe('*/1 * * * *');
        });

        it('honours large intervals verbatim (e.g. 60 → "*/60 * * * *")', async () => {
            registeredConfig = await importTask(60);
            expect(registeredConfig.cron).toBe('*/60 * * * *');
        });

        it('exposes a run() handler', async () => {
            registeredConfig = await importTask(5);
            expect(typeof registeredConfig.run).toBe('function');
        });
    });

    describe('run()', () => {
        beforeEach(async () => {
            registeredConfig = await importTask(5);
        });

        it('boots a Nest application context using TriggerInternalModule', async () => {
            dispatcher.dispatchDue.mockResolvedValueOnce({ dispatched: 0, skipped: 0 });
            await registeredConfig.run();

            expect(createApplicationContextMock).toHaveBeenCalledTimes(1);
            expect(createApplicationContextMock).toHaveBeenCalledWith(StubInternalModule);
        });

        it('installs the trigger logger with name "ScheduleDispatcher" before resolving the dispatcher', async () => {
            const order: string[] = [];
            appContext.useLogger.mockImplementation(() => order.push('useLogger'));
            appContext.get.mockImplementation(() => {
                order.push('get-dispatcher');
                return dispatcher;
            });
            dispatcher.dispatchDue.mockResolvedValueOnce({ dispatched: 0, skipped: 0 });

            await registeredConfig.run();

            expect(createTriggerLoggerMock).toHaveBeenCalledWith('ScheduleDispatcher');
            expect(appContext.useLogger).toHaveBeenCalledWith(triggerLoggerInstance);
            expect(order).toEqual(['useLogger', 'get-dispatcher']);
        });

        it('returns {intervalMinutes, ...summary} envelope from dispatchDue()', async () => {
            dispatcher.dispatchDue.mockResolvedValueOnce({
                dispatched: 4,
                skipped: 1,
                failed: 0,
            });

            const result = await registeredConfig.run();
            expect(result).toEqual({
                intervalMinutes: 5,
                dispatched: 4,
                skipped: 1,
                failed: 0,
            });
        });

        it('always closes the appContext after a successful run', async () => {
            dispatcher.dispatchDue.mockResolvedValueOnce({ dispatched: 0 });
            await registeredConfig.run();

            expect(appContext.close).toHaveBeenCalledTimes(1);
        });

        it('always closes the appContext when dispatchDue throws — and re-throws the original error', async () => {
            const err = new Error('dispatch-died');
            dispatcher.dispatchDue.mockRejectedValueOnce(err);

            await expect(registeredConfig.run()).rejects.toBe(err);
            expect(appContext.close).toHaveBeenCalledTimes(1);
        });

        it('does NOT swallow appContext.close() errors when both close and body fail (try/finally semantics)', async () => {
            const bodyErr = new Error('body-failed');
            const closeErr = new Error('close-failed');
            dispatcher.dispatchDue.mockRejectedValueOnce(bodyErr);
            appContext.close.mockRejectedValueOnce(closeErr);

            await expect(registeredConfig.run()).rejects.toBe(closeErr);
        });

        it('falls through any close() error even on a successful body', async () => {
            dispatcher.dispatchDue.mockResolvedValueOnce({ dispatched: 0 });
            appContext.close.mockRejectedValueOnce(new Error('close-failed'));

            await expect(registeredConfig.run()).rejects.toThrow('close-failed');
        });

        it('does not leak the dispatcher singleton across calls (each call resolves freshly)', async () => {
            dispatcher.dispatchDue.mockResolvedValue({ dispatched: 0 });
            await registeredConfig.run();
            await registeredConfig.run();

            expect(createApplicationContextMock).toHaveBeenCalledTimes(2);
            expect(appContext.close).toHaveBeenCalledTimes(2);
        });
    });
});
