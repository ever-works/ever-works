import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';

import { FullPipelineExecutorService } from '../full-pipeline-executor.service';
import { PipelineFacadeService } from '../pipeline-facade.service';
import { PluginContextFactoryService } from '../../plugins/services/plugin-context-factory.service';
import { KnowledgeBaseService } from '../../services/knowledge-base.service';

import type {
    ExistingItems,
    GenerationRequest,
    IPipelinePlugin,
    PipelineExecutionOptions,
    PipelineResult,
    StepExecutionContext,
    WorkReference,
} from '@ever-works/plugin';
import type { KbContextBundleData } from '@ever-works/contracts';

/**
 * EW-641 Phase 2/b row 33b — companion to row 33a (engine-orchestrated
 * path). This spec covers the self-managed-pipeline path: claude-code,
 * agent-pipeline, codex, gemini, etc. — plugins that own their step
 * loop entirely and just receive an engine-built `StepExecutionContext`
 * via `options.execContext` on `plugin.execute(work, request, existing,
 * options)`.
 *
 * The bundle still has to land on `options.execContext.kbContext`
 * before the plugin's `execute()` runs, otherwise self-managed
 * pipelines see no KB grounding. This spec exercises:
 *
 *   FullPipelineExecutorService.execute()
 *     → resolveKbContextSafe(work, request)
 *     → facadeService.createStepExecutionContext(..., kbContext)
 *     → plugin.execute(work, request, existing, { execContext, ... })
 *
 * Mirrors the row 33a harness shape but with a self-managed mock
 * plugin whose `execute()` captures `options.execContext` for
 * end-to-end assertions. Row 33c (API-level e2e on a real generation
 * invocation) is the remaining row-33 sub-chunk.
 */

// Silence the executor's logger — keep assertion failures front-and-centre.
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const WORK: WorkReference = {
    id: 'work-kb-full',
    name: 'KB Full Executor Work',
    slug: 'kb-full',
    user: { id: 'user-kb-full' },
};

const REQUEST: GenerationRequest = {
    prompt: 'tell me about voice',
    config: {},
};

const EXISTING: ExistingItems = {
    items: [],
    categories: [],
    tags: [],
};

const SAMPLE_BUNDLE: KbContextBundleData = {
    alwaysInjected: [{ id: 'brand-1', class: 'brand', slug: 'voice' } as any],
    queryRetrieved: [{ id: 'research-1', class: 'research', slug: 'voice-research' } as any],
};

/**
 * Minimal self-managed pipeline plugin. The full executor calls
 * `plugin.execute(work, request, existing, options)` once; our mock
 * captures `options.execContext` for assertion and returns a valid
 * `PipelineResult` so the executor's result-validator stays happy.
 */
function makeCapturingPlugin(): {
    plugin: IPipelinePlugin;
    captured: { execContexts: StepExecutionContext[] };
} {
    const captured = { execContexts: [] as StepExecutionContext[] };

    const plugin: IPipelinePlugin = {
        id: 'mock-self-managed',
        name: 'Mock Self-Managed Pipeline',
        version: '1.0.0',
        category: 'pipeline' as any,
        capabilities: ['pipeline'],
        settingsSchema: { type: 'object', properties: {} } as any,
        onLoad: async () => undefined,
        onUnload: async () => undefined,
        getStepDefinitions: () => [{ id: 's1' } as any],
        execute: jest
            .fn()
            .mockImplementation(
                (
                    _work: WorkReference,
                    _request: GenerationRequest,
                    _existing: ExistingItems,
                    options?: PipelineExecutionOptions,
                ): Promise<PipelineResult> => {
                    if (options?.execContext) captured.execContexts.push(options.execContext);
                    return Promise.resolve({
                        success: true,
                        outputs: {
                            items: [],
                            categories: [],
                            tags: [],
                            collections: [],
                            brands: [],
                        },
                        duration: 0,
                        stepsCompleted: 1,
                        totalSteps: 1,
                    } as PipelineResult);
                },
            ),
    };

    return { plugin, captured };
}

interface FullHarness {
    service: FullPipelineExecutorService;
    /** Snapshot of every (work, providers, aiModel, signal, kbContext) tuple seen by the facade. */
    facadeCalls: Array<{
        work: WorkReference;
        kbContext: KbContextBundleData | undefined;
    }>;
}

async function buildHarness(kbResolveContext: jest.Mock | undefined): Promise<FullHarness> {
    const facadeCalls: FullHarness['facadeCalls'] = [];

    const facadeServiceStub = {
        createStepExecutionContext: jest
            .fn()
            .mockImplementation(
                (
                    work: WorkReference,
                    _providers: unknown,
                    _aiModel: string | undefined,
                    _signal: AbortSignal | undefined,
                    kbContext: KbContextBundleData | undefined,
                ): StepExecutionContext => {
                    facadeCalls.push({ work, kbContext });
                    return {
                        aiFacade: {} as any,
                        searchFacade: {} as any,
                        screenshotFacade: {} as any,
                        contentExtractorFacade: {} as any,
                        logger: {
                            log: () => undefined,
                            debug: () => undefined,
                            warn: () => undefined,
                            error: () => undefined,
                        },
                        work,
                        user: work.user,
                        kbContext,
                    } as StepExecutionContext;
                },
            ),
    };

    const kbServiceStub = kbResolveContext ? { resolveContext: kbResolveContext } : undefined;

    const providers: Array<{
        provide: string | symbol | (new (...args: unknown[]) => unknown);
        useValue: unknown;
    }> = [
        { provide: EventEmitter2, useValue: { emit: jest.fn(), on: jest.fn(), off: jest.fn() } },
        { provide: PipelineFacadeService, useValue: facadeServiceStub },
        {
            provide: PluginContextFactoryService,
            useValue: { addLogInterceptor: jest.fn().mockReturnValue(() => undefined) },
        },
    ];
    if (kbServiceStub) {
        providers.push({ provide: KnowledgeBaseService, useValue: kbServiceStub });
    }

    const module: TestingModule = await Test.createTestingModule({
        providers: [FullPipelineExecutorService, ...(providers as any[])],
    }).compile();

    const service = module.get(FullPipelineExecutorService);
    return { service, facadeCalls };
}

describe('KB context end-to-end integration — full-executor path (row 33b)', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('threads the resolved bundle into plugin.execute(..., { execContext }) when KnowledgeBaseService is wired', async () => {
        const resolveContext = jest.fn().mockResolvedValue(SAMPLE_BUNDLE);
        const harness = await buildHarness(resolveContext);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING);
        expect(result.success).toBe(true);

        // 1. KnowledgeBaseService.resolveContext invoked once with the
        //    expected (workId, { query }) args.
        expect(resolveContext).toHaveBeenCalledTimes(1);
        expect(resolveContext).toHaveBeenCalledWith(WORK.id, { query: REQUEST.prompt });

        // 2. Facade received the bundle as the 5th arg of its single
        //    createStepExecutionContext call (full-executor builds one
        //    execContext for the whole plugin.execute, not per-step).
        expect(harness.facadeCalls).toHaveLength(1);
        expect(harness.facadeCalls[0].kbContext).toEqual(SAMPLE_BUNDLE);

        // 3. The self-managed plugin's execute() callback observed
        //    `options.execContext.kbContext` — that's the surface real
        //    self-managed plugins (claude-code etc.) read.
        expect(captured.execContexts).toHaveLength(1);
        const seen = captured.execContexts[0];
        expect(seen.kbContext).toEqual(SAMPLE_BUNDLE);
        expect(seen.kbContext?.alwaysInjected.map((d) => d.id)).toEqual(['brand-1']);
        expect(seen.kbContext?.queryRetrieved.map((d) => d.id)).toEqual(['research-1']);
    });

    it('leaves options.execContext.kbContext undefined when KnowledgeBaseService is not provided', async () => {
        const harness = await buildHarness(undefined);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING);
        expect(result.success).toBe(true);

        // No KB service → facade called with kbContext undefined → plugin
        // sees no bundle on options.execContext.
        expect(harness.facadeCalls).toHaveLength(1);
        expect(harness.facadeCalls[0].kbContext).toBeUndefined();
        expect(captured.execContexts[0].kbContext).toBeUndefined();
    });

    it('degrades gracefully when resolveContext throws — kbContext stays undefined, plugin still executes', async () => {
        const resolveContext = jest.fn().mockRejectedValue(new Error('kb backend down'));
        const harness = await buildHarness(resolveContext);
        const { plugin, captured } = makeCapturingPlugin();

        // No throw expected — generation must never break on a KB hiccup
        // (row 32c contract, same as the step-executor path).
        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING);
        expect(result.success).toBe(true);

        expect(resolveContext).toHaveBeenCalledTimes(1);
        expect(harness.facadeCalls[0].kbContext).toBeUndefined();
        expect(captured.execContexts[0].kbContext).toBeUndefined();
    });
});
