import {
    PluginExecutionRouterService,
    classifyOperation,
    type TriggerDispatcher,
    type PluginExecutionTaskOutcome
} from '../services/plugin-execution-router.service';
import type { PluginRegistryService, RegisteredPlugin } from '../services/plugin-registry.service';
import type { PluginInstallerService } from '../services/plugin-installer.service';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';

/**
 * EW-693 / T25-T28 — execution router.
 *
 * Pinned behaviours:
 * 1. Bundled-mode routing is ALWAYS in-process (FR-22). No Trigger.dev
 *    dispatch occurs even for operations classified as long-running.
 * 2. Manifest `executionProfile` is the highest-priority signal.
 * 3. Operation taxonomy default: short for unknown / search / extract;
 *    long-running for pipeline.run / deploy.deploy / generation.run
 *    plus the `.long-running` / `.deploy` / `.generate` suffix wildcards.
 * 4. dispatchSync calls ensurePluginAvailable BEFORE looking up the
 *    plugin from the registry (FR-13).
 * 5. Both paths return the unified `{ ok, location, result | error }`
 *    envelope. Throws never escape `dispatch*`.
 */
describe('PluginExecutionRouterService (EW-693)', () => {
    function makeRegistry(
        plugins: Record<string, Partial<RegisteredPlugin> & { exec?: Record<string, unknown> }>
    ) {
        return {
            get: jest.fn((id: string) => {
                const entry = plugins[id];
                if (!entry) return undefined;
                return {
                    manifest: entry.manifest ?? { id, executionProfile: undefined },
                    plugin: entry.exec ?? {},
                    ...entry,
                } as RegisteredPlugin;
            }),
        } as unknown as PluginRegistryService;
    }

    function makeInstaller(): PluginInstallerService & { ensurePluginAvailable: jest.Mock } {
        return {
            ensurePluginAvailable: jest.fn(async () => null),
            getDistributionMode: jest.fn(() => 'dynamic'),
        } as unknown as PluginInstallerService & { ensurePluginAvailable: jest.Mock };
    }

    function makeRouter(
        opts: Partial<PluginsModuleOptions>,
        registry: PluginRegistryService,
        installer?: PluginInstallerService
    ) {
        return new PluginExecutionRouterService(
            { distributionMode: 'bundled', ...opts },
            registry,
            installer
        );
    }

    describe('classifyOperation', () => {
        it.each([
            ['pipeline.run', 'long-running'],
            ['deploy.deploy', 'long-running'],
            ['generation.run', 'long-running'],
            ['work.generate', 'long-running'],
            ['something.long-running', 'long-running'],
            ['vendor.deploy', 'long-running'],
            ['site.generate', 'long-running'],
            ['cohort.run-pipeline', 'long-running'],
        ] as const)('classifies %p as long-running', (operation, expected) => {
            expect(classifyOperation(operation)).toBe(expected);
        });

        it.each([
            ['list-models', 'sync'],
            ['extract', 'sync'],
            ['search', 'sync'],
            ['', 'sync'],
            ['health.check', 'sync'],
        ] as const)('defaults %p to sync', (operation, expected) => {
            expect(classifyOperation(operation)).toBe(expected);
        });
    });

    describe('route (bundled mode — FR-22)', () => {
        it('always returns in-process regardless of operation', () => {
            const registry = makeRegistry({});
            const router = makeRouter({ distributionMode: 'bundled' }, registry);

            expect(router.route('any', 'pipeline.run')).toEqual({
                location: 'in-process',
                reason: 'bundled-mode',
            });
            expect(router.route('any', 'list-models')).toEqual({
                location: 'in-process',
                reason: 'bundled-mode',
            });
        });
    });

    describe('route (dynamic mode)', () => {
        it('manifest executionProfile wins over operation taxonomy', () => {
            const registry = makeRegistry({
                pipeliney: { manifest: { id: 'pipeliney', executionProfile: 'sync' } as never },
                fastapi: { manifest: { id: 'fastapi', executionProfile: 'long-running' } as never },
            });
            const router = makeRouter({ distributionMode: 'dynamic' }, registry);

            // Operation taxonomy would say long-running for pipeline.run,
            // but the manifest hint forces in-process.
            expect(router.route('pipeliney', 'pipeline.run').location).toBe('in-process');
            // Operation taxonomy would say sync for list-models, but the
            // manifest hint forces job-runtime.
            expect(router.route('fastapi', 'list-models').location).toBe('job-runtime');
        });

        it('falls back to operation taxonomy when manifest has no hint', () => {
            const registry = makeRegistry({
                ext: { manifest: { id: 'ext' } as never },
                pipe: { manifest: { id: 'pipe' } as never },
            });
            const router = makeRouter({ distributionMode: 'dynamic' }, registry);

            expect(router.route('ext', 'extract').location).toBe('in-process');
            expect(router.route('pipe', 'pipeline.run').location).toBe('job-runtime');
        });
    });

    describe('dispatchSync', () => {
        it('calls ensurePluginAvailable BEFORE registry.get (FR-13)', async () => {
            const installer = makeInstaller();
            let ensureCalledFirst = false;
            const registry = makeRegistry({});
            (registry.get as jest.Mock).mockImplementation(() => {
                // If ensurePluginAvailable was called before us, the spy
                // records the ordering for us.
                ensureCalledFirst = installer.ensurePluginAvailable.mock.calls.length === 1;
                return undefined;
            });

            const router = makeRouter({ distributionMode: 'dynamic' }, registry, installer);
            await router.dispatchSync('notion-extractor', 'extract');

            expect(installer.ensurePluginAvailable).toHaveBeenCalledWith('notion-extractor');
            expect(ensureCalledFirst).toBe(true);
        });

        it('returns ok=true + the operation result on success', async () => {
            const exec = { extract: jest.fn(async () => ({ items: 5 })) };
            const registry = makeRegistry({
                'notion-extractor': { manifest: { id: 'notion-extractor' } as never, exec },
            });
            const router = makeRouter({ distributionMode: 'dynamic' }, registry, makeInstaller());

            const result = await router.dispatchSync('notion-extractor', 'extract', { url: 'x' });

            expect(result).toEqual({
                ok: true,
                location: 'in-process',
                result: { items: 5 },
            });
            expect(exec.extract).toHaveBeenCalledWith({ url: 'x' });
        });

        it('returns ok=false + OPERATION_NOT_FOUND when the method is missing', async () => {
            const registry = makeRegistry({
                'notion-extractor': { manifest: { id: 'notion-extractor' } as never, exec: {} },
            });
            const router = makeRouter({ distributionMode: 'dynamic' }, registry, makeInstaller());

            const result = await router.dispatchSync('notion-extractor', 'extract');

            expect(result.ok).toBe(false);
            expect(result.error?.code).toBe('OPERATION_NOT_FOUND');
        });

        it('returns ok=false + IN_PROCESS_THREW when the plugin throws', async () => {
            const exec = {
                extract: jest.fn(async () => {
                    throw new Error('boom');
                }),
            };
            const registry = makeRegistry({
                'notion-extractor': { manifest: { id: 'notion-extractor' } as never, exec },
            });
            const router = makeRouter({ distributionMode: 'dynamic' }, registry, makeInstaller());

            const result = await router.dispatchSync('notion-extractor', 'extract');

            expect(result.ok).toBe(false);
            expect(result.error).toEqual({ message: 'boom', code: 'IN_PROCESS_THREW' });
        });
    });

    describe('dispatchLongRunning', () => {
        function makeDispatcher(outcome: PluginExecutionTaskOutcome | null): TriggerDispatcher {
            return {
                trigger: jest.fn(async () => ({ id: 'run_1' })),
                waitForResult: jest.fn(async () => outcome),
            };
        }

        it('forwards a happy-path outcome from the Trigger.dev task', async () => {
            const registry = makeRegistry({});
            const router = makeRouter({ distributionMode: 'dynamic' }, registry);
            const dispatcher = makeDispatcher({ ok: true, result: { generated: 42 } });
            router.setTriggerDispatcherForTests(dispatcher);

            const result = await router.dispatchLongRunning('pipeliney', 'pipeline.run', {
                workId: 'w1',
            });

            expect(result).toEqual({
                ok: true,
                location: 'job-runtime',
                result: { generated: 42 },
            });
            expect(dispatcher.trigger).toHaveBeenCalledWith({
                pluginId: 'pipeliney',
                operation: 'pipeline.run',
                args: { workId: 'w1' },
            });
        });

        it('forwards a worker-side failure verbatim', async () => {
            const registry = makeRegistry({});
            const router = makeRouter({ distributionMode: 'dynamic' }, registry);
            router.setTriggerDispatcherForTests(
                makeDispatcher({
                    ok: false,
                    error: { message: 'worker exploded', code: 'WORKER_PLUGIN_THREW' },
                })
            );

            const result = await router.dispatchLongRunning('pipeliney', 'pipeline.run');

            expect(result.ok).toBe(false);
            expect(result.error).toEqual({
                message: 'worker exploded',
                code: 'WORKER_PLUGIN_THREW',
            });
            expect(result.location).toBe('job-runtime');
        });

        it('returns JOB_RUNTIME_DISPATCH_FAILED when triggering raises', async () => {
            const registry = makeRegistry({});
            const router = makeRouter({ distributionMode: 'dynamic' }, registry);
            router.setTriggerDispatcherForTests({
                trigger: jest.fn(async () => {
                    throw new Error('no broker');
                }),
                waitForResult: jest.fn(),
            });

            const result = await router.dispatchLongRunning('pipeliney', 'pipeline.run');

            expect(result.ok).toBe(false);
            expect(result.error?.code).toBe('JOB_RUNTIME_DISPATCH_FAILED');
            expect(result.error?.message).toBe('no broker');
        });
    });

    describe('dispatch (end-to-end routing)', () => {
        it('routes via in-process for bundled mode without ever touching the dispatcher', async () => {
            const exec = { 'pipeline.run': jest.fn(async () => ({ done: true })) };
            const registry = makeRegistry({
                p: { manifest: { id: 'p' } as never, exec },
            });
            const router = makeRouter({ distributionMode: 'bundled' }, registry, makeInstaller());

            // No dispatcher injected — would throw if reached.
            const result = await router.dispatch('p', 'pipeline.run');

            expect(result.location).toBe('in-process');
            expect(exec['pipeline.run']).toHaveBeenCalled();
        });

        it('routes long-running ops through the job runtime when in dynamic mode', async () => {
            const registry = makeRegistry({ p: { manifest: { id: 'p' } as never } });
            const router = makeRouter({ distributionMode: 'dynamic' }, registry, makeInstaller());
            const dispatcher: TriggerDispatcher = {
                trigger: jest.fn(async () => ({ id: 'r' })),
                waitForResult: jest.fn(async () => ({ ok: true, result: 42 })),
            };
            router.setTriggerDispatcherForTests(dispatcher);

            const result = await router.dispatch('p', 'pipeline.run');

            expect(result.location).toBe('job-runtime');
            expect(dispatcher.trigger).toHaveBeenCalled();
        });
    });
});
