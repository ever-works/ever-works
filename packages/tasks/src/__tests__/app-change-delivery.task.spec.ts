import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * APW-08 T23 — the `app-change-delivery` schedule (plan §6).
 *
 * Pins the registration (id + the ODD-minute cron, one minute after `task-pr-status-sync`), the
 * worker-context boot, the RPC resolution of `TaskDeliveryService`, the batch of 200 (and its
 * env override, clamped to the ceiling), and that the tick hands its failures to the service's
 * per-Task isolation rather than throwing — a tick that one bad Task could abort would strand
 * every other merged change.
 */

const {
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    triggerLoggerInstance,
    StubInternalModule,
    TaskDeliveryServiceToken,
    loggerInfoMock,
} = vi.hoisted(() => {
    class StubInternalModule {}
    class TaskDeliveryServiceToken {}
    return {
        schedulesTaskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn(),
        triggerLoggerInstance: { __kind: 'trigger-logger-instance' },
        StubInternalModule,
        TaskDeliveryServiceToken,
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
    TaskDeliveryService: TaskDeliveryServiceToken,
}));

type ScheduleConfig = { id: string; cron: string; run: () => Promise<unknown> };

const EMPTY = {
    scanned: 0,
    changed: 0,
    closed: 0,
    failed: 0,
    followUpsOpened: 0,
    escalated: 0,
    durationMs: 1,
};

let reconcileMock: ReturnType<typeof vi.fn>;

const importTask = async (): Promise<ScheduleConfig> => {
    vi.resetModules();
    schedulesTaskMock.mockReset();
    await import('../tasks/trigger/app-change-delivery.task');
    const lastCall = schedulesTaskMock.mock.calls[schedulesTaskMock.mock.calls.length - 1];
    return lastCall[0] as ScheduleConfig;
};

describe('appChangeDeliveryTask (APW-08 T23)', () => {
    let appContext: {
        useLogger: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };

    beforeAll(async () => {
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
        delete process.env.APP_CHANGE_DELIVERY_BATCH;
        reconcileMock = vi.fn().mockResolvedValue(EMPTY);
        appContext = {
            useLogger: vi.fn(),
            get: vi.fn().mockImplementation((token: unknown) =>
                token === TaskDeliveryServiceToken ? { reconcile: reconcileMock } : undefined,
            ),
            close: vi.fn().mockResolvedValue(undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
        createTriggerLoggerMock.mockReturnValue(triggerLoggerInstance);
    });

    afterEach(() => {
        delete process.env.APP_CHANGE_DELIVERY_BATCH;
    });

    describe('registration', () => {
        it('registers a schedule task with id "app-change-delivery"', async () => {
            expect((await importTask()).id).toBe('app-change-delivery');
        });

        it('runs every two minutes on the ODD minute, one minute after task-pr-status-sync', async () => {
            expect((await importTask()).cron).toBe('1-59/2 * * * *');
        });
    });

    describe('run()', () => {
        it('boots TriggerInternalModule, resolves TaskDeliveryService and reconciles 200', async () => {
            await (await importTask()).run();
            expect(createApplicationContextMock).toHaveBeenCalledWith(StubInternalModule);
            expect(createTriggerLoggerMock).toHaveBeenCalledWith('AppChangeDelivery');
            expect(appContext.get).toHaveBeenCalledWith(TaskDeliveryServiceToken);
            expect(reconcileMock).toHaveBeenCalledTimes(1);
            expect(reconcileMock).toHaveBeenCalledWith({ limit: 200 });
        });

        it.each([
            ['50', 50],
            ['500', 200],
            ['0', 200],
            ['lots', 200],
        ])('APP_CHANGE_DELIVERY_BATCH=%s reconciles %s', async (raw, expected) => {
            process.env.APP_CHANGE_DELIVERY_BATCH = raw;
            await (await importTask()).run();
            expect(reconcileMock).toHaveBeenCalledWith({ limit: expected });
        });

        it("returns the service's summary — one failing Task is a counter, never a thrown tick", async () => {
            reconcileMock.mockResolvedValueOnce({ ...EMPTY, scanned: 3, changed: 2, failed: 1 });
            const result = await (await importTask()).run();
            expect(result).toMatchObject({ scanned: 3, changed: 2, failed: 1 });
            expect(loggerInfoMock).toHaveBeenCalledWith(
                'app-change-delivery reconciled merged App Work changes',
                expect.objectContaining({ scanned: 3, failed: 1 }),
            );
        });

        it('stays silent on an idle tick', async () => {
            await (await importTask()).run();
            expect(loggerInfoMock).not.toHaveBeenCalled();
        });
    });
});
