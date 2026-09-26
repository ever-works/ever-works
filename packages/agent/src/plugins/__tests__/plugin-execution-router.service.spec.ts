import {
    PluginExecutionRouterService,
    classifyOperation,
    type TriggerDispatcher,
    type PluginExecutionTaskOutcome,
} from '../services/plugin-execution-router.service';
import { getEventListeners } from 'events';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import { PluginRegistryService, type RegisteredPlugin } from '../services/plugin-registry.service';
import type { PluginInstallerService } from '../services/plugin-installer.service';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import { JOB_RUNTIME_PROVIDER_REGISTRY } from '../../tasks/job-runtime.providers';
import { TenantAwareRuntimeResolver } from '../../tasks/tenant-aware-runtime.resolver';
import { RuntimeBindingStamperService } from '../../tasks/runtime-binding-stamper.service';
import { PLUGIN_OPERATION_DEFAULT_WAIT_MS } from '../../tasks/plugin-operation-dispatch';
import { createLazyPluginProxy } from '../services/lazy-plugin-proxy';

/**
 * EW-693 / T25-T28 — execution router.
 *
 * Pinned behaviours:
 * 1. Bundled mode with NO explicit profile routes in-process (FR-22): no job
 *    runtime dispatch even for operations the taxonomy calls long-running. An
 *    explicit per-call profile, or the manifest's `executionProfile`, is
 *    honoured in bundled mode too (EW-693 T27 — see the block at the end).
 * 2. An explicit per-call profile, then the manifest `executionProfile`, are
 *    the highest-priority signals.
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
        plugins: Record<string, Partial<RegisteredPlugin> & { exec?: Record<string, unknown> }>,
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
        installer?: PluginInstallerService,
    ) {
        return new PluginExecutionRouterService(
            { distributionMode: 'bundled', ...opts },
            registry,
            installer,
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
                'notion-extractor': {
                    manifest: {
                        id: 'notion-extractor',
                        operations: [{ name: 'extract' }],
                    } as never,
                    exec,
                },
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
                'notion-extractor': {
                    manifest: {
                        id: 'notion-extractor',
                        operations: [{ name: 'extract' }],
                    } as never,
                    exec,
                },
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
                // The run id travels with every job-runtime answer, so a caller
                // can read the run again later.
                runId: 'run_1',
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
                }),
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
                p: { manifest: { id: 'p', operations: [{ name: 'pipeline.run' }] } as never, exec },
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

    /**
     * EW-693 / T27 — the long-running path, made to work.
     *
     * The router used to lazy-import `@trigger.dev/sdk` (which does not resolve
     * from this package) and wait on `wait.forRunToComplete` (which SDK 4.5.11
     * does not have), so every long-running call reported "empty result" while
     * the real run kept going. It now dispatches through the ACTIVE JOB RUNTIME
     * (`dispatchers.dispatchPluginOperation`) and waits on its `getRunResult`.
     */
    describe('the job-runtime path (EW-693 T27)', () => {
        type Read = {
            status: string;
            output?: unknown;
            error?: { message: string } | null;
            outputUnavailable?: boolean;
        };

        function makeRuntime(reads: Read[] = [], runId: string | null = 'run_7') {
            const queue = [...reads];
            const provider = {
                dispatchers: { dispatchPluginOperation: jest.fn(async () => runId) },
                getRunResult: jest.fn(async () => queue.shift() ?? { status: 'running' }),
                cancel: jest.fn(async () => true),
            };
            const registry = { getActive: jest.fn(() => provider) };
            return { provider, registry };
        }

        function routerWith(
            runtime: { registry: unknown } | null,
            opts: Partial<PluginsModuleOptions> = {},
            plugins: Parameters<typeof makeRegistry>[0] = {},
        ) {
            return new PluginExecutionRouterService(
                { distributionMode: 'bundled', ...opts },
                makeRegistry(plugins),
                undefined,
                (runtime?.registry ?? null) as never,
            );
        }

        const fast = { pollIntervalMs: 1, timeoutMs: 5_000 };

        describe('route — explicit and manifest profiles are honoured in bundled mode', () => {
            it('sends an explicit long-running call to the job runtime even in bundled mode', () => {
                expect(
                    routerWith(null).route('p', 'runSandboxSession', { profile: 'long-running' }),
                ).toEqual({
                    location: 'job-runtime',
                    reason: 'caller:profile=long-running',
                });
            });

            it('honours a manifest executionProfile of long-running in bundled mode', () => {
                const router = routerWith(
                    null,
                    {},
                    {
                        p: { manifest: { id: 'p', executionProfile: 'long-running' } as never },
                    },
                );
                expect(router.route('p', 'execute').location).toBe('job-runtime');
            });

            it('an explicit sync profile beats a long-running manifest', () => {
                const router = routerWith(
                    null,
                    { distributionMode: 'dynamic' },
                    {
                        p: { manifest: { id: 'p', executionProfile: 'long-running' } as never },
                    },
                );
                expect(router.route('p', 'execute', { profile: 'sync' }).location).toBe(
                    'in-process',
                );
            });

            it('still keeps an UNMARKED call in-process in bundled mode (FR-22)', () => {
                expect(routerWith(null).route('p', 'pipeline.run')).toEqual({
                    location: 'in-process',
                    reason: 'bundled-mode',
                });
            });
        });

        describe('dispatchLongRunning — through the active job runtime', () => {
            it('starts the run, waits through queued and running, and answers the task’s result with its run id', async () => {
                const runtime = makeRuntime([
                    { status: 'queued' },
                    { status: 'running' },
                    { status: 'completed', output: { ok: true, result: { n: 9 } } },
                ]);
                const router = routerWith(runtime);

                const result = await router.dispatchLongRunning(
                    'p',
                    'runSandboxSession',
                    { a: 1 },
                    fast,
                );

                expect(result).toEqual({
                    ok: true,
                    location: 'job-runtime',
                    runId: 'run_7',
                    result: { n: 9 },
                });
                expect(runtime.provider.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith({
                    pluginId: 'p',
                    operation: 'runSandboxSession',
                    args: { a: 1 },
                });
                expect(runtime.provider.getRunResult).toHaveBeenCalledTimes(3);
                expect(runtime.provider.getRunResult).toHaveBeenCalledWith('run_7');
            });

            it('forwards the worker’s own failure envelope', async () => {
                const runtime = makeRuntime([
                    {
                        status: 'completed',
                        output: {
                            ok: false,
                            error: { code: 'PLUGIN_NOT_REGISTERED', message: 'not bundled' },
                        },
                    },
                ]);

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, fast),
                ).resolves.toEqual({
                    ok: false,
                    location: 'job-runtime',
                    runId: 'run_7',
                    error: { code: 'PLUGIN_NOT_REGISTERED', message: 'not bundled' },
                });
            });

            it.each([
                ['failed', 'JOB_RUNTIME_FAILED'],
                ['cancelled', 'JOB_RUNTIME_CANCELLED'],
            ])('maps a %s run to %s with the runtime’s message', async (status, code) => {
                const runtime = makeRuntime([{ status, error: { message: 'worker OOM' } }]);

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, fast),
                ).resolves.toMatchObject({
                    ok: false,
                    runId: 'run_7',
                    error: { code, message: 'worker OOM' },
                });
            });

            it('refuses a completed run whose output is not the task envelope', async () => {
                const runtime = makeRuntime([{ status: 'completed', output: 'surprise' }]);

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, fast),
                ).resolves.toMatchObject({ ok: false, error: { code: 'JOB_RUNTIME_FAILED' } });
            });

            it('tolerates a few unreadable reads, then gives up on a run it cannot read', async () => {
                const runtime = makeRuntime(
                    Array.from({ length: 10 }, () => ({ status: 'unknown' })),
                );

                // JOB_RUNTIME_RUN_UNREADABLE, not JOB_RUNTIME_FAILED: the run's
                // fate is unknown — it may still be executing — and a caller
                // that re-dispatched on a "failed" code would run it twice.
                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, fast),
                ).resolves.toMatchObject({
                    ok: false,
                    runId: 'run_7',
                    error: {
                        code: 'JOB_RUNTIME_RUN_UNREADABLE',
                        message: expect.stringContaining('NOT cancelled'),
                    },
                });
                expect(runtime.provider.getRunResult).toHaveBeenCalledTimes(5);
            });

            it('stops waiting at the deadline WITHOUT cancelling the run, and says so with the run id', async () => {
                const runtime = makeRuntime([]); // running forever

                const result = await routerWith(runtime).dispatchLongRunning('p', 'op', undefined, {
                    pollIntervalMs: 1,
                    timeoutMs: 20,
                });

                expect(result).toMatchObject({
                    ok: false,
                    runId: 'run_7',
                    error: {
                        code: 'JOB_RUNTIME_WAIT_TIMEOUT',
                        message: expect.stringContaining('NOT cancelled'),
                    },
                });
                expect(runtime.provider.cancel).not.toHaveBeenCalled();
            });

            // Retitled (wave-2 re-review): was "stops waiting when the caller
            // aborts". Its signal is aborted BEFORE the call, so since the
            // pre-dispatch check it never dispatches or waits; the assertion
            // is unchanged. An abort that lands once the run exists is pinned
            // by "an abort during the dispatch keeps the run id…" below, and
            // by "an abort during a stalled read / between reads".
            it('answers JOB_RUNTIME_WAIT_ABORTED for a signal aborted before the call', async () => {
                const runtime = makeRuntime([]);
                const controller = new AbortController();
                controller.abort();

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, {
                        ...fast,
                        signal: controller.signal,
                    }),
                ).resolves.toMatchObject({
                    ok: false,
                    error: { code: 'JOB_RUNTIME_WAIT_ABORTED' },
                });
            });

            // Wave-2 review (tenant-routing, LOW): the signal was first read
            // AFTER the dispatch, so an already-aborted call still started a
            // run — with side effects — and then walked away from it.
            it('dispatches nothing when the signal is already aborted — no run is left behind', async () => {
                const runtime = makeRuntime([]);
                const controller = new AbortController();
                controller.abort();

                const result = await routerWith(runtime).dispatchLongRunning('p', 'op', undefined, {
                    ...fast,
                    signal: controller.signal,
                });

                expect(result).toMatchObject({
                    ok: false,
                    location: 'job-runtime',
                    error: {
                        code: 'JOB_RUNTIME_WAIT_ABORTED',
                        message: expect.stringContaining('nothing was dispatched'),
                    },
                });
                expect(result).not.toHaveProperty('runId');
                expect(runtime.provider.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
                expect(runtime.provider.getRunResult).not.toHaveBeenCalled();
            });

            // Wave-2 re-review (plugins-lows, LOW): no spec covered an abort
            // that lands WHILE the runtime is starting the run. The run then
            // exists, so the answer must carry its id — a caller that owns
            // the signal (the sandbox runner) cancels by that id; without it
            // the run is left running with nobody able to stop it.
            it('an abort during the dispatch keeps the run id — the run exists, and the router does not cancel it', async () => {
                const runtime = makeRuntime([]);
                const controller = new AbortController();
                runtime.provider.dispatchers.dispatchPluginOperation.mockImplementation(
                    async () => {
                        controller.abort();
                        return 'run_7';
                    },
                );

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, {
                        ...fast,
                        signal: controller.signal,
                    }),
                ).resolves.toEqual({
                    ok: false,
                    location: 'job-runtime',
                    runId: 'run_7',
                    error: {
                        code: 'JOB_RUNTIME_WAIT_ABORTED',
                        message: expect.stringContaining('not cancelled'),
                    },
                });
                expect(runtime.provider.dispatchers.dispatchPluginOperation).toHaveBeenCalledTimes(
                    1,
                );
                expect(runtime.provider.cancel).not.toHaveBeenCalled();
            });

            it('answers JOB_RUNTIME_UNAVAILABLE with no active runtime — and never falls back in-process', async () => {
                const router = routerWith(null, {}, { p: { exec: { op: jest.fn() } } });

                await expect(
                    router.dispatchLongRunning('p', 'op', undefined, fast),
                ).resolves.toMatchObject({
                    ok: false,
                    location: 'job-runtime',
                    error: { code: 'JOB_RUNTIME_UNAVAILABLE' },
                });
            });

            it('answers JOB_RUNTIME_DISPATCH_FAILED when the runtime accepts no run', async () => {
                const runtime = makeRuntime([], null);

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, fast),
                ).resolves.toMatchObject({
                    ok: false,
                    error: { code: 'JOB_RUNTIME_DISPATCH_FAILED' },
                });
                expect(runtime.provider.getRunResult).not.toHaveBeenCalled();
            });

            it('dispatch() with an explicit profile takes this path in bundled mode', async () => {
                const runtime = makeRuntime([
                    { status: 'completed', output: { ok: true, result: 'done' } },
                ]);

                await expect(
                    routerWith(runtime).dispatch(
                        'p',
                        'runSandboxSession',
                        {},
                        { profile: 'long-running', ...fast },
                    ),
                ).resolves.toMatchObject({ ok: true, location: 'job-runtime', result: 'done' });
            });
        });

        describe('startLongRunning + pollLongRunning — for callers that must not block', () => {
            it('starts without waiting and answers the run id', async () => {
                const runtime = makeRuntime();

                await expect(
                    routerWith(runtime).startLongRunning('p', 'op', { a: 1 }),
                ).resolves.toEqual({
                    ok: true,
                    location: 'job-runtime',
                    runId: 'run_7',
                });
                expect(runtime.provider.getRunResult).not.toHaveBeenCalled();
            });

            it('reads the run ONCE per poll: pending, then the result', async () => {
                const runtime = makeRuntime([
                    { status: 'running' },
                    { status: 'completed', output: { ok: true, result: 3 } },
                ]);
                const router = routerWith(runtime);

                await expect(router.pollLongRunning('run_7')).resolves.toEqual({
                    done: false,
                    runId: 'run_7',
                    status: 'running',
                });
                await expect(router.pollLongRunning('run_7')).resolves.toEqual({
                    done: true,
                    runId: 'run_7',
                    result: { ok: true, location: 'job-runtime', runId: 'run_7', result: 3 },
                });
                expect(runtime.provider.getRunResult).toHaveBeenCalledTimes(2);
            });

            it('answers JOB_RUNTIME_UNAVAILABLE from both with no active runtime', async () => {
                const router = routerWith(null);

                await expect(router.startLongRunning('p', 'op')).resolves.toMatchObject({
                    ok: false,
                    error: { code: 'JOB_RUNTIME_UNAVAILABLE' },
                });
                await expect(router.pollLongRunning('run_7')).resolves.toMatchObject({
                    done: true,
                    result: { ok: false, error: { code: 'JOB_RUNTIME_UNAVAILABLE' } },
                });
            });
        });

        /**
         * Review follow-ups (EW-693 T27): what `dispatchSync` may call, and a
         * plugin whose initialisation failed.
         */
        describe('dispatchSync — only DECLARED operations, and only on a plugin that loaded', () => {
            class Helpers {
                readonly ran: string[] = [];
                async onLoad() {}
                async onUnload() {}
                async search(args?: Record<string, unknown>) {
                    return { hits: 1, args };
                }
                /** `protected` on the real `BasePlugin`: erased at runtime. */
                protected emitEvent(name: string) {
                    this.ran.push(`emitEvent:${name}`);
                }
                /** Stands in for a CLI plugin's prompt runner (TS-private there). */
                protected async runPrompt(args?: Record<string, unknown>) {
                    this.ran.push('runPrompt');
                    return args;
                }
                /** A function-valued class field. */
                replaceFile = async () => {
                    this.ran.push('replaceFile');
                };
            }
            const declaresSearch = { id: 'p', operations: [{ name: 'search' }] } as never;

            it.each(['emitEvent', 'runPrompt', 'replaceFile'])(
                'refuses %s — the class has it, the manifest does not declare it — and runs nothing',
                async (op) => {
                    const real = new Helpers();
                    const router = routerWith(
                        null,
                        {},
                        { p: { manifest: declaresSearch, exec: real as never } },
                    );

                    await expect(
                        router.dispatchSync('p', op, { flags: ['--yolo'] }),
                    ).resolves.toMatchObject({
                        ok: false,
                        error: {
                            code: 'OPERATION_NOT_FOUND',
                            message: expect.stringContaining(`does not declare operation "${op}"`),
                        },
                    });
                    expect(real.ran).toEqual([]);
                },
            );

            it('calls a declared operation', async () => {
                const router = routerWith(
                    null,
                    {},
                    {
                        p: { manifest: declaresSearch, exec: new Helpers() as never },
                    },
                );

                await expect(router.dispatchSync('p', 'search', { q: 1 })).resolves.toEqual({
                    ok: true,
                    location: 'in-process',
                    result: { hits: 1, args: { q: 1 } },
                });
            });

            it('calls nothing on a plugin whose manifest declares no operations', async () => {
                const exec = { extract: jest.fn(async () => 'ran') };
                const router = routerWith(
                    null,
                    {},
                    { p: { manifest: { id: 'p' } as never, exec } },
                );

                await expect(router.dispatchSync('p', 'extract')).resolves.toMatchObject({
                    ok: false,
                    error: { code: 'OPERATION_NOT_FOUND' },
                });
                expect(exec.extract).not.toHaveBeenCalled();
            });

            it('answers PLUGIN_LOAD_FAILED — and runs nothing — when onLoad fails while the plugin materialises', async () => {
                const real = new Helpers();
                const search = jest.spyOn(real, 'search');
                // Like the real registry: `get` hands out the SAME entry, and
                // `updateState` mutates it in place. `callOnLoad` catches the
                // onLoad throw and records it there; `__materialize` resolves.
                const entry: Record<string, unknown> = {
                    manifest: declaresSearch,
                    state: 'loaded',
                };
                entry.plugin = {
                    __materialize: jest.fn(async () => {
                        entry.state = 'error';
                        entry.error = new Error('onLoad: required setting "apiKey" is missing');
                        return real;
                    }),
                };
                const router = new PluginExecutionRouterService({ distributionMode: 'bundled' }, {
                    get: jest.fn(() => entry),
                } as unknown as PluginRegistryService);

                await expect(router.dispatchSync('p', 'search')).resolves.toMatchObject({
                    ok: false,
                    location: 'in-process',
                    error: {
                        code: 'PLUGIN_LOAD_FAILED',
                        message: expect.stringContaining('required setting "apiKey" is missing'),
                    },
                });
                expect(search).not.toHaveBeenCalled();
            });

            /**
             * With the REAL lazy proxy. Its `__materialize` answers a caller that
             * arrives while another caller's first materialisation is still in
             * its onLoad hook at once — before onLoad settles, with the entry
             * still `loaded`. The router waits for the hook (`__whenLoaded`).
             */
            it('a caller arriving while another caller’s onLoad is still running waits for it — and runs nothing when it fails', async () => {
                const ran: string[] = [];
                const real = {
                    id: 'p',
                    async onLoad() {
                        await new Promise((resolve) => setTimeout(resolve, 50));
                        throw new Error('onLoad: required setting "apiKey" is missing');
                    },
                    async onUnload() {},
                    async search(args?: { from?: string }) {
                        ran.push(args?.from ?? '?');
                        return 'ran';
                    },
                };
                const entry: Record<string, unknown> = {
                    manifest: declaresSearch,
                    state: 'loaded',
                };
                // The bootstrap wiring: the hook calls onLoad THROUGH the proxy,
                // and `callOnLoad` records a throw as the entry's error state.
                const proxy = createLazyPluginProxy(
                    { id: 'p', operations: [{ name: 'search' }] } as never,
                    async () => real as never,
                    async () => {
                        try {
                            await (entry.plugin as { onLoad: () => Promise<void> }).onLoad();
                        } catch (err) {
                            entry.state = 'error';
                            entry.error = err;
                        }
                    },
                );
                entry.plugin = proxy;
                const router = new PluginExecutionRouterService({ distributionMode: 'bundled' }, {
                    get: jest.fn(() => entry),
                } as unknown as PluginRegistryService);

                // A facade-style call starts the first materialisation…
                const facadeCall = (
                    proxy as unknown as { search: (a: unknown) => Promise<unknown> }
                )
                    .search({ from: 'facade' })
                    .catch(() => undefined);
                // …and the router arrives while its onLoad is still running.
                await new Promise((resolve) => setTimeout(resolve, 20));
                const answer = await router.dispatchSync('p', 'search', { from: 'router' });
                await facadeCall;

                expect(answer).toMatchObject({
                    ok: false,
                    error: {
                        code: 'PLUGIN_LOAD_FAILED',
                        message: expect.stringContaining('required setting "apiKey" is missing'),
                    },
                });
                expect(ran).not.toContain('router');
            });

            it('answers PLUGIN_LOAD_FAILED for a plugin already in error state, without loading it', async () => {
                const materialize = jest.fn(async () => new Helpers());
                const router = routerWith(
                    null,
                    {},
                    {
                        p: {
                            manifest: declaresSearch,
                            state: 'error',
                            error: new Error('bad config'),
                            exec: { __materialize: materialize } as never,
                        } as never,
                    },
                );

                await expect(router.dispatchSync('p', 'search')).resolves.toMatchObject({
                    ok: false,
                    error: {
                        code: 'PLUGIN_LOAD_FAILED',
                        message: expect.stringContaining('bad config'),
                    },
                });
                expect(materialize).not.toHaveBeenCalled();
            });

            it('answers PLUGIN_LOAD_FAILED — not IN_PROCESS_THREW — when the plugin will not load', async () => {
                const router = routerWith(
                    null,
                    {},
                    {
                        p: {
                            manifest: declaresSearch,
                            exec: {
                                __materialize: jest.fn(async () =>
                                    Promise.reject(new Error('import failed')),
                                ),
                            } as never,
                        },
                    },
                );

                await expect(router.dispatchSync('p', 'search')).resolves.toMatchObject({
                    ok: false,
                    error: {
                        code: 'PLUGIN_LOAD_FAILED',
                        message: expect.stringContaining('import failed'),
                    },
                });
            });
        });

        describe('route — an operation’s declared executionProfile (FR-17)', () => {
            const plugins = {
                p: {
                    manifest: {
                        id: 'p',
                        executionProfile: 'long-running',
                        operations: [
                            { name: 'runSandboxSession', executionProfile: 'long-running' },
                            { name: 'listModels', executionProfile: 'sync' },
                            { name: 'plain' },
                        ],
                    } as never,
                },
                q: {
                    manifest: {
                        id: 'q',
                        operations: [
                            { name: 'runSandboxSession', executionProfile: 'long-running' },
                        ],
                    } as never,
                },
            };

            it('sends a declared long-running operation to the job runtime, even in bundled mode', () => {
                expect(routerWith(null, {}, plugins).route('q', 'runSandboxSession')).toEqual({
                    location: 'job-runtime',
                    reason: 'manifest:operations[runSandboxSession].executionProfile=long-running',
                });
            });

            it('an operation’s own profile beats the manifest-level one', () => {
                expect(routerWith(null, {}, plugins).route('p', 'listModels').location).toBe(
                    'in-process',
                );
            });

            it('an operation that declares no profile falls back to the manifest-level one', () => {
                expect(routerWith(null, {}, plugins).route('p', 'plain')).toEqual({
                    location: 'job-runtime',
                    reason: 'manifest:executionProfile=long-running',
                });
            });

            it('an explicit profile on the call still beats both', () => {
                expect(
                    routerWith(null, {}, plugins).route('q', 'runSandboxSession', {
                        profile: 'sync',
                    }).location,
                ).toBe('in-process');
            });
        });

        /**
         * Review follow-ups (EW-693 T27): the wait must end on time, on an
         * abort, and without piling listeners on the caller's signal — also
         * when the job runtime's API stalls.
         */
        describe('waiting on a run — a stalled API, an abort, bad options', () => {
            function stalledRuntime() {
                const runtime = makeRuntime();
                runtime.provider.getRunResult.mockImplementation(
                    () => new Promise(() => undefined),
                );
                return runtime;
            }

            it('a stalled read cannot hold the caller past its deadline', async () => {
                const runtime = stalledRuntime();
                const started = Date.now();

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, {
                        timeoutMs: 300,
                        pollIntervalMs: 250,
                    }),
                ).resolves.toMatchObject({
                    ok: false,
                    runId: 'run_7',
                    error: {
                        code: 'JOB_RUNTIME_WAIT_TIMEOUT',
                        message: expect.stringContaining('NOT cancelled'),
                    },
                });
                expect(Date.now() - started).toBeLessThan(5_000);
            });

            it('an abort during a stalled read ends the wait at once', async () => {
                const runtime = stalledRuntime();
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 50);
                const started = Date.now();

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, {
                        timeoutMs: 60_000,
                        signal: controller.signal,
                    }),
                ).resolves.toMatchObject({
                    ok: false,
                    runId: 'run_7',
                    error: { code: 'JOB_RUNTIME_WAIT_ABORTED' },
                });
                expect(Date.now() - started).toBeLessThan(5_000);
                expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
            });

            it('an abort between reads ends the wait at once', async () => {
                const runtime = makeRuntime([]); // running forever
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 100);
                const started = Date.now();

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, {
                        timeoutMs: 60_000,
                        pollIntervalMs: 5_000,
                        signal: controller.signal,
                    }),
                ).resolves.toMatchObject({
                    ok: false,
                    error: { code: 'JOB_RUNTIME_WAIT_ABORTED' },
                });
                expect(Date.now() - started).toBeLessThan(900);
            });

            it('leaves no abort listener on the caller’s signal once the wait is over', async () => {
                const runtime = makeRuntime([
                    { status: 'queued' },
                    { status: 'running' },
                    { status: 'completed', output: { ok: true, result: 1 } },
                ]);
                const controller = new AbortController();

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, {
                        pollIntervalMs: 250,
                        signal: controller.signal,
                    }),
                ).resolves.toMatchObject({ ok: true, result: 1 });
                expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
            });

            it.each([
                ['NaN', Number.NaN],
                ['0', 0],
            ])(
                'a pollIntervalMs of %s is not a hot loop, and the wait still ends',
                async (_label, pollIntervalMs) => {
                    const runtime = makeRuntime([]); // running forever

                    await expect(
                        routerWith(runtime).dispatchLongRunning('p', 'op', undefined, {
                            timeoutMs: 700,
                            pollIntervalMs,
                        }),
                    ).resolves.toMatchObject({
                        ok: false,
                        error: { code: 'JOB_RUNTIME_WAIT_TIMEOUT' },
                    });
                    // At most one read per 250 ms (the floor) in a 700 ms wait, plus
                    // the final read made at the deadline.
                    expect(runtime.provider.getRunResult.mock.calls.length).toBeLessThanOrEqual(5);
                },
            );

            /**
             * A completed run whose output could not be read (an offloaded
             * output whose download failed) is DONE: read it again a few times,
             * then say so — never "failed", never "may still be running".
             */
            it('a completed run whose output stays unreadable ends JOB_RUNTIME_OUTPUT_UNREADABLE — completed, do not re-dispatch', async () => {
                const runtime = makeRuntime(
                    Array.from({ length: 10 }, () => ({
                        status: 'completed',
                        outputUnavailable: true,
                    })),
                );

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, fast),
                ).resolves.toMatchObject({
                    ok: false,
                    runId: 'run_7',
                    error: {
                        code: 'JOB_RUNTIME_OUTPUT_UNREADABLE',
                        message: expect.stringContaining('do NOT dispatch it again'),
                    },
                });
                expect(runtime.provider.getRunResult).toHaveBeenCalledTimes(5);
            });

            it('a completed run whose output becomes readable on a later read answers that output', async () => {
                const runtime = makeRuntime([
                    { status: 'completed', outputUnavailable: true },
                    { status: 'completed', output: { ok: true, result: 'late' } },
                ]);

                await expect(
                    routerWith(runtime).dispatchLongRunning('p', 'op', undefined, fast),
                ).resolves.toMatchObject({ ok: true, runId: 'run_7', result: 'late' });
            });

            it('pollLongRunning answers such a run as done — JOB_RUNTIME_OUTPUT_UNREADABLE, not a failure', async () => {
                const runtime = makeRuntime([{ status: 'completed', outputUnavailable: true }]);

                await expect(routerWith(runtime).pollLongRunning('run_7')).resolves.toMatchObject({
                    done: true,
                    runId: 'run_7',
                    result: { ok: false, error: { code: 'JOB_RUNTIME_OUTPUT_UNREADABLE' } },
                });
            });

            describe('with fake timers', () => {
                beforeEach(() => jest.useFakeTimers());
                afterEach(() => jest.useRealTimers());

                /**
                 * The wait used to give up as soon as the next full backoff step
                 * would pass the deadline — up to a whole interval early, for a
                 * run that finished inside the budget.
                 */
                it.each([
                    ['default interval', 5_000, undefined, 4_200],
                    ['60 s interval', 90_000, 60_000, 80_000],
                ])(
                    'makes a final read AT the deadline (%s) — a run that finished inside the budget is answered',
                    async (_label, timeoutMs, pollIntervalMs, completesAt) => {
                        const started = Date.now();
                        const runtime = makeRuntime();
                        runtime.provider.getRunResult.mockImplementation(async () =>
                            Date.now() - started >= completesAt
                                ? { status: 'completed', output: { ok: true, result: 'in time' } }
                                : { status: 'running' },
                        );
                        let settled: unknown;
                        void routerWith(runtime)
                            .dispatchLongRunning('p', 'op', undefined, {
                                timeoutMs,
                                pollIntervalMs,
                            })
                            .then((result) => (settled = result));

                        await jest.advanceTimersByTimeAsync(timeoutMs + 2_000);
                        expect(settled).toMatchObject({ ok: true, result: 'in time' });
                    },
                );

                it('waits the run’s whole lifetime by default — queue TTL + maxDuration + boot, 80 minutes', async () => {
                    expect(PLUGIN_OPERATION_DEFAULT_WAIT_MS).toBe(80 * 60 * 1000);
                    const runtime = makeRuntime([]); // running forever
                    let settled: unknown;
                    void routerWith(runtime)
                        .dispatchLongRunning('p', 'op')
                        .then((result) => (settled = result));

                    await jest.advanceTimersByTimeAsync(79 * 60 * 1000);
                    expect(settled).toBeUndefined();

                    await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
                    expect(settled).toMatchObject({
                        ok: false,
                        error: { code: 'JOB_RUNTIME_WAIT_TIMEOUT' },
                    });
                });

                it('a NaN timeoutMs means the default wait — not a wait that never ends', async () => {
                    const runtime = makeRuntime([]); // running forever
                    let settled: unknown;
                    void routerWith(runtime)
                        .dispatchLongRunning('p', 'op', undefined, { timeoutMs: Number.NaN })
                        .then((result) => (settled = result));

                    await jest.advanceTimersByTimeAsync(PLUGIN_OPERATION_DEFAULT_WAIT_MS + 60_000);
                    expect(settled).toMatchObject({
                        ok: false,
                        error: {
                            code: 'JOB_RUNTIME_WAIT_TIMEOUT',
                            message: expect.stringContaining(
                                String(PLUGIN_OPERATION_DEFAULT_WAIT_MS),
                            ),
                        },
                    });
                });

                it('pollLongRunning answers a stalled read as not-done within 20 s — under the 60 s ingress limit', async () => {
                    const runtime = stalledRuntime();
                    let settled: unknown;
                    void routerWith(runtime)
                        .pollLongRunning('run_7')
                        .then((result) => (settled = result));

                    await jest.advanceTimersByTimeAsync(20_000);
                    expect(settled).toEqual({ done: false, runId: 'run_7', status: 'unknown' });
                });
            });
        });

        /**
         * Every other router spec passes the registry to the constructor. This
         * one lets Nest inject it: `@Optional() @Inject(JOB_RUNTIME_PROVIDER_REGISTRY)`,
         * provided by a @Global module the router's own module does not import
         * — the shape of the API graph (the tasks package's @Global TriggerModule).
         */
        describe('Nest wiring of the job-runtime registry', () => {
            function routerHost() {
                class RouterHost {}
                Module({
                    providers: [
                        PluginExecutionRouterService,
                        {
                            provide: PLUGINS_MODULE_OPTIONS,
                            useValue: { distributionMode: 'bundled' },
                        },
                        { provide: PluginRegistryService, useValue: makeRegistry({}) },
                    ],
                    exports: [PluginExecutionRouterService],
                })(RouterHost);
                return RouterHost;
            }

            it('injects the registry a @Global module exports, and dispatches through it', async () => {
                const runtime = makeRuntime();
                class RuntimeHost {}
                Module({
                    providers: [
                        { provide: JOB_RUNTIME_PROVIDER_REGISTRY, useValue: runtime.registry },
                    ],
                    exports: [JOB_RUNTIME_PROVIDER_REGISTRY],
                })(RuntimeHost);
                Global()(RuntimeHost);

                const moduleRef = await Test.createTestingModule({
                    imports: [RuntimeHost, routerHost()],
                }).compile();

                await expect(
                    moduleRef.get(PluginExecutionRouterService).startLongRunning('p', 'op'),
                ).resolves.toEqual({ ok: true, location: 'job-runtime', runId: 'run_7' });
                expect(runtime.provider.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith({
                    pluginId: 'p',
                    operation: 'op',
                    args: undefined,
                });
                await moduleRef.close();
            });

            it('boots without a registry, and answers JOB_RUNTIME_UNAVAILABLE', async () => {
                const moduleRef = await Test.createTestingModule({
                    imports: [routerHost()],
                }).compile();

                await expect(
                    moduleRef.get(PluginExecutionRouterService).startLongRunning('p', 'op'),
                ).resolves.toMatchObject({ ok: false, error: { code: 'JOB_RUNTIME_UNAVAILABLE' } });
                await moduleRef.close();
            });
        });

        /**
         * T26 / EW-742 P3 — a caller that knows the Work's tenant passes
         * `tenantId`, and the long-running path then goes through
         * `TenantAwareRuntimeResolver.resolve(tenantId)`: the tenant's bound view
         * of the runtime (BYO project, tenant stamp), or the platform provider
         * when the tenant has no overlay. The resolver lives in a NON-global API
         * module (`TenantJobRuntimeModule`), so the router looks it up through
         * `ModuleRef` (`getOptionalProvider`) — a constructor injection would
         * always be `undefined` from the @Global plugins module. FR-5: the
         * payload carries the `(providerId, credentialVersion)` the stamper
         * reports at enqueue time.
         */
        describe('tenant-aware routing (TenantAwareRuntimeResolver)', () => {
            function tenantView(reads: Read[] = [], runId: string | null = 'run_t1') {
                const queue = [...reads];
                return {
                    runtimeId: 'trigger',
                    dispatchers: { dispatchPluginOperation: jest.fn(async () => runId) },
                    getRunResult: jest.fn(async () => queue.shift() ?? { status: 'running' }),
                    cancel: jest.fn(async () => true),
                };
            }

            /** A ModuleRef double that behaves like Nest's: an absent token THROWS. */
            function fakeModuleRef(bound: Map<unknown, unknown>) {
                return {
                    get: jest.fn((token: unknown) => {
                        if (bound.has(token)) return bound.get(token);
                        throw new UnknownElementException(String(token));
                    }),
                };
            }

            function tenantRouter(
                runtime: ReturnType<typeof makeRuntime> | null,
                bound: { resolver?: unknown; stamper?: unknown } = {},
            ) {
                const map = new Map<unknown, unknown>();
                if (bound.resolver) map.set(TenantAwareRuntimeResolver, bound.resolver);
                if (bound.stamper) map.set(RuntimeBindingStamperService, bound.stamper);
                return new PluginExecutionRouterService(
                    { distributionMode: 'bundled' },
                    makeRegistry({}),
                    undefined,
                    (runtime?.registry ?? null) as never,
                    fakeModuleRef(map) as never,
                );
            }

            it('without a tenantId, uses the platform registry and never looks the tenant up', async () => {
                const runtime = makeRuntime();
                const resolver = { resolve: jest.fn(async () => tenantView()) };
                const stamper = {
                    stamp: jest.fn(async () => ({ providerId: 'trigger', credentialVersion: 3 })),
                };
                const router = tenantRouter(runtime, { resolver, stamper });

                await expect(router.startLongRunning('p', 'op', { a: 1 })).resolves.toEqual({
                    ok: true,
                    location: 'job-runtime',
                    runId: 'run_7',
                });
                // Byte-identical to the pre-tenancy payload: no tenant keys at all.
                expect(runtime.provider.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith({
                    pluginId: 'p',
                    operation: 'op',
                    args: { a: 1 },
                });
                expect(
                    Object.keys(
                        (
                            runtime.provider.dispatchers.dispatchPluginOperation.mock
                                .calls[0] as unknown[]
                        )[0] as object,
                    ),
                ).toEqual(['pluginId', 'operation', 'args']);
                expect(resolver.resolve).not.toHaveBeenCalled();
                expect(stamper.stamp).not.toHaveBeenCalled();
            });

            it('startLongRunning with a tenantId dispatches through the tenant’s view, not the platform provider', async () => {
                const runtime = makeRuntime();
                const view = tenantView();
                const resolver = { resolve: jest.fn(async () => view) };
                const router = tenantRouter(runtime, { resolver });

                await expect(
                    router.startLongRunning('p', 'op', { a: 1 }, { tenantId: 't1' }),
                ).resolves.toEqual({ ok: true, location: 'job-runtime', runId: 'run_t1' });
                expect(resolver.resolve).toHaveBeenCalledWith('t1');
                expect(view.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith({
                    pluginId: 'p',
                    operation: 'op',
                    args: { a: 1 },
                    tenantId: 't1',
                });
                expect(runtime.provider.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
            });

            it('dispatchLongRunning with a tenantId waits on the SAME tenant view it dispatched through', async () => {
                const runtime = makeRuntime();
                const view = tenantView([
                    { status: 'running' },
                    { status: 'completed', output: { ok: true, result: 'tenant' } },
                ]);
                const router = tenantRouter(runtime, {
                    resolver: { resolve: jest.fn(async () => view) },
                });

                await expect(
                    router.dispatchLongRunning('p', 'op', undefined, { ...fast, tenantId: 't1' }),
                ).resolves.toEqual({
                    ok: true,
                    location: 'job-runtime',
                    runId: 'run_t1',
                    result: 'tenant',
                });
                expect(view.dispatchers.dispatchPluginOperation).toHaveBeenCalledTimes(1);
                expect(view.getRunResult).toHaveBeenCalledWith('run_t1');
                expect(runtime.provider.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
                expect(runtime.provider.getRunResult).not.toHaveBeenCalled();
            });

            it('dispatch() with a long-running profile carries the tenantId through', async () => {
                const runtime = makeRuntime();
                const view = tenantView([{ status: 'completed', output: { ok: true, result: 1 } }]);
                const router = tenantRouter(runtime, {
                    resolver: { resolve: jest.fn(async () => view) },
                });

                await expect(
                    router.dispatch(
                        'p',
                        'op',
                        {},
                        { profile: 'long-running', ...fast, tenantId: 't1' },
                    ),
                ).resolves.toMatchObject({ ok: true, runId: 'run_t1', result: 1 });
                expect(runtime.provider.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
            });

            it('pollLongRunning with a tenantId reads the tenant’s view', async () => {
                const runtime = makeRuntime();
                const view = tenantView([{ status: 'completed', output: { ok: true, result: 5 } }]);
                const resolver = { resolve: jest.fn(async () => view) };
                const router = tenantRouter(runtime, { resolver });

                await expect(router.pollLongRunning('run_t1', { tenantId: 't1' })).resolves.toEqual(
                    {
                        done: true,
                        runId: 'run_t1',
                        result: { ok: true, location: 'job-runtime', runId: 'run_t1', result: 5 },
                    },
                );
                expect(resolver.resolve).toHaveBeenCalledWith('t1');
                expect(view.getRunResult).toHaveBeenCalledWith('run_t1');
                expect(runtime.provider.getRunResult).not.toHaveBeenCalled();
            });

            it('cancelLongRunning with a tenantId cancels through the tenant’s view, not the platform provider (T26)', async () => {
                const runtime = makeRuntime();
                const view = tenantView();
                const resolver = { resolve: jest.fn(async () => view) };
                const router = tenantRouter(runtime, { resolver });

                await expect(
                    router.cancelLongRunning('run_t1', { tenantId: 't1' }),
                ).resolves.toEqual({ ok: true, runId: 'run_t1', cancelled: true });
                expect(resolver.resolve).toHaveBeenCalledWith('t1');
                expect(view.cancel).toHaveBeenCalledWith('run_t1');
                expect(runtime.provider.cancel).not.toHaveBeenCalled();
            });

            it('a resolver that throws falls back to the platform provider', async () => {
                const runtime = makeRuntime([{ status: 'running' }]);
                const router = tenantRouter(runtime, {
                    resolver: {
                        resolve: jest.fn(async () => {
                            throw new Error('overlay table missing');
                        }),
                    },
                });

                await expect(
                    router.startLongRunning('p', 'op', undefined, { tenantId: 't1' }),
                ).resolves.toEqual({ ok: true, location: 'job-runtime', runId: 'run_7' });
                await expect(router.pollLongRunning('run_7', { tenantId: 't1' })).resolves.toEqual({
                    done: false,
                    runId: 'run_7',
                    status: 'running',
                });
                expect(runtime.provider.dispatchers.dispatchPluginOperation).toHaveBeenCalledTimes(
                    1,
                );
                expect(runtime.provider.getRunResult).toHaveBeenCalledWith('run_7');
            });

            it('a resolver that answers null means no runtime — JOB_RUNTIME_UNAVAILABLE, never the platform provider', async () => {
                const runtime = makeRuntime();
                const router = tenantRouter(runtime, {
                    resolver: { resolve: jest.fn(async () => null) },
                });

                await expect(
                    router.startLongRunning('p', 'op', undefined, { tenantId: 't1' }),
                ).resolves.toMatchObject({ ok: false, error: { code: 'JOB_RUNTIME_UNAVAILABLE' } });
                await expect(
                    router.dispatchLongRunning('p', 'op', undefined, { ...fast, tenantId: 't1' }),
                ).resolves.toMatchObject({ ok: false, error: { code: 'JOB_RUNTIME_UNAVAILABLE' } });
                await expect(
                    router.pollLongRunning('run_7', { tenantId: 't1' }),
                ).resolves.toMatchObject({
                    done: true,
                    result: { ok: false, error: { code: 'JOB_RUNTIME_UNAVAILABLE' } },
                });
                expect(runtime.provider.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
                expect(runtime.provider.getRunResult).not.toHaveBeenCalled();
            });

            it('with no resolver bound (a narrower graph), a tenant call uses the platform provider', async () => {
                const runtime = makeRuntime();
                const router = tenantRouter(runtime);

                await expect(
                    router.startLongRunning('p', 'op', undefined, { tenantId: 't1' }),
                ).resolves.toEqual({ ok: true, location: 'job-runtime', runId: 'run_7' });
            });

            it('stamps the tenant’s (providerId, credentialVersion) onto the payload when the stamper is bound (FR-5)', async () => {
                const view = tenantView();
                const stamper = {
                    stamp: jest.fn(async () => ({ providerId: 'trigger', credentialVersion: 4 })),
                };
                const router = tenantRouter(makeRuntime(), {
                    resolver: { resolve: jest.fn(async () => view) },
                    stamper,
                });

                await router.startLongRunning('p', 'op', { a: 1 }, { tenantId: 't1' });

                expect(stamper.stamp).toHaveBeenCalledWith('t1');
                expect(view.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith({
                    pluginId: 'p',
                    operation: 'op',
                    args: { a: 1 },
                    tenantId: 't1',
                    providerId: 'trigger',
                    credentialVersion: 4,
                });
            });

            it('without a stamper, the payload carries the tenantId but no stamp fields', async () => {
                const view = tenantView();
                const router = tenantRouter(makeRuntime(), {
                    resolver: { resolve: jest.fn(async () => view) },
                });

                await router.startLongRunning('p', 'op', undefined, { tenantId: 't1' });

                const payload = (
                    view.dispatchers.dispatchPluginOperation.mock.calls[0] as unknown[]
                )[0];
                expect(payload).toEqual({
                    pluginId: 'p',
                    operation: 'op',
                    args: undefined,
                    tenantId: 't1',
                });
                expect(payload).not.toHaveProperty('providerId');
                expect(payload).not.toHaveProperty('credentialVersion');
            });

            it('a stamper that throws fails open to null/null — the enqueue still happens', async () => {
                const view = tenantView();
                const router = tenantRouter(makeRuntime(), {
                    resolver: { resolve: jest.fn(async () => view) },
                    stamper: {
                        stamp: jest.fn(async () => {
                            throw new Error('db down');
                        }),
                    },
                });

                await expect(
                    router.startLongRunning('p', 'op', undefined, { tenantId: 't1' }),
                ).resolves.toEqual({ ok: true, location: 'job-runtime', runId: 'run_t1' });
                expect(view.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith(
                    expect.objectContaining({
                        tenantId: 't1',
                        providerId: null,
                        credentialVersion: null,
                    }),
                );
            });

            it('dispatchLongRunning dispatches nothing when the signal aborts during the tenant lookup', async () => {
                const runtime = makeRuntime();
                const view = tenantView();
                const controller = new AbortController();
                const router = tenantRouter(runtime, {
                    resolver: {
                        resolve: jest.fn(async () => {
                            controller.abort();
                            return view;
                        }),
                    },
                });

                const result = await router.dispatchLongRunning('p', 'op', undefined, {
                    ...fast,
                    tenantId: 't1',
                    signal: controller.signal,
                });

                expect(result).toMatchObject({
                    ok: false,
                    error: { code: 'JOB_RUNTIME_WAIT_ABORTED' },
                });
                expect(result).not.toHaveProperty('runId');
                expect(view.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
                expect(runtime.provider.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
            });

            describe('with fake timers', () => {
                beforeEach(() => jest.useFakeTimers());
                afterEach(() => jest.useRealTimers());

                it('a tenant lookup that stalls still answers the poll as not-done within 20 s', async () => {
                    const runtime = makeRuntime();
                    const router = tenantRouter(runtime, {
                        resolver: { resolve: jest.fn(() => new Promise(() => {})) },
                    });
                    let settled: unknown;
                    void router
                        .pollLongRunning('run_7', { tenantId: 't1' })
                        .then((result) => (settled = result));

                    await jest.advanceTimersByTimeAsync(20_000);
                    expect(settled).toEqual({ done: false, runId: 'run_7', status: 'unknown' });
                    expect(runtime.provider.getRunResult).not.toHaveBeenCalled();
                });

                // Wave-2 review (tenant-routing, LOW): only the poll bounded the
                // tenant lookup; startLongRunning — the HTTP caller's half —
                // waited on the resolver and the stamper with no limit.
                it('a tenant lookup that stalls fails the start within 20 s — and dispatches nothing', async () => {
                    const runtime = makeRuntime();
                    const router = tenantRouter(runtime, {
                        resolver: { resolve: jest.fn(() => new Promise(() => {})) },
                    });
                    let settled: unknown;
                    void router
                        .startLongRunning('p', 'op', undefined, { tenantId: 't1' })
                        .then((result) => (settled = result));

                    await jest.advanceTimersByTimeAsync(20_000);
                    expect(settled).toEqual({
                        ok: false,
                        location: 'job-runtime',
                        error: {
                            code: 'JOB_RUNTIME_DISPATCH_FAILED',
                            message: expect.stringContaining('nothing was dispatched'),
                        },
                    });
                    // Not the platform provider either: a BYO tenant's run would
                    // land in the wrong project and read 'unknown' on every poll.
                    expect(
                        runtime.provider.dispatchers.dispatchPluginOperation,
                    ).not.toHaveBeenCalled();
                });

                it('a stamp that stalls still starts the run within 20 s — unstamped, like a stamp that throws', async () => {
                    const runtime = makeRuntime();
                    const view = tenantView();
                    const router = tenantRouter(runtime, {
                        resolver: { resolve: jest.fn(async () => view) },
                        stamper: { stamp: jest.fn(() => new Promise(() => {})) },
                    });
                    let settled: unknown;
                    void router
                        .startLongRunning('p', 'op', undefined, { tenantId: 't1' })
                        .then((result) => (settled = result));

                    await jest.advanceTimersByTimeAsync(20_000);
                    expect(settled).toEqual({ ok: true, location: 'job-runtime', runId: 'run_t1' });
                    expect(view.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith(
                        expect.objectContaining({
                            tenantId: 't1',
                            providerId: null,
                            credentialVersion: null,
                        }),
                    );
                });
            });

            /**
             * The real API shape: the router's module does not import the
             * resolver's module, and the resolver's module is NOT global.
             */
            describe('Nest wiring', () => {
                function hosts(resolver: unknown, stamper?: unknown) {
                    const runtime = makeRuntime();
                    class RuntimeHost {}
                    Module({
                        providers: [
                            { provide: JOB_RUNTIME_PROVIDER_REGISTRY, useValue: runtime.registry },
                        ],
                        exports: [JOB_RUNTIME_PROVIDER_REGISTRY],
                    })(RuntimeHost);
                    Global()(RuntimeHost);

                    class TenantHost {}
                    Module({
                        providers: [
                            { provide: TenantAwareRuntimeResolver, useValue: resolver },
                            ...(stamper
                                ? [{ provide: RuntimeBindingStamperService, useValue: stamper }]
                                : []),
                        ],
                        exports: [TenantAwareRuntimeResolver],
                    })(TenantHost);

                    class RouterHost {}
                    Module({
                        providers: [
                            PluginExecutionRouterService,
                            {
                                provide: PLUGINS_MODULE_OPTIONS,
                                useValue: { distributionMode: 'bundled' },
                            },
                            { provide: PluginRegistryService, useValue: makeRegistry({}) },
                        ],
                        exports: [PluginExecutionRouterService],
                    })(RouterHost);
                    return { runtime, modules: [RuntimeHost, TenantHost, RouterHost] };
                }

                it('finds the resolver in a sibling, non-global module and routes the tenant through it', async () => {
                    const view = tenantView();
                    const stamper = {
                        stamp: jest.fn(async () => ({
                            providerId: 'trigger',
                            credentialVersion: 2,
                        })),
                    };
                    const { runtime, modules } = hosts(
                        { resolve: jest.fn(async () => view) },
                        stamper,
                    );
                    const moduleRef = await Test.createTestingModule({
                        imports: modules,
                    }).compile();

                    await expect(
                        moduleRef
                            .get(PluginExecutionRouterService)
                            .startLongRunning('p', 'op', undefined, { tenantId: 't1' }),
                    ).resolves.toEqual({ ok: true, location: 'job-runtime', runId: 'run_t1' });
                    expect(view.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith({
                        pluginId: 'p',
                        operation: 'op',
                        args: undefined,
                        tenantId: 't1',
                        providerId: 'trigger',
                        credentialVersion: 2,
                    });
                    expect(
                        runtime.provider.dispatchers.dispatchPluginOperation,
                    ).not.toHaveBeenCalled();
                    await moduleRef.close();
                });

                it('boots without the tenant module, and a tenant call uses the platform provider', async () => {
                    const { runtime, modules } = hosts({ resolve: jest.fn() });
                    const moduleRef = await Test.createTestingModule({
                        imports: [modules[0], modules[2]],
                    }).compile();

                    await expect(
                        moduleRef
                            .get(PluginExecutionRouterService)
                            .startLongRunning('p', 'op', undefined, { tenantId: 't1' }),
                    ).resolves.toEqual({ ok: true, location: 'job-runtime', runId: 'run_7' });
                    expect(
                        runtime.provider.dispatchers.dispatchPluginOperation,
                    ).toHaveBeenCalledWith({
                        pluginId: 'p',
                        operation: 'op',
                        args: undefined,
                        tenantId: 't1',
                    });
                    await moduleRef.close();
                });
            });
        });

        /**
         * T26 — the first long-running caller (the managed-agent sandbox runner)
         * must be able to stop a session it started. The job runtime cannot
         * carry an `AbortSignal`, so the router cancels the RUN, through the
         * same provider view the run was started through.
         */
        describe('cancelLongRunning (T26)', () => {
            it('asks the active runtime to cancel the run, and says it was accepted', async () => {
                const runtime = makeRuntime();

                await expect(routerWith(runtime).cancelLongRunning('run_7')).resolves.toEqual({
                    ok: true,
                    runId: 'run_7',
                    cancelled: true,
                });
                expect(runtime.provider.cancel).toHaveBeenCalledTimes(1);
                expect(runtime.provider.cancel).toHaveBeenCalledWith('run_7');
                expect(runtime.provider.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
            });

            it('answers cancelled: false when the runtime does not know the run or it already ended', async () => {
                const runtime = makeRuntime();
                runtime.provider.cancel.mockResolvedValueOnce(false);

                await expect(routerWith(runtime).cancelLongRunning('run_7')).resolves.toEqual({
                    ok: true,
                    runId: 'run_7',
                    cancelled: false,
                });
            });

            it('answers JOB_RUNTIME_UNAVAILABLE with no active runtime', async () => {
                await expect(routerWith(null).cancelLongRunning('run_7')).resolves.toMatchObject({
                    ok: false,
                    runId: 'run_7',
                    error: { code: 'JOB_RUNTIME_UNAVAILABLE' },
                });
            });

            it('answers JOB_RUNTIME_CANCEL_FAILED — and never throws — when the runtime’s cancel throws', async () => {
                const runtime = makeRuntime();
                runtime.provider.cancel.mockRejectedValueOnce(new Error('503 from the runtime'));

                await expect(routerWith(runtime).cancelLongRunning('run_7')).resolves.toEqual({
                    ok: false,
                    runId: 'run_7',
                    error: {
                        code: 'JOB_RUNTIME_CANCEL_FAILED',
                        message: expect.stringContaining('503 from the runtime'),
                    },
                });
            });

            it('refuses an empty run id without calling the runtime', async () => {
                const runtime = makeRuntime();

                await expect(routerWith(runtime).cancelLongRunning('')).resolves.toMatchObject({
                    ok: false,
                    error: { code: 'JOB_RUNTIME_CANCEL_FAILED' },
                });
                expect(runtime.provider.cancel).not.toHaveBeenCalled();
            });

            describe('with fake timers', () => {
                beforeEach(() => jest.useFakeTimers());
                afterEach(() => jest.useRealTimers());

                it('a cancel that stalls is answered within 20 s — under the 60 s ingress limit', async () => {
                    const runtime = makeRuntime();
                    runtime.provider.cancel.mockImplementationOnce(() => new Promise(() => {}));
                    let settled: unknown;
                    void routerWith(runtime)
                        .cancelLongRunning('run_7')
                        .then((result) => (settled = result));

                    await jest.advanceTimersByTimeAsync(19_999);
                    expect(settled).toBeUndefined();
                    await jest.advanceTimersByTimeAsync(1);
                    expect(settled).toMatchObject({
                        ok: false,
                        runId: 'run_7',
                        error: { code: 'JOB_RUNTIME_CANCEL_FAILED' },
                    });
                });
            });
        });

        /**
         * T26 — in-process, a caller can hand the operation an `AbortSignal`
         * (`runSandboxSession(input, signal?)` stops its session on it). Without
         * the option the operation still receives exactly ONE argument, as the
         * worker task gives it.
         */
        describe('dispatchSync — an AbortSignal for the operation (T26)', () => {
            const DECLARES_RUN = { id: 'p', operations: [{ name: 'run' }] } as never;

            it('passes the caller’s signal as the operation’s second argument', async () => {
                const run = jest.fn(async (...received: unknown[]) => received.length);
                const router = routerWith(
                    null,
                    {},
                    { p: { manifest: DECLARES_RUN, exec: { run } } },
                );
                const controller = new AbortController();

                await expect(
                    router.dispatchSync('p', 'run', { a: 1 }, { signal: controller.signal }),
                ).resolves.toEqual({ ok: true, location: 'in-process', result: 2 });
                expect(run).toHaveBeenCalledWith({ a: 1 }, controller.signal);
            });

            it('without a signal, the operation receives exactly one argument', async () => {
                const run = jest.fn(async (...received: unknown[]) => received.length);
                const router = routerWith(
                    null,
                    {},
                    { p: { manifest: DECLARES_RUN, exec: { run } } },
                );

                await expect(router.dispatchSync('p', 'run', { a: 1 })).resolves.toEqual({
                    ok: true,
                    location: 'in-process',
                    result: 1,
                });
                await expect(router.dispatchSync('p', 'run', { a: 1 }, {})).resolves.toEqual({
                    ok: true,
                    location: 'in-process',
                    result: 1,
                });
            });

            it('dispatch() does not hand its wait signal to an in-process operation', async () => {
                const run = jest.fn(async (...received: unknown[]) => received.length);
                const router = routerWith(
                    null,
                    {},
                    { p: { manifest: DECLARES_RUN, exec: { run } } },
                );

                await expect(
                    router.dispatch('p', 'run', { a: 1 }, { signal: new AbortController().signal }),
                ).resolves.toEqual({ ok: true, location: 'in-process', result: 1 });
            });
        });

        /**
         * The registry hands out lazy proxies whose `get` answers a function for
         * ANY name, so `typeof plugin[op] === 'function'` was always true on the
         * in-process path as well.
         */
        describe('dispatchSync on a lazy proxy', () => {
            const DECLARES_SEARCH = { id: 'p', operations: [{ name: 'search' }] } as never;

            class Real {
                async onLoad() {}
                async onUnload() {}
                async search(args?: Record<string, unknown>) {
                    return { hits: 1, args };
                }
            }
            function lazy(real: object) {
                const stub = { __materialize: jest.fn(async () => real) };
                return new Proxy(stub, {
                    get(target, prop) {
                        if (prop in target) return Reflect.get(target, prop);
                        return () => {
                            throw new TypeError(`forwarded ${String(prop)}`);
                        };
                    },
                });
            }

            it('calls the operation on the materialised plugin', async () => {
                const router = routerWith(
                    null,
                    {},
                    {
                        p: { manifest: DECLARES_SEARCH, exec: lazy(new Real()) as never },
                    },
                );

                await expect(router.dispatchSync('p', 'search', { q: 'x' })).resolves.toEqual({
                    ok: true,
                    location: 'in-process',
                    result: { hits: 1, args: { q: 'x' } },
                });
            });

            it.each(['teleport', 'constructor', '__materialize', 'onUnload', 'toString'])(
                'answers OPERATION_NOT_FOUND for %s',
                async (op) => {
                    const router = routerWith(
                        null,
                        {},
                        {
                            p: { manifest: DECLARES_SEARCH, exec: lazy(new Real()) as never },
                        },
                    );

                    await expect(router.dispatchSync('p', op)).resolves.toMatchObject({
                        ok: false,
                        error: { code: 'OPERATION_NOT_FOUND' },
                    });
                },
            );
        });
    });
});
