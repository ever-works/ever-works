import { Logger } from '@nestjs/common';
import type { ExistingItems, GenerationRequest, WorkReference } from '@ever-works/plugin';
import { PipelineOrchestratorService } from '../pipeline-orchestrator.service';
import type { StepPipelineExecutorService } from '../step-pipeline-executor.service';
import type { FullPipelineExecutorService } from '../full-pipeline-executor.service';
import {
    createRegistry,
    registerColdPlugin,
    requiredSecretSchema,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const work: WorkReference = { id: 'work-1', name: 'Work', slug: 'work', user: { id: 'user-1' } };
const request: GenerationRequest = { prompt: 'Generate', config: {} };
const existing: ExistingItems = { items: [], categories: [], tags: [] };

/**
 * F6 — a pipeline plugin the registry still holds cold loads on its first use,
 * in the orchestrator. When its `onLoad` fails there, the load still resolves
 * and the registry entry turns `error`: the eager boot used to find that at
 * boot and skip the pipeline. The orchestrator must skip it too — never
 * execute a pipeline whose initialisation failed.
 */
describe('PipelineOrchestratorService — a cold pipeline whose onLoad fails on first use', () => {
    function build() {
        const registry = createRegistry();
        const fullExecutor = {
            execute: jest.fn(async (plugin: { id: string }) => ({ ran: plugin.id })),
        };
        const stepExecutor = { execute: jest.fn() };
        const service = new PipelineOrchestratorService(
            stepExecutor as unknown as StepPipelineExecutorService,
            fullExecutor as unknown as FullPipelineExecutorService,
            registry,
        );
        return { registry, fullExecutor, service };
    }

    function registerPipeline(
        registry: ReturnType<typeof createRegistry>,
        id: string,
        options: { isDefault?: boolean; onLoadFails?: boolean } = {},
    ) {
        return registerColdPlugin(registry, {
            id,
            category: 'pipeline',
            capabilities: ['pipeline'],
            settingsSchema: requiredSecretSchema(),
            onLoadFails: options.onLoadFails,
            manifest: {
                autoEnable: true,
                ...(options.isDefault ? { defaultForCapabilities: ['pipeline'] } : {}),
            },
            // A self-managed pipeline: `execute`, no step-orchestration surface.
            members: { execute: async () => ({ success: true }) },
        });
    }

    it('falls back from a default pipeline that fails to load to the next usable one', async () => {
        const { registry, fullExecutor, service } = build();
        registerPipeline(registry, 'broken-default', { isDefault: true, onLoadFails: true });
        registerPipeline(registry, 'healthy');

        await service.execute(work, request, existing);

        expect(registry.get('broken-default')?.state).toBe('error');
        expect(fullExecutor.execute).toHaveBeenCalledTimes(1);
        expect(fullExecutor.execute.mock.calls[0][0]).toMatchObject({ id: 'healthy' });
    });

    it('does not run an explicitly requested pipeline that fails to load', async () => {
        const { registry, fullExecutor, service } = build();
        registerPipeline(registry, 'broken-explicit', { onLoadFails: true });
        registerPipeline(registry, 'healthy-fallback');

        await service.execute(
            work,
            { ...request, providers: { pipeline: 'broken-explicit' } },
            existing,
        );

        expect(fullExecutor.execute.mock.calls[0][0]).toMatchObject({ id: 'healthy-fallback' });
    });

    it('reports no self-managed pipeline when the only one fails to load', async () => {
        const { registry, service } = build();
        registerPipeline(registry, 'broken-only', { onLoadFails: true });

        await expect(service.hasFullPipelinePlugin()).resolves.toBe(false);
        await expect(service.getRecommendedMode()).resolves.toMatchObject({ mode: 'step' });
        await expect(service.execute(work, request, existing)).rejects.toThrow(
            'No pipeline plugin available',
        );
    });
});
