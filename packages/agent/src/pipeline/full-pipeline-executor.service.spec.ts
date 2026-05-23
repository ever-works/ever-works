import { FullPipelineExecutorService } from './full-pipeline-executor.service';
import { PipelineEvents } from './step-pipeline-executor.service';

describe('FullPipelineExecutorService', () => {
    let eventEmitter: any;
    let facadeService: any;
    let contextFactory: any;
    let service: FullPipelineExecutorService;

    function makePlugin(overrides: any = {}) {
        return {
            id: 'claude-code',
            execute: jest.fn(),
            getStepDefinitions: jest
                .fn()
                .mockReturnValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]),
            ...overrides,
        };
    }

    function makeValidResult(overrides: any = {}) {
        // The validator's required-field set: success, stepsCompleted,
        // totalSteps, duration, outputs.{items, categories, tags,
        // collections, brands}.
        return {
            success: true,
            stepsCompleted: 3,
            totalSteps: 3,
            duration: 0,
            outputs: {
                items: [{ slug: 'a' }, { slug: 'b' }],
                categories: [],
                tags: [],
                collections: [],
                brands: [],
            },
            ...overrides,
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers().setSystemTime(new Date('2026-05-09T12:00:00.000Z'));

        eventEmitter = {
            emit: jest.fn(),
        };
        facadeService = {
            createStepExecutionContext: jest.fn().mockReturnValue({ ctx: 'fake' }),
        };
        contextFactory = {
            addLogInterceptor: jest.fn().mockReturnValue(() => undefined),
        };

        service = new FullPipelineExecutorService(eventEmitter, facadeService, contextFactory);

        // Silence the logger so the suite output stays focused on assertion failures.
        jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('execute — happy path', () => {
        const work = { id: 'w-1' } as any;
        const request = { providers: { p: 'x' }, aiModel: 'gpt' } as any;
        const existing = { items: [] } as any;

        it('emits pipeline:started, calls plugin.execute, validates the result, and emits pipeline:completed', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());

            const result = await service.execute(plugin, work, request, existing);

            // STARTED emitted before the plugin runs.
            expect(eventEmitter.emit).toHaveBeenNthCalledWith(
                1,
                PipelineEvents.STARTED,
                expect.objectContaining({
                    workId: 'w-1',
                    pipelineId: 'claude-code',
                    timestamp: '2026-05-09T12:00:00.000Z',
                }),
            );

            // facade.createStepExecutionContext invoked with documented positional args.
            // 5th arg is `kbContext` (EW-641 row 32c), 6th is `kbTools`
            // (EW-641 row 36c) — both undefined when neither
            // KnowledgeBaseService nor KbToolsFacadeAdapter is injected.
            expect(facadeService.createStepExecutionContext).toHaveBeenCalledWith(
                work,
                request.providers,
                request.aiModel,
                undefined, // no signal in options
                undefined, // no kbContext (no KB service wired)
                undefined, // no kbTools (no adapter wired)
            );

            // plugin.execute received {...options, execContext, onLogEntry}.
            expect(plugin.execute).toHaveBeenCalledWith(
                work,
                request,
                existing,
                expect.objectContaining({
                    execContext: { ctx: 'fake' },
                    onLogEntry: undefined,
                }),
                undefined,
            );

            // COMPLETED emitted with duration + stepsCompleted + outputs.
            expect(eventEmitter.emit).toHaveBeenLastCalledWith(
                PipelineEvents.COMPLETED,
                expect.objectContaining({
                    workId: 'w-1',
                    pipelineId: 'claude-code',
                    stepsCompleted: 3,
                    duration: expect.any(Number),
                }),
            );

            expect(result).toMatchObject({
                success: true,
                stepsCompleted: 3,
                totalSteps: 3,
                outputs: { items: [{ slug: 'a' }, { slug: 'b' }] },
            });
            expect(result.duration).toBe(0); // fake timer keeps Date.now stable
        });

        it('forwards options.signal into the facade context and passes options through to plugin.execute', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());
            const signal = new AbortController().signal;

            await service.execute(plugin, work, request, existing, { signal } as any);

            expect(facadeService.createStepExecutionContext).toHaveBeenCalledWith(
                work,
                request.providers,
                request.aiModel,
                signal,
                undefined,
                undefined,
            );
        });

        it('forwards onProgress callback verbatim to plugin.execute', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());
            const onProgress = jest.fn();

            await service.execute(plugin, work, request, existing, undefined, onProgress);

            expect(plugin.execute).toHaveBeenCalledWith(
                work,
                request,
                existing,
                expect.any(Object),
                onProgress,
            );
        });

        it('overrides duration on the returned result with the post-validation elapsed time', async () => {
            const plugin = makePlugin();
            const rawResult = makeValidResult({ duration: 9999 }); // plugin's own duration
            plugin.execute.mockImplementation(async () => {
                jest.advanceTimersByTime(2500);
                return rawResult;
            });

            const result = await service.execute(plugin, work, request, existing);

            // The wrapper REPLACES the plugin's duration with its own measurement.
            expect(result.duration).toBe(2500);
        });
    });

    // EW-641 Phase 2/b row 32c — orchestrator populates execContext.kbContext
    // by calling KnowledgeBaseService.resolveContext once per run. The bundle
    // is forwarded as the 5th positional arg to createStepExecutionContext.
    describe('execute — kbContext wiring (row 32c)', () => {
        const work = { id: 'w-kb' } as any;
        const request = { providers: { p: 'x' }, aiModel: 'gpt', prompt: 'voice tone' } as any;
        const existing = { items: [] } as any;

        it('resolves the KB bundle and forwards it as the 5th arg when KnowledgeBaseService is wired', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());

            const bundle = {
                alwaysInjected: [{ id: 'b1' }] as any,
                queryRetrieved: [{ id: 'q1' }] as any,
            };
            const kbService = { resolveContext: jest.fn().mockResolvedValue(bundle) };

            const wired = new FullPipelineExecutorService(
                eventEmitter,
                facadeService,
                contextFactory,
                kbService as any,
            );
            jest.spyOn((wired as any).logger, 'log').mockImplementation(() => undefined);
            jest.spyOn((wired as any).logger, 'error').mockImplementation(() => undefined);
            jest.spyOn((wired as any).logger, 'warn').mockImplementation(() => undefined);

            await wired.execute(plugin, work, request, existing);

            expect(kbService.resolveContext).toHaveBeenCalledTimes(1);
            expect(kbService.resolveContext).toHaveBeenCalledWith('w-kb', { query: 'voice tone' });

            expect(facadeService.createStepExecutionContext).toHaveBeenCalledWith(
                work,
                request.providers,
                request.aiModel,
                undefined,
                bundle,
                undefined,
            );
        });

        it('does not call resolveContext when work.id is empty (test/fixture path)', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());
            const kbService = { resolveContext: jest.fn() };

            const wired = new FullPipelineExecutorService(
                eventEmitter,
                facadeService,
                contextFactory,
                kbService as any,
            );
            jest.spyOn((wired as any).logger, 'log').mockImplementation(() => undefined);
            jest.spyOn((wired as any).logger, 'error').mockImplementation(() => undefined);

            await wired.execute(plugin, { id: '' } as any, request, existing);

            expect(kbService.resolveContext).not.toHaveBeenCalled();
            // Carrier stays undefined.
            expect(facadeService.createStepExecutionContext).toHaveBeenCalledWith(
                expect.objectContaining({ id: '' }),
                request.providers,
                request.aiModel,
                undefined,
                undefined,
                undefined,
            );
        });

        it('degrades gracefully when resolveContext throws (logs warn, kbContext stays undefined)', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());
            const kbService = {
                resolveContext: jest.fn().mockRejectedValue(new Error('db down')),
            };

            const wired = new FullPipelineExecutorService(
                eventEmitter,
                facadeService,
                contextFactory,
                kbService as any,
            );
            jest.spyOn((wired as any).logger, 'log').mockImplementation(() => undefined);
            jest.spyOn((wired as any).logger, 'error').mockImplementation(() => undefined);
            const warnSpy = jest
                .spyOn((wired as any).logger, 'warn')
                .mockImplementation(() => undefined);

            await wired.execute(plugin, work, request, existing);

            // resolveContext threw → bundle is undefined → plugin runs as if no KB.
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('KB context resolution failed'),
            );
            expect(facadeService.createStepExecutionContext).toHaveBeenCalledWith(
                work,
                request.providers,
                request.aiModel,
                undefined,
                undefined,
                undefined,
            );
        });
    });

    describe('execute — log interceptor', () => {
        const work = { id: 'w-1' } as any;
        const request = { providers: {} } as any;
        const existing = {} as any;

        it('attaches an interceptor when onLogEntry is supplied and removes it on success', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());
            const removeFn = jest.fn();
            contextFactory.addLogInterceptor.mockReturnValue(removeFn);
            const onLogEntry = jest.fn();

            await service.execute(plugin, work, request, existing, { onLogEntry } as any);

            expect(contextFactory.addLogInterceptor).toHaveBeenCalledWith(
                'claude-code',
                expect.any(Function),
            );
            expect(removeFn).toHaveBeenCalledTimes(1);
        });

        it('routes interceptor (level, message) into the documented onLogEntry envelope shape', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());
            const onLogEntry = jest.fn();
            let captured: ((lvl: string, msg: string) => void) | null = null;
            contextFactory.addLogInterceptor.mockImplementation(
                (_id: string, fn: (lvl: string, msg: string) => void) => {
                    captured = fn;
                    return () => undefined;
                },
            );

            await service.execute(plugin, work, request, existing, { onLogEntry } as any);

            // Now drive the captured interceptor and verify the envelope shape.
            captured!('warn', 'plugin says hi');

            expect(onLogEntry).toHaveBeenCalledWith({
                timestamp: '2026-05-09T12:00:00.000Z',
                level: 'warn',
                source: 'pipeline',
                event: 'message',
                message: 'plugin says hi',
            });
        });

        it('skips addLogInterceptor entirely when onLogEntry is omitted', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());

            await service.execute(plugin, work, request, existing);

            expect(contextFactory.addLogInterceptor).not.toHaveBeenCalled();
        });

        it('still removes the interceptor in the finally block when execute throws', async () => {
            const plugin = makePlugin();
            plugin.execute.mockRejectedValue(new Error('boom'));
            const removeFn = jest.fn();
            contextFactory.addLogInterceptor.mockReturnValue(removeFn);

            await service.execute(plugin, work, request, existing, {
                onLogEntry: jest.fn(),
            } as any);

            expect(removeFn).toHaveBeenCalledTimes(1);
        });

        it('finally block tolerates a missing remove fn (no removeInterceptor variable when onLogEntry is absent)', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());

            // Just ensure the call resolves cleanly — `removeInterceptor?.()` is the
            // optional-call guard.
            await expect(service.execute(plugin, work, request, existing)).resolves.toBeDefined();
            expect(contextFactory.addLogInterceptor).not.toHaveBeenCalled();
        });
    });

    describe('execute — invalid result handling', () => {
        const work = { id: 'w-1' } as any;
        const request = { providers: {} } as any;
        const existing = {} as any;

        it('throws-then-emits-failed-then-returns-error-envelope when plugin returns a non-object', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue('not-an-object');

            const result = await service.execute(plugin, work, request, existing);

            // The validator emits a single error: "Result must be an object".
            // The wrapper then throws inside its try and catches in the catch.
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.FAILED,
                expect.objectContaining({
                    workId: 'w-1',
                    pipelineId: 'claude-code',
                    error: expect.stringContaining('returned invalid pipeline result'),
                    failedStep: undefined,
                    completedSteps: 0,
                }),
            );
            // The error envelope from buildErrorPipelineResult — totalSteps comes
            // from plugin.getStepDefinitions().length.
            expect(result).toMatchObject({
                success: false,
                stepsCompleted: 0,
                totalSteps: 3,
                outputs: expect.any(Object),
            });
        });

        it('joins multiple validator errors with "; " in the thrown message + emitted event', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue({}); // missing every required field

            await service.execute(plugin, work, request, existing);

            const failedCall = eventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === PipelineEvents.FAILED,
            );
            expect(failedCall![1].error).toContain('; ');
            // Pinned: the error message starts with the documented prefix.
            expect(failedCall![1].error).toMatch(
                /Plugin "claude-code" returned invalid pipeline result/,
            );
        });

        it('emits FAILED + error result when plugin.execute itself rejects', async () => {
            const plugin = makePlugin();
            plugin.execute.mockRejectedValue(new Error('plugin crashed'));

            const result = await service.execute(plugin, work, request, existing);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.FAILED,
                expect.objectContaining({ error: 'plugin crashed', completedSteps: 0 }),
            );
            expect(result.success).toBe(false);
            // totalSteps is sourced from plugin.getStepDefinitions().length even on the failure path.
            expect(result.totalSteps).toBe(3);
        });

        it('emits FAILED only ONCE per execute call (no double-emission on validator vs catch)', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue('bad');

            await service.execute(plugin, work, request, existing);

            const failedCalls = eventEmitter.emit.mock.calls.filter(
                (c: any[]) => c[0] === PipelineEvents.FAILED,
            );
            expect(failedCalls).toHaveLength(1);
            const completedCalls = eventEmitter.emit.mock.calls.filter(
                (c: any[]) => c[0] === PipelineEvents.COMPLETED,
            );
            expect(completedCalls).toHaveLength(0);
        });
    });

    describe('executeWithCancellation', () => {
        const work = { id: 'w-1' } as any;
        const request = { providers: {} } as any;
        const existing = {} as any;

        it('hooks signal.abort to plugin.cancel when both are present', async () => {
            const cancel = jest.fn().mockResolvedValue(undefined);
            const plugin = makePlugin({ cancel });
            plugin.execute.mockResolvedValue(makeValidResult());
            const ac = new AbortController();
            const addSpy = jest.spyOn(ac.signal, 'addEventListener');
            const removeSpy = jest.spyOn(ac.signal, 'removeEventListener');

            const promise = service.executeWithCancellation(plugin, work, request, existing, {
                signal: ac.signal,
            } as any);

            // The handler is registered with `{once: true}`.
            expect(addSpy).toHaveBeenCalledWith(
                'abort',
                expect.any(Function),
                expect.objectContaining({ once: true }),
            );

            // Trigger abort BEFORE execute resolves to confirm the handler runs.
            ac.abort();

            await promise;
            expect(cancel).toHaveBeenCalledTimes(1);
            // Listener removed in the finally block.
            expect(removeSpy).toHaveBeenCalled();
        });

        it('swallows plugin.cancel rejection (logs error, does not propagate)', async () => {
            const cancel = jest.fn().mockRejectedValue(new Error('cancel failed'));
            const plugin = makePlugin({ cancel });
            plugin.execute.mockResolvedValue(makeValidResult());
            const ac = new AbortController();

            const promise = service.executeWithCancellation(plugin, work, request, existing, {
                signal: ac.signal,
            } as any);
            ac.abort();
            await expect(promise).resolves.toBeDefined();
        });

        it('skips abort wiring entirely when plugin lacks .cancel', async () => {
            const plugin = makePlugin({ cancel: undefined });
            plugin.execute.mockResolvedValue(makeValidResult());
            const ac = new AbortController();
            const addSpy = jest.spyOn(ac.signal, 'addEventListener');

            await service.executeWithCancellation(plugin, work, request, existing, {
                signal: ac.signal,
            } as any);

            expect(addSpy).not.toHaveBeenCalled();
        });

        it('still removes the listener when execute throws', async () => {
            const cancel = jest.fn();
            const plugin = makePlugin({ cancel });
            plugin.execute.mockRejectedValue(new Error('boom')); // execute rejects → wrapper recovers, returns failure result
            const ac = new AbortController();
            const removeSpy = jest.spyOn(ac.signal, 'removeEventListener');

            await service.executeWithCancellation(plugin, work, request, existing, {
                signal: ac.signal,
            } as any);

            expect(removeSpy).toHaveBeenCalled();
        });
    });

    describe('getPluginState', () => {
        it('returns the result of plugin.getState() when defined', () => {
            const state = {
                steps: new Map(),
                completedSteps: ['s1'],
                failedSteps: [],
                isRunning: true,
                isCancelled: false,
            };
            const plugin = { getState: jest.fn().mockReturnValue(state) } as any;

            expect(service.getPluginState(plugin)).toBe(state);
            expect(plugin.getState).toHaveBeenCalledTimes(1);
        });

        it('returns null when plugin.getState is undefined', () => {
            const plugin = {} as any;
            expect(service.getPluginState(plugin)).toBeNull();
        });
    });

    describe('event emission helpers (private, exercised via execute)', () => {
        const work = { id: 'w-1' } as any;
        const request = { providers: {} } as any;
        const existing = {} as any;

        it('emitPipelineEvent merges {timestamp, ...payload} (timestamp precedence is payload-wins via spread)', async () => {
            const plugin = makePlugin();
            plugin.execute.mockResolvedValue(makeValidResult());

            await service.execute(plugin, work, request, existing);

            const startedCall = eventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === PipelineEvents.STARTED,
            );
            // Default ISO from fake timer.
            expect(startedCall![1].timestamp).toBe('2026-05-09T12:00:00.000Z');
            expect(startedCall![1].workId).toBe('w-1');
            expect(startedCall![1].pipelineId).toBe('claude-code');
        });

        it('emitPipelineCompleted forwards outputs from the validated result', async () => {
            const plugin = makePlugin();
            const r = makeValidResult({
                outputs: {
                    items: [{ slug: 'x' }],
                    categories: [{ slug: 'c' }],
                    tags: [],
                    collections: [],
                    brands: [],
                },
            });
            plugin.execute.mockResolvedValue(r);

            await service.execute(plugin, work, request, existing);

            const completed = eventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === PipelineEvents.COMPLETED,
            );
            expect(completed![1].outputs).toEqual(r.outputs);
        });

        it('emitPipelineFailed pins the documented {workId, pipelineId, error, failedStep:undefined, completedSteps:0, timestamp} envelope', async () => {
            const plugin = makePlugin();
            plugin.execute.mockRejectedValue(new Error('fatal'));

            await service.execute(plugin, work, request, existing);

            const failed = eventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === PipelineEvents.FAILED,
            );
            expect(failed![1]).toEqual({
                timestamp: '2026-05-09T12:00:00.000Z',
                workId: 'w-1',
                pipelineId: 'claude-code',
                error: 'fatal',
                failedStep: undefined,
                completedSteps: 0,
            });
        });
    });
});
