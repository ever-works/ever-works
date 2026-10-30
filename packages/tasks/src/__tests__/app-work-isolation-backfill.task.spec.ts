import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * APW-08 T50 — the ONE-SHOT `app-work-isolation-backfill` task.
 *
 * Pins the registration (a plain `task`, never a schedule), the worker-context boot, the RPC
 * resolution of `AppWorkIsolationBackfillRunner`, and the page loop: it follows the runner's
 * `nextAfterId` until `done`, totals every page, forwards `dryRun` and the page size, and stops —
 * rather than spinning — when a page that was not the last fails to move the cursor.
 */

const {
    taskMock,
    schedulesTaskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    triggerLoggerInstance,
    StubInternalModule,
    RunnerToken,
    loggerInfoMock,
} = vi.hoisted(() => {
    class StubInternalModule {}
    class RunnerToken {}
    return {
        taskMock: vi.fn((config: unknown) => config),
        schedulesTaskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn(),
        triggerLoggerInstance: { __kind: 'trigger-logger-instance' },
        StubInternalModule,
        RunnerToken,
        loggerInfoMock: vi.fn(),
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    task: taskMock,
    schedules: { task: schedulesTaskMock },
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
    AppWorkIsolationBackfillRunner: RunnerToken,
}));

type TaskConfig = { id: string; maxDuration?: number; run: (payload: unknown) => Promise<unknown> };

function page(over: Record<string, unknown> = {}) {
    return {
        scanned: 0,
        updated: 0,
        skipped: 0,
        unresolved: 0,
        failed: 0,
        bySource: { spec: 0, tracked: 0, repository: 0 },
        unresolvedWorkIds: [],
        failedWorkIds: [],
        nextAfterId: null,
        done: true,
        dryRun: false,
        durationMs: 1,
        ...over,
    };
}

let runMock: ReturnType<typeof vi.fn>;

const importTask = async (): Promise<TaskConfig> => {
    vi.resetModules();
    taskMock.mockClear();
    await import('../tasks/trigger/app-work-isolation-backfill.task');
    return taskMock.mock.calls[taskMock.mock.calls.length - 1][0] as TaskConfig;
};

describe('appWorkIsolationBackfillTask (APW-08 T50)', () => {
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
        runMock = vi.fn().mockResolvedValue(page());
        appContext = {
            useLogger: vi.fn(),
            get: vi
                .fn()
                .mockImplementation((token: unknown) =>
                    token === RunnerToken ? { run: runMock } : undefined,
                ),
            close: vi.fn().mockResolvedValue(undefined),
        };
        createApplicationContextMock.mockResolvedValue(appContext);
        createTriggerLoggerMock.mockReturnValue(triggerLoggerInstance);
    });

    describe('registration', () => {
        it('registers a one-shot task with id "app-work-isolation-backfill" — never a schedule', async () => {
            const config = await importTask();
            expect(config.id).toBe('app-work-isolation-backfill');
            expect(schedulesTaskMock).not.toHaveBeenCalled();
        });
    });

    describe('run()', () => {
        it('boots TriggerInternalModule and resolves the runner over the RPC channel', async () => {
            await (await importTask()).run({});
            expect(createApplicationContextMock).toHaveBeenCalledWith(StubInternalModule);
            expect(createTriggerLoggerMock).toHaveBeenCalledWith('AppWorkIsolationBackfill');
            expect(appContext.get).toHaveBeenCalledWith(RunnerToken);
            expect(runMock).toHaveBeenCalledTimes(1);
            expect(runMock).toHaveBeenCalledWith({ afterId: null, dryRun: false });
        });

        it('follows nextAfterId page by page until done, and totals every page', async () => {
            runMock
                .mockResolvedValueOnce(
                    page({
                        scanned: 2,
                        updated: 1,
                        unresolved: 1,
                        bySource: { spec: 1, tracked: 0, repository: 0 },
                        unresolvedWorkIds: ['w-2'],
                        nextAfterId: 'w-2',
                        done: false,
                    }),
                )
                .mockResolvedValueOnce(
                    page({
                        scanned: 1,
                        updated: 1,
                        bySource: { spec: 0, tracked: 0, repository: 1 },
                        nextAfterId: 'w-3',
                        done: true,
                    }),
                );

            const result = await (await importTask()).run({ pageSize: 2 });

            expect(runMock.mock.calls).toEqual([
                [{ afterId: null, dryRun: false, limit: 2 }],
                [{ afterId: 'w-2', dryRun: false, limit: 2 }],
            ]);
            expect(result).toMatchObject({
                status: 'completed',
                reason: null,
                pages: 2,
                scanned: 3,
                updated: 2,
                unresolved: 1,
                bySource: { spec: 1, tracked: 0, repository: 1 },
                unresolvedWorkIds: ['w-2'],
            });
            expect(loggerInfoMock).toHaveBeenCalledWith(
                'app-work-isolation-backfill finished',
                expect.objectContaining({ pages: 2, updated: 2 }),
            );
        });

        it('forwards dryRun', async () => {
            const result = await (await importTask()).run({ dryRun: true });
            expect(runMock).toHaveBeenCalledWith({ afterId: null, dryRun: true });
            expect(result).toMatchObject({ dryRun: true, status: 'completed' });
        });

        it('stops, and says so, when a page that was not the last does not move the cursor', async () => {
            runMock.mockResolvedValue(page({ scanned: 1, nextAfterId: null, done: false }));

            const result = await (await importTask()).run({});

            expect(runMock).toHaveBeenCalledTimes(1);
            expect(result).toMatchObject({ status: 'stopped', reason: 'cursor_did_not_move' });
        });

        it('a runner failure fails the run loudly — it is not reported as a green run', async () => {
            runMock.mockRejectedValueOnce(
                new Error('Unknown remote target: AppWorkIsolationBackfillRunner'),
            );
            await expect((await importTask()).run({})).rejects.toThrow(/Unknown remote target/);
        });
    });
});
