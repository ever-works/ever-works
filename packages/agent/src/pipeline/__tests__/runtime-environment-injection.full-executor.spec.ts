import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger, type Provider } from '@nestjs/common';

import { FullPipelineExecutorService } from '../full-pipeline-executor.service';
import { PipelineFacadeService } from '../pipeline-facade.service';
import { PluginContextFactoryService } from '../../plugins/services/plugin-context-factory.service';
import { EnvironmentsService } from '../../environments/environments.service';
import { makePipelineResult } from './fixtures';

import type {
    ExistingItems,
    GenerationRequest,
    IAiFacade,
    IContentExtractorFacade,
    IPipelinePlugin,
    IScreenshotFacade,
    ISearchFacade,
    PipelineExecutionOptions,
    PipelineResult,
    PipelineStepDefinition,
    RuntimeEnvironmentData,
    StepExecutionContext,
    WorkReference,
} from '@ever-works/plugin';

/**
 * Environments — runtime-Environment injection for self-managed
 * pipelines. Contract under test: `options.runtimeEnvironment` is
 * forwarded verbatim; otherwise `options.agentId` resolves through
 * `EnvironmentsService`; no agentId, no wired service, or no assigned
 * Environment = carrier stays undefined, but a resolution ERROR fails
 * the run closed. Harness mirrors the memory-recall spec one file over.
 */

jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const WORK: WorkReference = {
    id: 'work-env-full',
    name: 'Environments Full Executor Work',
    slug: 'env-full',
    user: { id: 'user-env-full' },
};

const REQUEST: GenerationRequest = { prompt: 'best data tools', config: {} };
const EXISTING: ExistingItems = { items: [], categories: [], tags: [] };

const RUNTIME_ENVIRONMENT: RuntimeEnvironmentData = {
    id: 'env-1',
    name: 'Python Data',
    slug: 'python-data',
    pipPackages: ['pandas==2.2.0'],
    npmPackages: [],
    networkingMode: 'limited',
    allowedHosts: ['api.anthropic.com'],
    allowPackageManagers: true,
};

const STEP_DEFINITIONS: readonly PipelineStepDefinition[] = [
    { id: 's1', name: 'Only Step', position: { type: 'first' } },
];

function makeCapturingPlugin(): {
    plugin: IPipelinePlugin;
    captured: { execContexts: StepExecutionContext[] };
} {
    const captured = { execContexts: [] as StepExecutionContext[] };
    const plugin: IPipelinePlugin = {
        id: 'mock-self-managed',
        name: 'Mock Self-Managed Pipeline',
        version: '1.0.0',
        category: 'pipeline',
        capabilities: ['pipeline'],
        settingsSchema: { type: 'object', properties: {} },
        onLoad: async () => undefined,
        onUnload: async () => undefined,
        getStepDefinitions: () => STEP_DEFINITIONS,
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
                    return Promise.resolve(
                        makePipelineResult({ stepsCompleted: 1, totalSteps: 1 }),
                    );
                },
            ),
    };
    return { plugin, captured };
}

/**
 * The capturing plugin only inspects `execContext.runtimeEnvironment`, so the
 * facades on the stub context are never called. This keeps them typed against
 * the real contracts (rather than `any`) without hand-writing every facade
 * method, so a change to `StepExecutionContext` still breaks compilation here.
 */
function stubFacade<T>(): T {
    return {} as unknown as T;
}

async function buildHarness(resolveForAgent: jest.Mock | undefined): Promise<{
    service: FullPipelineExecutorService;
}> {
    const facadeServiceStub = {
        createStepExecutionContext: jest.fn().mockImplementation(
            (
                work: WorkReference,
                _providers: unknown,
                _aiModel: string | undefined,
                _signal: AbortSignal | undefined,
                _kbContext: unknown,
                _kbTools: unknown,
                _memorySessionId: string | undefined,
                _memoryRecall: string | undefined,
                runtimeEnvironment: RuntimeEnvironmentData | undefined,
            ): StepExecutionContext => ({
                aiFacade: stubFacade<IAiFacade>(),
                searchFacade: stubFacade<ISearchFacade>(),
                screenshotFacade: stubFacade<IScreenshotFacade>(),
                contentExtractorFacade: stubFacade<IContentExtractorFacade>(),
                logger: {
                    log: () => undefined,
                    debug: () => undefined,
                    warn: () => undefined,
                    error: () => undefined,
                },
                work,
                user: work.user,
                runtimeEnvironment,
            }),
        ),
    };

    const providers: Provider[] = [
        { provide: EventEmitter2, useValue: { emit: jest.fn(), on: jest.fn(), off: jest.fn() } },
        { provide: PipelineFacadeService, useValue: facadeServiceStub },
        {
            provide: PluginContextFactoryService,
            useValue: { addLogInterceptor: jest.fn().mockReturnValue(() => undefined) },
        },
    ];
    if (resolveForAgent) {
        providers.push({
            provide: EnvironmentsService,
            useValue: { resolveRuntimeEnvironmentForAgent: resolveForAgent },
        });
    }

    const module: TestingModule = await Test.createTestingModule({
        providers: [FullPipelineExecutorService, ...providers],
    }).compile();

    return { service: module.get(FullPipelineExecutorService) };
}

describe('Runtime Environment injection — full-executor dispatch', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('forwards a pre-resolved options.runtimeEnvironment verbatim (no service call)', async () => {
        const resolveForAgent = jest.fn();
        const harness = await buildHarness(resolveForAgent);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING, {
            agentId: 'agent-1',
            runtimeEnvironment: RUNTIME_ENVIRONMENT,
        });

        expect(result.success).toBe(true);
        expect(resolveForAgent).not.toHaveBeenCalled();
        expect(captured.execContexts[0].runtimeEnvironment).toEqual(RUNTIME_ENVIRONMENT);
    });

    it('resolves options.agentId through EnvironmentsService when no pre-resolved carrier', async () => {
        const resolveForAgent = jest.fn().mockResolvedValue(RUNTIME_ENVIRONMENT);
        const harness = await buildHarness(resolveForAgent);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING, {
            agentId: 'agent-1',
        });

        expect(result.success).toBe(true);
        expect(resolveForAgent).toHaveBeenCalledWith('agent-1');
        expect(captured.execContexts[0].runtimeEnvironment).toEqual(RUNTIME_ENVIRONMENT);
    });

    it('fails closed: a resolver error fails the run instead of downgrading the posture', async () => {
        const resolveForAgent = jest.fn().mockRejectedValue(new Error('db down'));
        const harness = await buildHarness(resolveForAgent);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING, {
            agentId: 'agent-1',
        });

        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('db down');
        // The plugin never ran, so it never saw a fallback egress posture.
        expect(plugin.execute).not.toHaveBeenCalled();
        expect(captured.execContexts).toHaveLength(0);
    });

    it('stays undefined (no throw) when the Agent has no Environment assigned', async () => {
        const resolveForAgent = jest.fn().mockResolvedValue(undefined);
        const harness = await buildHarness(resolveForAgent);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING, {
            agentId: 'agent-1',
        });

        expect(result.success).toBe(true);
        expect(captured.execContexts[0].runtimeEnvironment).toBeUndefined();
    });

    it('stays undefined without an agentId (plain Work-generation runs)', async () => {
        const resolveForAgent = jest.fn();
        const harness = await buildHarness(resolveForAgent);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING);

        expect(result.success).toBe(true);
        expect(resolveForAgent).not.toHaveBeenCalled();
        expect(captured.execContexts[0].runtimeEnvironment).toBeUndefined();
    });

    it('stays undefined when EnvironmentsService is not wired (OSS build)', async () => {
        const harness = await buildHarness(undefined);
        const { plugin, captured } = makeCapturingPlugin();

        const result = await harness.service.execute(plugin, WORK, REQUEST, EXISTING, {
            agentId: 'agent-1',
        });

        expect(result.success).toBe(true);
        expect(captured.execContexts[0].runtimeEnvironment).toBeUndefined();
    });
});
