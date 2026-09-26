import type { PipelineStepDefinition } from '@ever-works/plugin';
import { PipelineBuilderService } from '../pipeline-builder.service';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import {
    createRegistry,
    gate,
    registerColdPlugin,
    settle,
    type ColdPluginSpec,
    type Pingable,
} from '../../plugins/__tests__/cold-plugin.fixture';
import { MockPipelinePlugin } from './mock-pipeline-plugin';

/**
 * A pipeline-modifier plugin the registry holds as a COLD lazy proxy — as every
 * disk builtIn is in lazy mode (the default), in every fresh process (every
 * Trigger run). `memory-pipeline-modifier` is the real case: builtIn,
 * `autoEnable: false`, enabled per Work, `targetPipelines` a class field (also
 * mirrored in package.json) and `getStepDefinitions()` a SYNC method.
 *
 * On a cold proxy both read as the async forwarding wrapper, so the builder
 * must load the modifier before it reads its targets or asks for its steps.
 */

const PIPELINE_STEPS: PipelineStepDefinition[] = [
    {
        id: 'prompt-processing',
        name: 'Prompt Processing',
        position: { type: 'first' },
        dependencies: [],
        provides: ['subject'],
        requires: [],
    },
    {
        id: 'markdown-generation',
        name: 'Markdown Generation',
        position: { type: 'last' },
        dependencies: [{ stepId: 'prompt-processing', required: true }],
        provides: [],
        requires: ['subject'],
    },
];

const RECALL_STEP: PipelineStepDefinition = {
    id: 'memory-recall',
    name: 'Memory recall',
    position: { type: 'first' },
};
const SAVE_STEP: PipelineStepDefinition = {
    id: 'memory-save',
    name: 'Memory save',
    position: { type: 'last' },
};

type ModifierOptions = Partial<ColdPluginSpec> & {
    /** The class's `targetPipelines` (package.json mirrors it unless overridden). */
    targetPipelines?: string[];
    /** package.json `targetPipelines`; defaults to the class value. */
    manifestTargets?: string[] | null;
    canSkipAtBuildTime?: jest.Mock;
};

/** A cold `memory-pipeline-modifier`-shaped plugin. */
function registerColdModifier(
    registry: PluginRegistryService,
    id: string,
    options: ModifierOptions = {},
) {
    const targets = options.targetPipelines ?? ['standard-pipeline', 'agent-pipeline'];
    const manifestTargets =
        options.manifestTargets === undefined ? targets : options.manifestTargets;
    const cold = registerColdPlugin(registry, {
        id,
        category: 'utility',
        capabilities: ['pipeline-modifier'],
        settingsSchema: { type: 'object', properties: {} },
        ...options,
        manifest: {
            builtIn: true,
            autoEnable: false,
            ...(manifestTargets ? { targetPipelines: manifestTargets } : {}),
            ...(options.manifest ?? {}),
        },
        members: {
            targetPipelines: targets,
            // Sync, as on the real class — and, like any plugin that sets its
            // client up in onLoad, unusable before onLoad has run.
            getStepDefinitions(this: Pingable): PipelineStepDefinition[] {
                this.ping();
                return [RECALL_STEP, SAVE_STEP];
            },
            execute: async (ctx: unknown) => ctx,
            ...(options.canSkipAtBuildTime
                ? { canSkipAtBuildTime: options.canSkipAtBuildTime }
                : {}),
            ...(options.members ?? {}),
        },
    });
    // Stamped by the host at registration (the loader passes builtIn for a
    // bundled plugin); the fixture registers without it.
    cold.registered.builtIn = true;
    return cold;
}

describe('PipelineBuilderService — a cold (lazy) pipeline-modifier plugin', () => {
    let registry: PluginRegistryService;
    let settingsService: { getSettings: jest.Mock };
    let service: PipelineBuilderService;
    let pipeline: MockPipelinePlugin;

    beforeEach(() => {
        registry = createRegistry();
        // The Work enabled the modifier (it is `autoEnable: false`).
        jest.spyOn(registry, 'isPluginEnabledForScope').mockResolvedValue(true);
        settingsService = { getSettings: jest.fn().mockResolvedValue({}) };
        service = new PipelineBuilderService(registry, settingsService as never);
        pipeline = new MockPipelinePlugin();
        pipeline.setSteps(PIPELINE_STEPS);
    });

    it('loads the modifier, then reads its targets and injects its steps', async () => {
        const cold = registerColdModifier(registry, 'memory-pipeline-modifier');
        expect(cold.proxy.__isMaterialized).toBe(false);

        const built = await service.build(pipeline, 'work-1', 'user-1');

        expect(cold.loads()).toBe(1);
        expect(cold.onLoadDone()).toBe(true);
        expect(built.steps.map((s) => s.id).sort()).toEqual([
            'markdown-generation',
            'memory-recall',
            'memory-save',
            'prompt-processing',
        ]);
        expect(built.steps[0].id).toBe('memory-recall');
        expect(built.executorMap.get('memory-recall')).toEqual(
            expect.objectContaining({ type: 'plugin', pluginId: 'memory-pipeline-modifier' }),
        );
        expect([...built.injectedSteps].sort()).toEqual(['memory-recall', 'memory-save']);
    });

    it('reads targetPipelines from the class once loaded (package.json may omit it)', async () => {
        const cold = registerColdModifier(registry, 'class-only-targets', {
            manifestTargets: null,
        });

        const built = await service.build(pipeline, 'work-1');

        expect(cold.loads()).toBe(1);
        expect(built.steps.some((s) => s.id === 'memory-recall')).toBe(true);
    });

    it('leaves out a loaded modifier whose class does not target this pipeline', async () => {
        registerColdModifier(registry, 'other-pipeline-modifier', {
            targetPipelines: ['agent-pipeline'],
        });

        const built = await service.build(pipeline, 'work-1');

        expect(built.steps.map((s) => s.id)).toEqual(['prompt-processing', 'markdown-generation']);
    });

    it('skips a modifier whose onLoad fails (entry in error), as a boot-time failure did', async () => {
        const cold = registerColdModifier(registry, 'broken-on-load', { onLoadFails: true });

        const built = await service.build(pipeline, 'work-1');

        expect(cold.loads()).toBe(1);
        expect(cold.registered.state).toBe('error');
        expect(built.steps.map((s) => s.id)).toEqual(['prompt-processing', 'markdown-generation']);
    });

    it('skips a modifier whose import fails', async () => {
        const cold = registerColdModifier(registry, 'cannot-import', { failing: true });

        const built = await service.build(pipeline, 'work-1');

        expect(cold.registered.state).toBe('error');
        expect(built.steps.map((s) => s.id)).toEqual(['prompt-processing', 'markdown-generation']);
    });

    it('does not load a modifier the Work has not enabled', async () => {
        const cold = registerColdModifier(registry, 'not-enabled');
        (registry.isPluginEnabledForScope as jest.Mock).mockResolvedValue(false);

        const built = await service.build(pipeline, 'work-1');

        expect(cold.loads()).toBe(0);
        expect(cold.proxy.__isMaterialized).toBe(false);
        expect(built.steps).toHaveLength(2);
    });

    it("calls the loaded class's canSkipAtBuildTime with the resolved settings", async () => {
        const canSkip = jest.fn().mockResolvedValue(true);
        settingsService.getSettings.mockResolvedValue({ enabled: false });
        registerColdModifier(registry, 'skipping-modifier', { canSkipAtBuildTime: canSkip });

        const built = await service.build(pipeline, 'work-1', 'user-1');

        expect(canSkip).toHaveBeenCalledWith(
            expect.objectContaining({
                settings: { enabled: false },
                workId: 'work-1',
                userId: 'user-1',
                pipelineId: 'standard-pipeline',
            }),
        );
        expect(built.steps).toHaveLength(2);
    });

    it('does not probe a canSkipAtBuildTime the class lacks (no settings read)', async () => {
        registerColdModifier(registry, 'no-skip-hook');

        const built = await service.build(pipeline, 'work-1', 'user-1');

        expect(settingsService.getSettings).not.toHaveBeenCalled();
        expect(built.steps).toHaveLength(4);
    });

    it("a second build arriving during the first load waits for the modifier's onLoad", async () => {
        const firstLoad = gate();
        const cold = registerColdModifier(registry, 'slow-first-load', {
            firstLoadGate: firstLoad.promise,
        });

        const first = service.build(pipeline, 'work-1');
        await settle();
        // The proxy has marked itself materialised; onLoad has not run yet.
        expect(cold.proxy.__isMaterialized).toBe(true);
        expect(cold.onLoadDone()).toBe(false);

        const second = service.build(pipeline, 'work-2');
        await settle();

        firstLoad.release();
        const [a, b] = await Promise.all([first, second]);

        expect(cold.loads()).toBe(1);
        expect(a.steps).toHaveLength(4);
        expect(b.steps).toHaveLength(4);
    });
});
