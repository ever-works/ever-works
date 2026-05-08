import { describe, it, expect, vi, beforeEach } from 'vitest';

const { taskMock, withWorkerContextMock, createTaskContextMock, normalizeGeneratorErrorMock } =
    vi.hoisted(() => ({
        taskMock: vi.fn(),
        withWorkerContextMock: vi.fn(),
        createTaskContextMock: vi.fn(),
        normalizeGeneratorErrorMock: vi.fn(),
    }));

vi.mock('@trigger.dev/sdk', () => ({
    task: taskMock,
    schedules: { task: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@ever-works/agent/tasks', () => ({}));

vi.mock('@ever-works/agent/services', () => ({
    normalizeGeneratorError: normalizeGeneratorErrorMock,
}));

vi.mock('../trigger/worker/orchestrators/trigger-import.orchestrator', () => ({
    TriggerImportOrchestrator: class FakeImportOrchestrator {},
}));

vi.mock('../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: withWorkerContextMock,
}));

vi.mock('../trigger/worker/utils/task-context.utils', () => ({
    createTaskContext: createTaskContextMock,
}));

type TaskConfig = {
    id: string;
    maxDuration: number;
    run: (payload: any) => Promise<any>;
    onFailure: (args: { payload: any; error: unknown }) => Promise<void>;
    onCancel: (args: { payload: any }) => Promise<void>;
};

let registeredConfig: TaskConfig;

describe('workImportTask', () => {
    let appContext: { get: ReturnType<typeof vi.fn> };
    let orchestrator: {
        run: ReturnType<typeof vi.fn>;
        handleFailure: ReturnType<typeof vi.fn>;
        handleCancellation: ReturnType<typeof vi.fn>;
    };
    let work: { id: string };
    let user: { id: string };

    beforeEach(async () => {
        vi.clearAllMocks();
        vi.resetModules();

        appContext = { get: vi.fn() };
        orchestrator = {
            run: vi.fn().mockResolvedValue(undefined),
            handleFailure: vi.fn().mockResolvedValue(undefined),
            handleCancellation: vi.fn().mockResolvedValue(undefined),
        };
        work = { id: 'w-1' };
        user = { id: 'u-1' };

        withWorkerContextMock.mockImplementation(
            async (_label: string, fn: (ctx: any) => Promise<any>) => fn(appContext),
        );
        createTaskContextMock.mockResolvedValue({
            orchestrator,
            work,
            user,
            gitToken: 'ghp_xyz',
        });

        await import('../tasks/trigger/work-import.task');
        const lastCall = taskMock.mock.calls[taskMock.mock.calls.length - 1];
        registeredConfig = lastCall[0] as TaskConfig;
    });

    describe('registration', () => {
        it('registers a task with id "work-import"', () => {
            expect(registeredConfig.id).toBe('work-import');
        });

        it('declares a 2-hour maxDuration', () => {
            // 3600 * 2 seconds.
            expect(registeredConfig.maxDuration).toBe(3600 * 2);
        });

        it('exposes run / onFailure / onCancel handlers', () => {
            expect(typeof registeredConfig.run).toBe('function');
            expect(typeof registeredConfig.onFailure).toBe('function');
            expect(typeof registeredConfig.onCancel).toBe('function');
        });
    });

    describe('run()', () => {
        it('boots withWorkerContext using "WorkImport" as logger name', async () => {
            await registeredConfig.run({ workId: 'w-1', userId: 'u-1' } as any);

            expect(withWorkerContextMock).toHaveBeenCalledTimes(1);
            expect(withWorkerContextMock.mock.calls[0][0]).toBe('WorkImport');
        });

        it('forwards (appContext, payload, TriggerImportOrchestrator) to createTaskContext', async () => {
            const payload = { workId: 'w-1', userId: 'u-1', historyId: 'h-1' };
            await registeredConfig.run(payload as any);

            const orchestratorClass = (
                await import('../trigger/worker/orchestrators/trigger-import.orchestrator')
            ).TriggerImportOrchestrator;
            expect(createTaskContextMock).toHaveBeenCalledWith(
                appContext,
                payload,
                orchestratorClass,
            );
        });

        it('passes work + user + payload + gitToken to orchestrator.run', async () => {
            const payload = { workId: 'w-1', userId: 'u-1', historyId: 'h-1' };
            await registeredConfig.run(payload as any);

            expect(orchestrator.run).toHaveBeenCalledWith({
                work,
                user,
                payload,
                gitToken: 'ghp_xyz',
            });
        });

        it('forwards an undefined gitToken when createTaskContext does not return one', async () => {
            createTaskContextMock.mockResolvedValueOnce({ orchestrator, work, user });
            await registeredConfig.run({ workId: 'w-1', userId: 'u-1' } as any);

            expect(orchestrator.run.mock.calls[0][0].gitToken).toBeUndefined();
        });

        it('returns {status:"completed", workId} on happy path', async () => {
            const result = await registeredConfig.run({ workId: 'w-99', userId: 'u-1' } as any);
            expect(result).toEqual({ status: 'completed', workId: 'w-99' });
        });

        it('propagates orchestrator.run errors out of run()', async () => {
            const err = new Error('import-failed');
            orchestrator.run.mockRejectedValueOnce(err);

            await expect(
                registeredConfig.run({ workId: 'w-1', userId: 'u-1' } as any),
            ).rejects.toBe(err);
        });
    });

    describe('onFailure()', () => {
        it('returns silently when payload is missing (no withWorkerContext call)', async () => {
            await registeredConfig.onFailure({ payload: undefined, error: new Error('x') } as any);

            expect(withWorkerContextMock).not.toHaveBeenCalled();
        });

        it('boots withWorkerContext with "WorkImport:Failure" logger name', async () => {
            normalizeGeneratorErrorMock.mockReturnValueOnce('boom');
            await registeredConfig.onFailure({
                payload: { workId: 'w-1', userId: 'u-1', historyId: 'h-1' },
                error: new Error('boom'),
            } as any);

            expect(withWorkerContextMock).toHaveBeenCalledWith(
                'WorkImport:Failure',
                expect.any(Function),
            );
        });

        it('normalizes the error and calls orchestrator.handleFailure with errorMessage', async () => {
            normalizeGeneratorErrorMock.mockReturnValueOnce('normalized-msg');
            await registeredConfig.onFailure({
                payload: {
                    workId: 'w-1',
                    userId: 'u-1',
                    historyId: 'h-1',
                    historyStartedAt: '2026-01-01T00:00:00Z',
                },
                error: new Error('boom'),
            } as any);

            expect(normalizeGeneratorErrorMock).toHaveBeenCalledWith(expect.any(Error));
            expect(orchestrator.handleFailure).toHaveBeenCalledWith({
                work,
                historyId: 'h-1',
                historyStartedAt: '2026-01-01T00:00:00Z',
                errorMessage: 'normalized-msg',
            });
        });

        it('swallows withWorkerContext failures (best-effort cleanup)', async () => {
            withWorkerContextMock.mockRejectedValueOnce(new Error('boot-failed'));

            await expect(
                registeredConfig.onFailure({
                    payload: { workId: 'w-1', userId: 'u-1', historyId: 'h-1' },
                    error: new Error('boom'),
                } as any),
            ).resolves.toBeUndefined();
        });
    });

    describe('onCancel()', () => {
        it('returns silently when payload is missing (no withWorkerContext call)', async () => {
            await registeredConfig.onCancel({ payload: undefined } as any);

            expect(withWorkerContextMock).not.toHaveBeenCalled();
        });

        it('boots withWorkerContext with "WorkImport:Cancel" logger name', async () => {
            await registeredConfig.onCancel({
                payload: { workId: 'w-1', userId: 'u-1', historyId: 'h-1' },
            } as any);

            expect(withWorkerContextMock).toHaveBeenCalledWith(
                'WorkImport:Cancel',
                expect.any(Function),
            );
        });

        it('calls orchestrator.handleCancellation with {work, historyId, historyStartedAt}', async () => {
            await registeredConfig.onCancel({
                payload: {
                    workId: 'w-1',
                    userId: 'u-1',
                    historyId: 'h-1',
                    historyStartedAt: '2026-01-01T00:00:00Z',
                },
            } as any);

            expect(orchestrator.handleCancellation).toHaveBeenCalledWith({
                work,
                historyId: 'h-1',
                historyStartedAt: '2026-01-01T00:00:00Z',
            });
        });

        it('does NOT swallow withWorkerContext errors in onCancel — caller sees the error', async () => {
            // import task's onCancel does not wrap withWorkerContext in try/catch
            // (unlike onFailure). Pin that observable difference.
            const err = new Error('boot-failed');
            withWorkerContextMock.mockRejectedValueOnce(err);

            await expect(
                registeredConfig.onCancel({
                    payload: { workId: 'w-1', userId: 'u-1', historyId: 'h-1' },
                } as any),
            ).rejects.toBe(err);
        });
    });
});
