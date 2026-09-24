import {
    PluginExecutionRouterService,
    classifyOperation,
    type TriggerDispatcher,
    type PluginExecutionTaskOutcome,
} from '../services/plugin-execution-router.service';
import { getEventListeners } from 'events';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PluginRegistryService, type RegisteredPlugin } from '../services/plugin-registry.service';
import type { PluginInstallerService } from '../services/plugin-installer.service';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import { JOB_RUNTIME_PROVIDER_REGISTRY } from '../../tasks/job-runtime.providers';
import { PLUGIN_OPERATION_DEFAULT_WAIT_MS } from '../../tasks/plugin-operation-dispatch';

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
        type Read = { status: string; output?: unknown; error?: { message: string } | null };

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

            it('stops waiting when the caller aborts', async () => {
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
                    // At most one read per 250 ms (the floor) in a 700 ms wait.
                    expect(runtime.provider.getRunResult.mock.calls.length).toBeLessThanOrEqual(4);
                },
            );

            describe('with fake timers', () => {
                beforeEach(() => jest.useFakeTimers());
                afterEach(() => jest.useRealTimers());

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
