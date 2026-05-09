import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

describe('PipelineOrchestratorService', () => {
    let stepExecutor: any;
    let fullExecutor: any;
    let registry: any;
    let service: PipelineOrchestratorService;

    /**
     * Build a pipeline plugin object that satisfies `isPipelinePlugin` (the
     * type guard checks `plugin.capabilities.includes('pipeline')`).
     * Pass `executeStep` + `registerStepExecutor` to make it
     * step-orchestratable; omit them for self-managed pipelines.
     */
    function makePlugin(
        id: string,
        opts: { name?: string; stepOrchestratable?: boolean } = {},
    ): any {
        const { name = id, stepOrchestratable = true } = opts;
        const plugin: any = {
            id,
            name,
            capabilities: ['pipeline'],
        };
        if (stepOrchestratable) {
            plugin.executeStep = jest.fn();
            plugin.registerStepExecutor = jest.fn();
        }
        return plugin;
    }

    function makeRegistered(plugin: any, manifest: any = {}) {
        return {
            plugin,
            state: 'loaded',
            manifest: { defaultForCapabilities: undefined, ...manifest },
        };
    }

    beforeEach(() => {
        stepExecutor = {
            execute: jest.fn().mockResolvedValue({ success: true }),
            resumeFromCheckpoint: jest.fn().mockResolvedValue(null),
            clearCheckpoint: jest.fn().mockResolvedValue(undefined),
        };
        fullExecutor = {
            execute: jest.fn().mockResolvedValue({ success: true }),
        };
        registry = {
            get: jest.fn(),
            getByCapability: jest.fn().mockReturnValue([]),
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        };
        service = new PipelineOrchestratorService(stepExecutor, fullExecutor, registry);
        // Silence the Logger across tests so the suite output stays focused
        // on assertion failures.
        jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    });

    describe('execute', () => {
        const work = { id: 'w1', user: { id: 'u1' } } as any;
        const request = { providers: { pipeline: undefined } } as any;
        const existing = { items: [] } as any;

        it('routes step-orchestratable plugin to stepExecutor.execute', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                makeRegistered(plugin, { defaultForCapabilities: ['pipeline'] }),
            ]);

            const result = await service.execute(work, request, existing);

            expect(stepExecutor.execute).toHaveBeenCalledWith(
                plugin,
                work,
                request,
                existing,
                undefined,
                undefined,
            );
            expect(fullExecutor.execute).not.toHaveBeenCalled();
            expect(result).toEqual({ success: true });
        });

        it('routes self-managed plugin to fullExecutor.execute', async () => {
            const plugin = makePlugin('claude-code', { stepOrchestratable: false });
            registry.getByCapability.mockReturnValue([
                makeRegistered(plugin, { defaultForCapabilities: ['pipeline'] }),
            ]);

            await service.execute(work, request, existing);

            expect(fullExecutor.execute).toHaveBeenCalledWith(
                plugin,
                work,
                request,
                existing,
                undefined,
                undefined,
            );
            expect(stepExecutor.execute).not.toHaveBeenCalled();
        });

        it('forwards options + onProgress callback to the chosen executor', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                makeRegistered(plugin, { defaultForCapabilities: ['pipeline'] }),
            ]);
            const opts = { signal: 'x' } as any;
            const onProgress = jest.fn();

            await service.execute(work, request, existing, opts, onProgress);

            expect(stepExecutor.execute).toHaveBeenCalledWith(
                plugin,
                work,
                request,
                existing,
                opts,
                onProgress,
            );
        });

        it('uses request.providers.pipeline as the explicit pipeline id', async () => {
            const namedPlugin = makePlugin('claude-code', { stepOrchestratable: false });
            const defaultPlugin = makePlugin('standard', { stepOrchestratable: true });
            registry.get.mockImplementation((id: string) =>
                id === 'claude-code' ? makeRegistered(namedPlugin) : null,
            );
            registry.getByCapability.mockReturnValue([
                makeRegistered(defaultPlugin, { defaultForCapabilities: ['pipeline'] }),
            ]);

            await service.execute(
                work,
                { providers: { pipeline: 'claude-code' } } as any,
                existing,
            );

            // Explicit id wins, so we should hit the full executor with claude-code,
            // NOT the standard pipeline that's marked default.
            expect(fullExecutor.execute).toHaveBeenCalledWith(
                namedPlugin,
                work,
                expect.any(Object),
                existing,
                undefined,
                undefined,
            );
            expect(stepExecutor.execute).not.toHaveBeenCalled();
        });
    });

    describe('executeWithMode', () => {
        const work = { id: 'w1', user: { id: 'u1' } } as any;
        const request = {} as any;
        const existing = {} as any;

        it('forces step mode and resolves through resolvePipelinePlugin auto-detect', async () => {
            const stepPlugin = makePlugin('standard', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                makeRegistered(stepPlugin, { defaultForCapabilities: ['pipeline'] }),
            ]);

            await service.executeWithMode('step', work, request, existing);

            expect(stepExecutor.execute).toHaveBeenCalledWith(
                stepPlugin,
                work,
                request,
                existing,
                undefined,
                undefined,
            );
            expect(fullExecutor.execute).not.toHaveBeenCalled();
        });

        it('forces full mode and routes to the FIRST self-managed plugin (skipping step-orchestratable)', async () => {
            const stepPlugin = makePlugin('standard', { stepOrchestratable: true });
            const fullPlugin = makePlugin('claude-code', { stepOrchestratable: false });
            registry.getByCapability.mockReturnValue([
                makeRegistered(stepPlugin),
                makeRegistered(fullPlugin),
            ]);

            await service.executeWithMode('full', work, request, existing);

            expect(fullExecutor.execute).toHaveBeenCalledWith(
                fullPlugin,
                work,
                request,
                existing,
                undefined,
                undefined,
            );
            expect(stepExecutor.execute).not.toHaveBeenCalled();
        });

        it('falls back to step mode + warns when full mode requested but no self-managed plugin exists', async () => {
            const stepPlugin = makePlugin('standard', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([makeRegistered(stepPlugin)]);
            const warnSpy = jest.spyOn((service as any).logger, 'warn');

            await service.executeWithMode('full', work, request, existing);

            expect(warnSpy).toHaveBeenCalledWith(
                'Full mode requested but no self-managed pipeline available, falling back to step mode',
            );
            expect(stepExecutor.execute).toHaveBeenCalledWith(
                stepPlugin,
                work,
                request,
                existing,
                undefined,
                undefined,
            );
            expect(fullExecutor.execute).not.toHaveBeenCalled();
        });
    });

    describe('getRecommendedMode', () => {
        it('returns mode=full + plugin id when a self-managed pipeline is available', async () => {
            const fullPlugin = makePlugin('claude-code', { stepOrchestratable: false });
            registry.getByCapability.mockReturnValue([makeRegistered(fullPlugin)]);

            const result = await service.getRecommendedMode();

            expect(result).toEqual({
                mode: 'full',
                reason: 'Self-managed pipeline plugin "claude-code" is available',
                plugin: 'claude-code',
            });
        });

        it('returns mode=step when ONLY step-orchestratable pipelines are available', async () => {
            const stepPlugin = makePlugin('standard', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([makeRegistered(stepPlugin)]);

            const result = await service.getRecommendedMode();

            expect(result).toEqual({
                mode: 'step',
                reason: 'No self-managed pipeline plugin available',
            });
            expect(result.plugin).toBeUndefined();
        });

        it('returns mode=step when registry is empty', async () => {
            registry.getByCapability.mockReturnValue([]);
            const result = await service.getRecommendedMode();
            expect(result.mode).toBe('step');
        });
    });

    describe('hasFullPipelinePlugin', () => {
        it('returns true when at least one self-managed plugin is loaded', async () => {
            const stepPlugin = makePlugin('standard', { stepOrchestratable: true });
            const fullPlugin = makePlugin('claude-code', { stepOrchestratable: false });
            registry.getByCapability.mockReturnValue([
                makeRegistered(stepPlugin),
                makeRegistered(fullPlugin),
            ]);
            await expect(service.hasFullPipelinePlugin()).resolves.toBe(true);
        });

        it('returns false when only step-orchestratable plugins exist', async () => {
            const stepPlugin = makePlugin('standard', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([makeRegistered(stepPlugin)]);
            await expect(service.hasFullPipelinePlugin()).resolves.toBe(false);
        });

        it('returns false when registry is empty', async () => {
            registry.getByCapability.mockReturnValue([]);
            await expect(service.hasFullPipelinePlugin()).resolves.toBe(false);
        });
    });

    describe('getAvailablePipelinePlugins', () => {
        it('queries the PIPELINE capability + filters loaded + maps to plugin + filters via isPipelinePlugin', () => {
            const goodPlugin = makePlugin('p1', { stepOrchestratable: true });
            const goodPlugin2 = makePlugin('p2', { stepOrchestratable: false });
            const unloadedPlugin = makePlugin('p3', { stepOrchestratable: true });
            // Plugin without `capabilities: ['pipeline']` — fails isPipelinePlugin.
            const wrongCapsPlugin: any = {
                id: 'p4',
                name: 'p4',
                capabilities: ['search'],
            };
            registry.getByCapability.mockReturnValue([
                makeRegistered(goodPlugin),
                makeRegistered(goodPlugin2),
                { plugin: unloadedPlugin, state: 'unloaded', manifest: {} },
                makeRegistered(wrongCapsPlugin),
            ]);

            const result = service.getAvailablePipelinePlugins();

            expect(registry.getByCapability).toHaveBeenCalledWith(PLUGIN_CAPABILITIES.PIPELINE);
            expect(result).toEqual([goodPlugin, goodPlugin2]);
        });

        it('returns [] when registry is empty', () => {
            registry.getByCapability.mockReturnValue([]);
            expect(service.getAvailablePipelinePlugins()).toEqual([]);
        });
    });

    describe('resumeFromCheckpoint', () => {
        it('resolves the pipeline plugin then proxies to stepExecutor.resumeFromCheckpoint', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.get.mockReturnValue(makeRegistered(plugin));
            stepExecutor.resumeFromCheckpoint.mockResolvedValue({
                success: true,
                resumed: true,
            });

            const opts = { abortSignal: 's' } as any;
            const onProgress = jest.fn();
            const result = await service.resumeFromCheckpoint(
                'work-1',
                'standard',
                opts,
                onProgress,
            );

            expect(registry.get).toHaveBeenCalledWith('standard');
            expect(stepExecutor.resumeFromCheckpoint).toHaveBeenCalledWith(
                plugin,
                'work-1',
                'standard',
                opts,
                onProgress,
            );
            expect(result).toEqual({ success: true, resumed: true });
        });

        it('forwards a null return from the step executor (no-checkpoint case)', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.get.mockReturnValue(makeRegistered(plugin));
            stepExecutor.resumeFromCheckpoint.mockResolvedValue(null);

            await expect(service.resumeFromCheckpoint('work-1', 'standard')).resolves.toBeNull();
        });
    });

    describe('clearCheckpoint', () => {
        it('proxies workId + pipelineId to stepExecutor.clearCheckpoint', async () => {
            await service.clearCheckpoint('work-1', 'standard');
            expect(stepExecutor.clearCheckpoint).toHaveBeenCalledWith('work-1', 'standard');
        });
    });

    describe('resumeOrExecute', () => {
        const work = { id: 'w1', user: { id: 'u1' } } as any;
        const request = { providers: { pipeline: 'standard' } } as any;
        const existing = {} as any;

        it('returns the resumed result when a checkpoint exists for a step-orchestratable plugin', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.get.mockReturnValue(makeRegistered(plugin));
            const resumed = { success: true, resumed: true };
            stepExecutor.resumeFromCheckpoint.mockResolvedValue(resumed);

            const result = await service.resumeOrExecute(work, request, existing);

            expect(stepExecutor.resumeFromCheckpoint).toHaveBeenCalledWith(
                plugin,
                'w1',
                'standard',
                undefined,
                undefined,
            );
            expect(stepExecutor.execute).not.toHaveBeenCalled();
            expect(fullExecutor.execute).not.toHaveBeenCalled();
            expect(result).toBe(resumed);
        });

        it('falls through to fresh execute when no checkpoint exists', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.get.mockReturnValue(makeRegistered(plugin));
            stepExecutor.resumeFromCheckpoint.mockResolvedValue(null);
            registry.getByCapability.mockReturnValue([
                makeRegistered(plugin, { defaultForCapabilities: ['pipeline'] }),
            ]);

            await service.resumeOrExecute(work, request, existing);

            expect(stepExecutor.resumeFromCheckpoint).toHaveBeenCalled();
            expect(stepExecutor.execute).toHaveBeenCalled();
        });

        it('skips checkpoint resume entirely for self-managed plugins (resume not supported)', async () => {
            const plugin = makePlugin('claude-code', { stepOrchestratable: false });
            registry.get.mockReturnValue(makeRegistered(plugin));
            registry.getByCapability.mockReturnValue([
                makeRegistered(plugin, { defaultForCapabilities: ['pipeline'] }),
            ]);

            await service.resumeOrExecute(
                work,
                { providers: { pipeline: 'claude-code' } } as any,
                existing,
            );

            expect(stepExecutor.resumeFromCheckpoint).not.toHaveBeenCalled();
            expect(fullExecutor.execute).toHaveBeenCalled();
        });
    });

    describe('resolvePipelinePlugin (private, exercised via execute)', () => {
        const work = { id: 'w1', user: { id: 'u1' } } as any;
        const existing = {} as any;

        it('explicit pipelineId hits registry.get + isPluginEnabledForScope', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.get.mockReturnValue(makeRegistered(plugin));
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            await service.execute(work, { providers: { pipeline: 'standard' } } as any, existing);

            expect(registry.get).toHaveBeenCalledWith('standard');
            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith('standard', 'w1', 'u1');
            expect(stepExecutor.execute).toHaveBeenCalledWith(
                plugin,
                expect.any(Object),
                expect.any(Object),
                existing,
                undefined,
                undefined,
            );
        });

        it('falls back to auto-detect when explicit pipelineId is not registered', async () => {
            registry.get.mockReturnValue(null);
            const fallbackPlugin = makePlugin('standard', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                makeRegistered(fallbackPlugin, { defaultForCapabilities: ['pipeline'] }),
            ]);
            const warnSpy = jest.spyOn((service as any).logger, 'warn');

            await service.execute(work, { providers: { pipeline: 'missing' } } as any, existing);

            expect(warnSpy).toHaveBeenCalledWith(
                'Pipeline plugin "missing" not available, falling back to auto-detect',
            );
            expect(stepExecutor.execute).toHaveBeenCalledWith(
                fallbackPlugin,
                expect.any(Object),
                expect.any(Object),
                existing,
                undefined,
                undefined,
            );
        });

        it('falls back to auto-detect when explicit pipeline is registered but unloaded', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.get.mockReturnValue({
                plugin,
                state: 'unloaded',
                manifest: {},
            });
            const fallbackPlugin = makePlugin('standard-2', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                makeRegistered(fallbackPlugin, { defaultForCapabilities: ['pipeline'] }),
            ]);

            await service.execute(work, { providers: { pipeline: 'standard' } } as any, existing);

            expect(stepExecutor.execute).toHaveBeenCalledWith(
                fallbackPlugin,
                expect.any(Object),
                expect.any(Object),
                existing,
                undefined,
                undefined,
            );
        });

        it('falls back to auto-detect when explicit plugin is registered but isPluginEnabledForScope=false', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.get.mockReturnValue(makeRegistered(plugin));
            const fallbackPlugin = makePlugin('alt', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                makeRegistered(fallbackPlugin, { defaultForCapabilities: ['pipeline'] }),
            ]);
            // First call (for the explicit id) → false; second (for the auto-detect default) → true.
            registry.isPluginEnabledForScope
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);

            await service.execute(work, { providers: { pipeline: 'standard' } } as any, existing);

            expect(stepExecutor.execute).toHaveBeenCalledWith(
                fallbackPlugin,
                expect.any(Object),
                expect.any(Object),
                existing,
                undefined,
                undefined,
            );
        });

        it('auto-detect prefers a defaultForCapabilities pipeline over a plain enabled one', async () => {
            const fallback = makePlugin('plain', { stepOrchestratable: true });
            const def = makePlugin('default-pipe', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                makeRegistered(fallback), // listed first BUT not default
                makeRegistered(def, { defaultForCapabilities: ['pipeline'] }),
            ]);

            await service.execute(work, { providers: {} } as any, existing);

            expect(stepExecutor.execute).toHaveBeenCalledWith(
                def,
                expect.any(Object),
                expect.any(Object),
                existing,
                undefined,
                undefined,
            );
        });

        it('auto-detect skips unloaded plugins on the default-for pass', async () => {
            const unloadedDefault = makePlugin('unloaded-default', { stepOrchestratable: true });
            const loadedFallback = makePlugin('plain', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                {
                    plugin: unloadedDefault,
                    state: 'unloaded',
                    manifest: { defaultForCapabilities: ['pipeline'] },
                },
                makeRegistered(loadedFallback),
            ]);

            await service.execute(work, { providers: {} } as any, existing);

            expect(stepExecutor.execute).toHaveBeenCalledWith(
                loadedFallback,
                expect.any(Object),
                expect.any(Object),
                existing,
                undefined,
                undefined,
            );
        });

        it('auto-detect skips a default plugin when isPluginEnabledForScope=false on the first pass', async () => {
            const def = makePlugin('default-pipe', { stepOrchestratable: true });
            const fallback = makePlugin('plain', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                makeRegistered(def, { defaultForCapabilities: ['pipeline'] }),
                makeRegistered(fallback),
            ]);
            // First call (default-pipe) → false; second pass first plugin (default-pipe again on
            // the fallback loop) → false; third (fallback plain) → true.
            registry.isPluginEnabledForScope
                .mockResolvedValueOnce(false) // default pass: def
                .mockResolvedValueOnce(false) // fallback pass: def again
                .mockResolvedValueOnce(true); // fallback pass: plain

            await service.execute(work, { providers: {} } as any, existing);

            expect(stepExecutor.execute).toHaveBeenCalledWith(
                fallback,
                expect.any(Object),
                expect.any(Object),
                existing,
                undefined,
                undefined,
            );
        });

        it('throws when no pipeline plugin is loaded + enabled at all', async () => {
            registry.getByCapability.mockReturnValue([]);

            await expect(service.execute(work, { providers: {} } as any, existing)).rejects.toThrow(
                'No pipeline plugin available. Ensure at least one pipeline plugin is loaded.',
            );
            expect(stepExecutor.execute).not.toHaveBeenCalled();
            expect(fullExecutor.execute).not.toHaveBeenCalled();
        });

        it('skips a registered plugin whose `plugin.capabilities` does not include "pipeline"', async () => {
            // The auto-detect loop uses isPipelinePlugin which checks capabilities.
            const wrongCapsPlugin: any = {
                id: 'fake',
                name: 'fake',
                capabilities: ['search'],
            };
            const realPlugin = makePlugin('real', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                makeRegistered(wrongCapsPlugin, { defaultForCapabilities: ['pipeline'] }),
                makeRegistered(realPlugin, { defaultForCapabilities: ['pipeline'] }),
            ]);

            await service.execute(work, { providers: {} } as any, existing);

            expect(stepExecutor.execute).toHaveBeenCalledWith(
                realPlugin,
                expect.any(Object),
                expect.any(Object),
                existing,
                undefined,
                undefined,
            );
        });

        it('treats null pipelineId the same as undefined (skips registry.get path)', async () => {
            const def = makePlugin('default', { stepOrchestratable: true });
            registry.getByCapability.mockReturnValue([
                makeRegistered(def, { defaultForCapabilities: ['pipeline'] }),
            ]);

            await service.execute(work, { providers: { pipeline: null } } as any, existing);

            // `typeof null === 'object'`, so the `typeof pipelineId === 'string'` guard is false:
            // registry.get is NOT called, and we go straight to auto-detect.
            expect(registry.get).not.toHaveBeenCalled();
            expect(stepExecutor.execute).toHaveBeenCalledWith(
                def,
                expect.any(Object),
                expect.any(Object),
                existing,
                undefined,
                undefined,
            );
        });

        it('forwards work.id + work.user.id to isPluginEnabledForScope (scope check)', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.get.mockReturnValue(makeRegistered(plugin));

            await service.execute(
                { id: 'w-42', user: { id: 'u-99' } } as any,
                { providers: { pipeline: 'standard' } } as any,
                existing,
            );

            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith(
                'standard',
                'w-42',
                'u-99',
            );
        });

        it('handles work.user being undefined → forwards undefined userId', async () => {
            const plugin = makePlugin('standard', { stepOrchestratable: true });
            registry.get.mockReturnValue(makeRegistered(plugin));

            await service.execute(
                { id: 'w1' } as any, // no user
                { providers: { pipeline: 'standard' } } as any,
                existing,
            );

            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith(
                'standard',
                'w1',
                undefined,
            );
        });
    });
});
