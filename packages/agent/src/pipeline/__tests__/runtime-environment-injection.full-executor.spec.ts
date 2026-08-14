import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';

import { FullPipelineExecutorService } from '../full-pipeline-executor.service';
import { PipelineFacadeService } from '../pipeline-facade.service';
import { PluginContextFactoryService } from '../../plugins/services/plugin-context-factory.service';
import { EnvironmentsService } from '../../environments/environments.service';

import type {
    ExistingItems,
    GenerationRequest,
    IPipelinePlugin,
    PipelineExecutionOptions,
    PipelineResult,
    RuntimeEnvironmentData,
    StepExecutionContext,
    WorkReference,
} from '@ever-works/plugin';

/**
 * Environments — runtime-Environment injection for self-managed
 * pipelines. Contract under test: `options.runtimeEnvironment` is
 * forwarded verbatim; otherwise `options.agentId` resolves through
 * `EnvironmentsService` (best-effort, fail-open); no agentId or no
 * wired service = carrier stays undefined. Harness mirrors the
 * memory-recall spec one file over.
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
            ): StepExecutionContext =>
                ({
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
                    runtimeEnvironment,
                }) as StepExecutionContext,
        ),
    };

    const providers: any[] = [
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

    it('fails open: a resolver error leaves the carrier undefined and the run proceeds', async () => {
        const resolveForAgent = jest.fn().mockRejectedValue(new Error('db down'));
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
