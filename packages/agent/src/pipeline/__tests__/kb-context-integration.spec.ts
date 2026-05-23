import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Logger } from '@nestjs/common';

import { StepPipelineExecutorService } from '../step-pipeline-executor.service';
import { PipelineBuilderService } from '../pipeline-builder.service';
import { PipelineFacadeService } from '../pipeline-facade.service';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { PluginContextFactoryService } from '../../plugins/services/plugin-context-factory.service';
import { KnowledgeBaseService } from '../../services/knowledge-base.service';
import { MockPipelinePlugin, createLinearChain } from './mock-pipeline-plugin';

import type {
    ExistingItems,
    GenerationRequest,
    IBuiltInStepExecutor,
    IPipelineContext,
    StepExecutionContext,
    WorkReference,
} from '@ever-works/plugin';
import type { KbContextBundleData } from '@ever-works/contracts';

/**
 * EW-641 Phase 2/b row 33a — integration spec covering the full row 32a→32d
 * chain at one go: `KnowledgeBaseService.resolveContext` → executor's
 * `resolveKbContextSafe` → threading through `executePipeline` →
 * `processStep` → `executeStep` → `createStepExecutionContext` (5th arg) →
 * step plugin's `run(ctx, execContext)` callback receives the bundle on
 * `execContext.kbContext`.
 *
 * Unit specs in 32c only verified each link in isolation; this spec drives
 * a real `StepPipelineExecutorService.execute()` through `PipelineBuilderService`
 * and `MockPipelinePlugin`, with a stubbed `PipelineFacadeService` that
 * faithfully echoes the 5th-arg kbContext back into the returned
 * `StepExecutionContext` (same shape the real `PipelineFacadeService`
 * produces post-row-32b). The step executor `run` callback captures the
 * execContext for end-to-end assertions.
 *
 * Row 33b will mirror this for `FullPipelineExecutorService` (self-managed
 * pipelines). Row 33c lifts to an API-level e2e on a real generation
 * invocation.
 */

// Silence the executor's logger during tests — keeps assertion failures front-and-centre.
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const WORK: WorkReference = {
    id: 'work-kb-integration',
    name: 'KB Integration Work',
    slug: 'kb-integration',
    user: { id: 'user-kb-integration' },
};

const REQUEST: GenerationRequest = {
    prompt: 'voice and tone please',
    config: {},
};

const EXISTING: ExistingItems = {
    items: [],
    categories: [],
    tags: [],
};

const STEPS = createLinearChain(['kb-integ-step']);

const SAMPLE_BUNDLE: KbContextBundleData = {
    alwaysInjected: [
        // Minimal shape — the executor doesn't introspect these; only the
        // step plugin would. Keep just enough so a downstream consumer
        // could call `formatKbContext` on a real bundle.
        { id: 'brand-1', title: 'Brand voice', class: 'brand', slug: 'voice' } as any,
    ],
    queryRetrieved: [
        {
            id: 'research-1',
            title: 'Voice research',
            class: 'research',
            slug: 'voice-research',
        } as any,
    ],
};

interface TestHarness {
    service: StepPipelineExecutorService;
    plugin: MockPipelinePlugin;
    registry: PluginRegistryService;
    /** Snapshot of every (work, providers, aiModel, signal, kbContext) tuple passed to the facade. */
    facadeCalls: Array<{
        work: WorkReference;
        kbContext: KbContextBundleData | undefined;
    }>;
    /** Captured execContext from the step executor's `run` callback. */
    capturedExecContexts: StepExecutionContext[];
    kbService: { resolveContext: jest.Mock };
}

async function buildHarness(kbResolveContext: jest.Mock | undefined): Promise<TestHarness> {
    const facadeCalls: TestHarness['facadeCalls'] = [];
    const capturedExecContexts: StepExecutionContext[] = [];

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
                        // Just enough surface for the step run() callback —
                        // the integration spec only asserts on `kbContext`.
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
        { provide: CACHE_MANAGER, useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() } },
        { provide: PipelineFacadeService, useValue: facadeServiceStub },
        {
            provide: PluginSettingsService,
            useValue: { getSettings: jest.fn().mockResolvedValue({}) },
        },
        {
            provide: PluginContextFactoryService,
            useValue: { addLogInterceptor: jest.fn().mockReturnValue(() => undefined) },
        },
    ];
    if (kbServiceStub) {
        providers.push({ provide: KnowledgeBaseService, useValue: kbServiceStub });
    }

    const module: TestingModule = await Test.createTestingModule({
        providers: [
            StepPipelineExecutorService,
            PipelineBuilderService,
            MockPipelinePlugin,
            PluginRegistryService,
            ...(providers as any[]),
        ],
    }).compile();

    const service = module.get(StepPipelineExecutorService);
    const plugin = module.get(MockPipelinePlugin);
    const registry = module.get(PluginRegistryService);

    plugin.setSteps(STEPS);
    registry.register(plugin, {
        id: 'standard-pipeline',
        name: 'Standard Pipeline',
        version: '1.0.0',
        description: 'Mock pipeline for kb-context integration tests',
        category: 'pipeline',
        capabilities: ['pipeline'],
    });
    registry.updateState('standard-pipeline', 'loaded');

    // Capturing step executor — records the execContext the engine
    // passed in, then stops the pipeline so the test stays small.
    const capturingExecutor: IBuiltInStepExecutor = {
        name: 'KB Integ Step',
        run: jest
            .fn()
            .mockImplementation((ctx: IPipelineContext, execContext: StepExecutionContext) => {
                capturedExecContexts.push(execContext);
                ctx.shouldStop = true;
                return Promise.resolve(ctx);
            }),
    };
    plugin.registerStepExecutor('kb-integ-step', capturingExecutor);

    return {
        service,
        plugin,
        registry,
        facadeCalls,
        capturedExecContexts,
        kbService: kbServiceStub ?? { resolveContext: jest.fn() },
    };
}

describe('KB context end-to-end integration (rows 32a–32d)', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('threads the resolved bundle from KnowledgeBaseService all the way to the step executor execContext', async () => {
        const resolveContext = jest.fn().mockResolvedValue(SAMPLE_BUNDLE);
        const harness = await buildHarness(resolveContext);

        await harness.service.execute(harness.plugin, WORK, REQUEST, EXISTING);

        // 1. KnowledgeBaseService.resolveContext invoked once with the
        //    expected (workId, { query }) args.
        expect(resolveContext).toHaveBeenCalledTimes(1);
        expect(resolveContext).toHaveBeenCalledWith(WORK.id, { query: REQUEST.prompt });

        // 2. Facade received the bundle as the 5th arg of every step's
        //    createStepExecutionContext call.
        expect(harness.facadeCalls.length).toBeGreaterThanOrEqual(1);
        for (const call of harness.facadeCalls) {
            expect(call.work.id).toBe(WORK.id);
            expect(call.kbContext).toEqual(SAMPLE_BUNDLE);
        }

        // 3. The step plugin's `run(ctx, execContext)` callback observes
        //    the bundle on `execContext.kbContext` — that's the surface
        //    real pipeline-step plugins read.
        expect(harness.capturedExecContexts.length).toBeGreaterThanOrEqual(1);
        const seen = harness.capturedExecContexts[0];
        expect(seen.kbContext).toEqual(SAMPLE_BUNDLE);
        expect(seen.kbContext?.alwaysInjected.map((d) => d.id)).toEqual(['brand-1']);
        expect(seen.kbContext?.queryRetrieved.map((d) => d.id)).toEqual(['research-1']);
    });

    it('leaves execContext.kbContext undefined when KnowledgeBaseService is not provided (OSS / unit-test path)', async () => {
        // Pass `undefined` so buildHarness skips wiring the KnowledgeBaseService
        // provider — the executor's @Optional() injection resolves to undefined.
        const harness = await buildHarness(undefined);

        await harness.service.execute(harness.plugin, WORK, REQUEST, EXISTING);

        // Facade still called per step, but with kbContext === undefined.
        expect(harness.facadeCalls.length).toBeGreaterThanOrEqual(1);
        for (const call of harness.facadeCalls) {
            expect(call.kbContext).toBeUndefined();
        }
        // Step run() callback observed an undefined kbContext (no bundle).
        const seen = harness.capturedExecContexts[0];
        expect(seen.kbContext).toBeUndefined();
    });

    it('degrades gracefully when resolveContext throws — kbContext stays undefined, pipeline still runs', async () => {
        const resolveContext = jest.fn().mockRejectedValue(new Error('kb backend down'));
        const harness = await buildHarness(resolveContext);

        // No throw expected — generation should never break on a KB
        // hiccup (row 32c contract).
        await expect(
            harness.service.execute(harness.plugin, WORK, REQUEST, EXISTING),
        ).resolves.toMatchObject({ success: expect.any(Boolean) });

        expect(resolveContext).toHaveBeenCalledTimes(1);
        // Bundle is undefined throughout the chain.
        for (const call of harness.facadeCalls) {
            expect(call.kbContext).toBeUndefined();
        }
        const seen = harness.capturedExecContexts[0];
        expect(seen?.kbContext).toBeUndefined();
    });
});
