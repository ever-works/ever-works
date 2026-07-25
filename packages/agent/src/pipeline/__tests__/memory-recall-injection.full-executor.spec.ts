import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';

import { FullPipelineExecutorService } from '../full-pipeline-executor.service';
import { PipelineFacadeService } from '../pipeline-facade.service';
import { PluginContextFactoryService } from '../../plugins/services/plugin-context-factory.service';
import { AgentMemoryFacadeService } from '../../facades/agent-memory.facade';
import { NO_MEMORY_FOUND_NOTE } from '../../services/memory-recall';

import type {
    ExistingItems,
    GenerationRequest,
    IPipelinePlugin,
    PipelineExecutionOptions,
    PipelineResult,
    StepExecutionContext,
    WorkReference,
} from '@ever-works/plugin';

/**
 * Memory upgrades M3 — recall injection for self-managed pipelines.
 *
 * `FullPipelineExecutorService.execute()` resolves the fenced
 * `<agent_memory>` recall block ONCE at dispatch (shared helper) and
 * threads it to the plugin via `execContext.memoryRecall`, so
 * claude-code / codex / opencode splice a pre-built string with zero
 * per-plugin formatting. Contract under test: default-on shared
 * toggle (`WorkReference.settings.memoryRecallEnabled === false` is
 * the only off-switch), best-effort degradation, loud-empty note,
 * silent skip when no provider / facade is wired.
 *
 * Harness mirrors the row-33b KB-context spec one file over.
 */

jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const WORK: WorkReference = {
    id: 'work-recall-full',
    name: 'Recall Full Executor Work',
    slug: 'recall-full',
    user: { id: 'user-recall-full' },
};

const REQUEST: GenerationRequest = {
    prompt: 'best voice AI tools',
    config: {},
};

const EXISTING: ExistingItems = {
    items: [],
    categories: [],
    tags: [],
};

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
    facadeCalls: Array<{ work: WorkReference; memoryRecall: string | undefined }>;
}

async function buildHarness(buildContextWithProvider: jest.Mock | undefined): Promise<FullHarness> {
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
                    _kbContext: unknown,
                    _kbTools: unknown,
                    _memorySessionId: string | undefined,
                    memoryRecall: string | undefined,
                ): StepExecutionContext => {
                    facadeCalls.push({ work, memoryRecall });
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
                        memoryRecall,
                    } as StepExecutionContext;
                },
            ),
    };

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
    if (buildContextWithProvider) {
        providers.push({
            provide: AgentMemoryFacadeService,
            useValue: { buildContextWithProvider },
        });
    }

    const module: TestingModule = await Test.createTestingModule({
        providers: [FullPipelineExecutorService, ...(providers as any[])],
    }).compile();

    const service = module.get(FullPipelineExecutorService);
    return { service, facadeCalls };
}

describe('Memory recall injection — full-executor dispatch (M3)', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('threads the fenced recall block into plugin.execute(..., { execContext.memoryRecall })', async () => {
        const buildContextWithProvider = jest.fn().mockResolvedValue({
            context: { content: 'Prior run: 12 items generated for voice tools.' },
            providerId: 'agentmemory-plugin',
        });
        const harness = await buildHarness(buildContextWithProvider);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING);
        expect(result.success).toBe(true);

        // 1. The facade call carries query/purpose/projectId in the
        //    modifier's conventions (slug-first projectId).
        expect(buildContextWithProvider).toHaveBeenCalledTimes(1);
        expect(buildContextWithProvider).toHaveBeenCalledWith(
            expect.objectContaining({
                query: REQUEST.prompt,
                purpose: 'work-generation',
                projectId: WORK.slug,
            }),
            { userId: WORK.user!.id, workId: WORK.id },
        );

        // 2. The plugin observed a pre-fenced, ready-to-splice block.
        expect(captured.execContexts).toHaveLength(1);
        const block = captured.execContexts[0].memoryRecall;
        expect(block).toContain('<agent_memory>');
        expect(block).toContain('Prior run: 12 items generated for voice tools.');
        expect(block).toContain('</agent_memory>');
    });

    it('respects the shared per-Work toggle: settings.memoryRecallEnabled=false skips resolution entirely', async () => {
        const buildContextWithProvider = jest.fn();
        const harness = await buildHarness(buildContextWithProvider);
        const { plugin, captured } = makeCapturingPlugin();

        const disabledWork: WorkReference = {
            ...WORK,
            settings: { memoryRecallEnabled: false },
        };
        const result = await harness.service.execute(plugin, disabledWork, REQUEST, EXISTING);

        expect(result.success).toBe(true);
        expect(buildContextWithProvider).not.toHaveBeenCalled();
        expect(captured.execContexts[0].memoryRecall).toBeUndefined();
    });

    it('defaults ON: a WorkReference without settings still resolves recall', async () => {
        const buildContextWithProvider = jest.fn().mockResolvedValue({
            context: { content: 'remembered' },
            providerId: 'agentmemory-plugin',
        });
        const harness = await buildHarness(buildContextWithProvider);
        const { plugin, captured } = makeCapturingPlugin();

        await harness.service.execute(plugin, WORK, REQUEST, EXISTING);

        expect(buildContextWithProvider).toHaveBeenCalledTimes(1);
        expect(captured.execContexts[0].memoryRecall).toContain('remembered');
    });

    it('is loud-empty: a configured provider with an empty store injects the explicit note block', async () => {
        const buildContextWithProvider = jest.fn().mockResolvedValue({
            context: { content: '' },
            providerId: 'agentmemory-plugin',
        });
        const harness = await buildHarness(buildContextWithProvider);
        const { plugin, captured } = makeCapturingPlugin();

        await harness.service.execute(plugin, WORK, REQUEST, EXISTING);

        expect(captured.execContexts[0].memoryRecall).toContain(NO_MEMORY_FOUND_NOTE);
    });

    it('skips silently on NoProviderError — memoryRecall stays undefined, generation proceeds', async () => {
        const err = new Error('No agent-memory provider configured or available');
        err.name = 'NoProviderError';
        const buildContextWithProvider = jest.fn().mockRejectedValue(err);
        const harness = await buildHarness(buildContextWithProvider);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING);

        expect(result.success).toBe(true);
        expect(captured.execContexts[0].memoryRecall).toBeUndefined();
    });

    it('degrades gracefully when the memory backend fails — recall undefined, plugin still executes', async () => {
        const buildContextWithProvider = jest
            .fn()
            .mockRejectedValue(new Error('memory backend down'));
        const harness = await buildHarness(buildContextWithProvider);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING);

        expect(result.success).toBe(true);
        expect(buildContextWithProvider).toHaveBeenCalledTimes(1);
        expect(captured.execContexts[0].memoryRecall).toBeUndefined();
    });

    it('leaves memoryRecall undefined when no AgentMemoryFacadeService is wired (OSS build)', async () => {
        const harness = await buildHarness(undefined);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING);

        expect(result.success).toBe(true);
        expect(captured.execContexts[0].memoryRecall).toBeUndefined();
    });
});
