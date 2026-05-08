import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    taskMock,
    schedulesTaskMock,
    withWorkerContextMock,
    createTaskContextMock,
    normalizeGeneratorErrorMock,
    WorkScheduleServiceToken,
    GenerateStatusType,
} = vi.hoisted(() => {
    class WorkScheduleServiceToken {}
    return {
        taskMock: vi.fn(),
        schedulesTaskMock: vi.fn(),
        withWorkerContextMock: vi.fn(),
        createTaskContextMock: vi.fn(),
        normalizeGeneratorErrorMock: vi.fn(),
        WorkScheduleServiceToken,
        // Mirror the runtime values used by the source. The source compares to
        // GenerateStatusType.CANCELLED and writes GenerateStatusType.GENERATED;
        // any string values work as long as we use the same instances here.
        GenerateStatusType: {
            CANCELLED: 'cancelled',
            GENERATED: 'generated',
        } as const,
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    task: taskMock,
    schedules: { task: schedulesTaskMock },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@ever-works/agent/tasks', () => ({}));

vi.mock('@ever-works/agent/entities', () => ({
    GenerateStatusType,
}));

vi.mock('@ever-works/agent/services', () => ({
    WorkScheduleService: WorkScheduleServiceToken,
    normalizeGeneratorError: normalizeGeneratorErrorMock,
}));

vi.mock('../trigger/worker/orchestrators/trigger-generation.orchestrator', () => ({
    TriggerGenerationOrchestrator: class FakeGenerationOrchestrator {},
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
    run: (payload: any, ctx: { signal?: AbortSignal }) => Promise<any>;
    onFailure: (args: { payload: any; error: unknown }) => Promise<void>;
    onCancel: (args: { payload: any }) => Promise<void>;
};

let registeredConfig: TaskConfig;

describe('workGenerationTask', () => {
    let appContext: { get: ReturnType<typeof vi.fn> };
    let orchestrator: {
        run: ReturnType<typeof vi.fn>;
        handleFailure: ReturnType<typeof vi.fn>;
        handleCancellation: ReturnType<typeof vi.fn>;
    };
    let scheduleService: {
        markRunCompleted: ReturnType<typeof vi.fn>;
        markRunFailed: ReturnType<typeof vi.fn>;
    };
    let work: { id: string };
    let user: { id: string };

    beforeEach(async () => {
        vi.clearAllMocks();

        // taskMock captures whatever the source registered. We re-import via
        // vi.resetModules so each test starts from a clean registration.
        vi.resetModules();

        // Drive withWorkerContext to inline-call its body with the prepared
        // appContext, so the body's `appContext.get(...)` calls land on our
        // controlled stubs and we can assert ordering.
        appContext = { get: vi.fn() };
        scheduleService = {
            markRunCompleted: vi.fn().mockResolvedValue(undefined),
            markRunFailed: vi.fn().mockResolvedValue(undefined),
        };
        orchestrator = {
            run: vi.fn(),
            handleFailure: vi.fn().mockResolvedValue(undefined),
            handleCancellation: vi.fn().mockResolvedValue(undefined),
        };
        work = { id: 'w-1' };
        user = { id: 'u-1' };

        appContext.get.mockImplementation((token: any) => {
            if (token === WorkScheduleServiceToken) return scheduleService;
            throw new Error(`Unexpected DI token: ${String(token)}`);
        });

        withWorkerContextMock.mockImplementation(
            async (_label: string, fn: (ctx: any) => Promise<any>) => fn(appContext),
        );
        createTaskContextMock.mockResolvedValue({
            orchestrator,
            work,
            user,
        });

        // Re-import the task module so taskMock receives the current config.
        await import('../tasks/trigger/work-generation.task');
        const lastCall = taskMock.mock.calls[taskMock.mock.calls.length - 1];
        registeredConfig = lastCall[0] as TaskConfig;
    });

    describe('registration', () => {
        it('registers a task with id "work-generation"', () => {
            expect(registeredConfig.id).toBe('work-generation');
        });

        it('declares a 5-hour maxDuration', () => {
            // 3600 * 5 seconds.
            expect(registeredConfig.maxDuration).toBe(3600 * 5);
        });

        it('exposes run / onFailure / onCancel handlers', () => {
            expect(typeof registeredConfig.run).toBe('function');
            expect(typeof registeredConfig.onFailure).toBe('function');
            expect(typeof registeredConfig.onCancel).toBe('function');
        });
    });

    describe('run()', () => {
        it('boots withWorkerContext using "WorkGeneration" as the logger name', async () => {
            orchestrator.run.mockResolvedValueOnce(GenerateStatusType.GENERATED);
            await registeredConfig.run({ workId: 'w-1', userId: 'u-1' }, {});

            expect(withWorkerContextMock).toHaveBeenCalledTimes(1);
            expect(withWorkerContextMock.mock.calls[0][0]).toBe('WorkGeneration');
        });

        it('forwards (appContext, payload, TriggerGenerationOrchestrator) to createTaskContext', async () => {
            orchestrator.run.mockResolvedValueOnce(GenerateStatusType.GENERATED);
            const payload = {
                workId: 'w-1',
                userId: 'u-1',
                historyId: 'h-1',
                dto: { foo: 1 },
            };

            await registeredConfig.run(payload, {});

            const orchestratorClass = (
                await import('../trigger/worker/orchestrators/trigger-generation.orchestrator')
            ).TriggerGenerationOrchestrator;
            expect(createTaskContextMock).toHaveBeenCalledWith(
                appContext,
                payload,
                orchestratorClass,
            );
        });

        it('passes work + user + dto + historyId + historyStartedAt + signal to orchestrator.run', async () => {
            orchestrator.run.mockResolvedValueOnce(GenerateStatusType.GENERATED);
            const signal = new AbortController().signal;
            await registeredConfig.run(
                {
                    workId: 'w-1',
                    userId: 'u-1',
                    historyId: 'h-1',
                    historyStartedAt: '2026-05-08T00:00:00Z',
                    dto: { mode: 'full' },
                },
                { signal },
            );

            expect(orchestrator.run).toHaveBeenCalledWith({
                work,
                user,
                dto: { mode: 'full' },
                historyId: 'h-1',
                historyStartedAt: '2026-05-08T00:00:00Z',
                signal,
            });
        });

        it('returns {status:"completed", workId} on happy path', async () => {
            orchestrator.run.mockResolvedValueOnce(GenerateStatusType.GENERATED);
            const result = await registeredConfig.run(
                { workId: 'w-42', userId: 'u-1', historyId: 'h-1', dto: {} },
                {},
            );
            expect(result).toEqual({ status: 'completed', workId: 'w-42' });
        });

        describe('schedule trigger source', () => {
            it('marks run completed with GENERATED status when finalStatus !== CANCELLED', async () => {
                orchestrator.run.mockResolvedValueOnce(GenerateStatusType.GENERATED);
                await registeredConfig.run(
                    {
                        workId: 'w-1',
                        userId: 'u-1',
                        historyId: 'h-1',
                        dto: {},
                        triggerSource: 'schedule',
                        scheduleId: 'sched-1',
                    },
                    {},
                );

                expect(scheduleService.markRunCompleted).toHaveBeenCalledWith({
                    scheduleId: 'sched-1',
                    historyId: 'h-1',
                    status: GenerateStatusType.GENERATED,
                });
                expect(scheduleService.markRunFailed).not.toHaveBeenCalled();
            });

            it('marks run failed with "cancelled" when finalStatus === CANCELLED', async () => {
                orchestrator.run.mockResolvedValueOnce(GenerateStatusType.CANCELLED);
                await registeredConfig.run(
                    {
                        workId: 'w-1',
                        userId: 'u-1',
                        historyId: 'h-1',
                        dto: {},
                        triggerSource: 'schedule',
                        scheduleId: 'sched-1',
                    },
                    {},
                );

                expect(scheduleService.markRunFailed).toHaveBeenCalledWith(
                    'sched-1',
                    'cancelled',
                );
                expect(scheduleService.markRunCompleted).not.toHaveBeenCalled();
            });

            it('does NOT mark schedule when triggerSource is not "schedule"', async () => {
                orchestrator.run.mockResolvedValueOnce(GenerateStatusType.GENERATED);
                await registeredConfig.run(
                    {
                        workId: 'w-1',
                        userId: 'u-1',
                        historyId: 'h-1',
                        dto: {},
                        triggerSource: 'user',
                        scheduleId: 'sched-1',
                    },
                    {},
                );

                expect(scheduleService.markRunCompleted).not.toHaveBeenCalled();
                expect(scheduleService.markRunFailed).not.toHaveBeenCalled();
            });

            it('does NOT mark schedule when scheduleId is missing (even if triggerSource === "schedule")', async () => {
                orchestrator.run.mockResolvedValueOnce(GenerateStatusType.GENERATED);
                await registeredConfig.run(
                    {
                        workId: 'w-1',
                        userId: 'u-1',
                        historyId: 'h-1',
                        dto: {},
                        triggerSource: 'schedule',
                    },
                    {},
                );

                expect(scheduleService.markRunCompleted).not.toHaveBeenCalled();
                expect(scheduleService.markRunFailed).not.toHaveBeenCalled();
            });

            it('marks schedule failed with error.message AND re-throws when orchestrator.run throws', async () => {
                const err = new Error('pipeline-died');
                orchestrator.run.mockRejectedValueOnce(err);

                await expect(
                    registeredConfig.run(
                        {
                            workId: 'w-1',
                            userId: 'u-1',
                            historyId: 'h-1',
                            dto: {},
                            triggerSource: 'schedule',
                            scheduleId: 'sched-1',
                        },
                        {},
                    ),
                ).rejects.toBe(err);

                expect(scheduleService.markRunFailed).toHaveBeenCalledWith(
                    'sched-1',
                    'pipeline-died',
                );
                expect(scheduleService.markRunCompleted).not.toHaveBeenCalled();
            });

            it('does NOT mark schedule on orchestrator throw when not in schedule mode (still re-throws)', async () => {
                const err = new Error('pipeline-died');
                orchestrator.run.mockRejectedValueOnce(err);

                await expect(
                    registeredConfig.run(
                        {
                            workId: 'w-1',
                            userId: 'u-1',
                            historyId: 'h-1',
                            dto: {},
                            triggerSource: 'user',
                            scheduleId: 'sched-1',
                        },
                        {},
                    ),
                ).rejects.toBe(err);

                expect(scheduleService.markRunFailed).not.toHaveBeenCalled();
            });
        });
    });

    describe('onFailure()', () => {
        it('returns silently when payload is missing (no withWorkerContext call)', async () => {
            await registeredConfig.onFailure({
                payload: undefined,
                error: new Error('whatever'),
            } as any);

            expect(withWorkerContextMock).not.toHaveBeenCalled();
        });

        it('boots withWorkerContext with "WorkGeneration:Failure" logger name', async () => {
            normalizeGeneratorErrorMock.mockReturnValueOnce('boom');
            await registeredConfig.onFailure({
                payload: { workId: 'w-1', userId: 'u-1', historyId: 'h-1' },
                error: new Error('boom'),
            } as any);

            expect(withWorkerContextMock).toHaveBeenCalledWith(
                'WorkGeneration:Failure',
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

        it('marks schedule failed with normalized error message when in schedule mode', async () => {
            normalizeGeneratorErrorMock.mockReturnValueOnce('normalized-msg');
            await registeredConfig.onFailure({
                payload: {
                    workId: 'w-1',
                    userId: 'u-1',
                    historyId: 'h-1',
                    triggerSource: 'schedule',
                    scheduleId: 'sched-77',
                },
                error: new Error('boom'),
            } as any);

            expect(scheduleService.markRunFailed).toHaveBeenCalledWith(
                'sched-77',
                'normalized-msg',
            );
        });

        it('does NOT mark schedule when triggerSource !== "schedule"', async () => {
            normalizeGeneratorErrorMock.mockReturnValueOnce('msg');
            await registeredConfig.onFailure({
                payload: {
                    workId: 'w-1',
                    userId: 'u-1',
                    historyId: 'h-1',
                    triggerSource: 'user',
                    scheduleId: 'sched-77',
                },
                error: new Error('boom'),
            } as any);

            expect(scheduleService.markRunFailed).not.toHaveBeenCalled();
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

        it('boots withWorkerContext with "WorkGeneration:Cancel" logger name', async () => {
            await registeredConfig.onCancel({
                payload: { workId: 'w-1', userId: 'u-1', historyId: 'h-1' },
            } as any);

            expect(withWorkerContextMock).toHaveBeenCalledWith(
                'WorkGeneration:Cancel',
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

        it('marks schedule failed with literal "cancelled" when in schedule mode', async () => {
            await registeredConfig.onCancel({
                payload: {
                    workId: 'w-1',
                    userId: 'u-1',
                    historyId: 'h-1',
                    triggerSource: 'schedule',
                    scheduleId: 'sched-9',
                },
            } as any);

            expect(scheduleService.markRunFailed).toHaveBeenCalledWith('sched-9', 'cancelled');
        });

        it('does NOT mark schedule when triggerSource !== "schedule"', async () => {
            await registeredConfig.onCancel({
                payload: {
                    workId: 'w-1',
                    userId: 'u-1',
                    historyId: 'h-1',
                    triggerSource: 'user',
                    scheduleId: 'sched-9',
                },
            } as any);

            expect(scheduleService.markRunFailed).not.toHaveBeenCalled();
        });

        it('swallows withWorkerContext failures (best-effort cleanup)', async () => {
            withWorkerContextMock.mockRejectedValueOnce(new Error('boot-failed'));

            await expect(
                registeredConfig.onCancel({
                    payload: { workId: 'w-1', userId: 'u-1', historyId: 'h-1' },
                } as any),
            ).resolves.toBeUndefined();
        });
    });
});
