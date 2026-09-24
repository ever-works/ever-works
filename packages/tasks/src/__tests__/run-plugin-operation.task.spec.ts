import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * EW-693 / T27 — **`run-plugin-operation`**, the long-running plugin call, until
 * now without a spec.
 *
 * The task promises its router a DETERMINISTIC `{ ok, error }` envelope and never
 * a throw (its own header; AW-24's held-action task copies that contract from
 * it). Both service lookups were written as "absent → optional":
 *
 *     const installer = appContext.get(PluginInstallerService, { strict: false });
 *     if (installer) { ... }                     // install is optional
 *     const registered = registry?.get(pluginId); // → PLUGIN_NOT_REGISTERED
 *
 * but Nest's `get(Token, { strict: false })` THROWS `UnknownElementException` for
 * an absent provider — it never answers `undefined`. And the task's outer `try`
 * has only a `finally`, so that throw was not turned into an error envelope at
 * all: it escaped `run`, into Trigger.dev's retry path. The cases that model
 * Nest's real behaviour are in "an absent service"; they fail against the lookup
 * as it was and pass with `getOptionalProvider`.
 */

const { contextHolder, createApplicationContextMock, recorded } = vi.hoisted(() => ({
    contextHolder: { current: undefined as unknown },
    createApplicationContextMock: vi.fn(),
    recorded: [] as Array<Record<string, any>>,
}));

vi.mock('@trigger.dev/sdk', () => ({
    task: (params: Record<string, unknown>) => {
        recorded.push(params);
        return params;
    },
}));

// The ROOT `@nestjs/core` only: the task boots its own context through
// `NestFactory`. `UnknownElementException` is imported from its deep path below,
// which this does not mock — the same class `getOptionalProvider` checks for.
vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: createApplicationContextMock },
}));

// Token classes for the two services (the lookup compares tokens), and the
// REAL operation resolver and materialiser — they are what is under test.
vi.mock('@ever-works/agent/plugins', async () => {
    const actual = await vi.importActual<typeof import('@ever-works/agent/plugins')>(
        '@ever-works/agent/plugins',
    );
    return {
        PluginInstallerService: class PluginInstallerService {},
        PluginRegistryService: class PluginRegistryService {},
        materializePlugin: actual.materializePlugin,
        resolvePluginOperation: actual.resolvePluginOperation,
    };
});

// The task's module and hydrator, as token stand-ins: the REAL module is booted
// by `trigger-run-plugin-operation.module.spec.ts`, against a fixture plugin.
vi.mock('../trigger/worker/modules/trigger-run-plugin-operation.module', () => ({
    TriggerRunPluginOperationModule: {
        forRoot: vi.fn(() => ({ module: class TriggerRunPluginOperationModule {} })),
    },
}));

vi.mock('../trigger/worker/services/trigger-plugin-hydrator.service', () => ({
    TriggerPluginHydratorService: class TriggerPluginHydratorService {},
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: vi.fn(() => ({})),
}));

import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import { PluginInstallerService, PluginRegistryService } from '@ever-works/agent/plugins';
import { runPluginOperationTask } from '../tasks/trigger/run-plugin-operation.task';
import { TriggerPluginHydratorService } from '../trigger/worker/services/trigger-plugin-hydrator.service';

const registered = recorded.find((entry) => entry.id === 'run-plugin-operation') as Record<
    string,
    any
>;
const run = (payload: Record<string, unknown>) => registered.run(payload);

const PLUGIN_ID = 'acme-generator';

interface Harness {
    installer: { ensurePluginAvailable: ReturnType<typeof vi.fn> } | 'absent';
    registry: { get: ReturnType<typeof vi.fn> } | 'absent';
    close: ReturnType<typeof vi.fn>;
    generate: ReturnType<typeof vi.fn>;
}

/**
 * A worker context whose `get` behaves the way Nest's does: it answers the
 * bound service, and THROWS `UnknownElementException` for one that is absent.
 */
function harness(
    over: {
        installer?: 'absent';
        registry?: 'absent';
        plugin?: 'unregistered';
        hydrator?: { initialize: ReturnType<typeof vi.fn> };
        entry?: unknown;
    } = {},
): Harness {
    const generate = vi.fn(async (args?: Record<string, unknown>) => ({ generated: true, args }));
    const h: Harness = {
        installer: over.installer ?? { ensurePluginAvailable: vi.fn(async () => undefined) },
        registry: over.registry ?? {
            get: vi.fn((id: string) =>
                over.plugin === 'unregistered' || id !== PLUGIN_ID
                    ? undefined
                    : (over.entry ?? { plugin: { generate } }),
            ),
        },
        close: vi.fn(async () => undefined),
        generate,
    };
    contextHolder.current = {
        useLogger: vi.fn(),
        close: h.close,
        get: vi.fn((token: unknown) => {
            const bound =
                token === PluginInstallerService
                    ? h.installer
                    : token === PluginRegistryService
                      ? h.registry
                      : token === TriggerPluginHydratorService && over.hydrator
                        ? over.hydrator
                        : 'absent';
            if (bound === 'absent') {
                throw new UnknownElementException(
                    String((token as { name?: string })?.name ?? token),
                );
            }
            return bound;
        }),
    };
    return h;
}

describe('run-plugin-operation (EW-693 T27)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createApplicationContextMock.mockImplementation(async () => contextHolder.current);
    });

    it('registers its id and the long-running budget', () => {
        expect(registered).toBeDefined();
        expect(runPluginOperationTask).toBe(registered);
        expect(registered.maxDuration).toBe(3600);
    });

    describe('with both services bound', () => {
        it('installs the plugin, then runs the operation with the payload’s args', async () => {
            const h = harness();

            const outcome = await run({
                pluginId: PLUGIN_ID,
                operation: 'generate',
                args: { n: 1 },
            });

            expect(outcome).toEqual({ ok: true, result: { generated: true, args: { n: 1 } } });
            expect(
                (h.installer as { ensurePluginAvailable: ReturnType<typeof vi.fn> })
                    .ensurePluginAvailable,
            ).toHaveBeenCalledWith(PLUGIN_ID);
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        it('answers WORKER_INSTALL_FAILED when the install throws, and runs nothing', async () => {
            const h = harness();
            (
                h.installer as { ensurePluginAvailable: ReturnType<typeof vi.fn> }
            ).ensurePluginAvailable.mockRejectedValue(new Error('integrity mismatch'));

            await expect(run({ pluginId: PLUGIN_ID, operation: 'generate' })).resolves.toEqual({
                ok: false,
                error: { message: 'integrity mismatch', code: 'WORKER_INSTALL_FAILED' },
            });
            expect(h.generate).not.toHaveBeenCalled();
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        it('answers PLUGIN_NOT_REGISTERED when the registry does not know the plugin', async () => {
            harness({ plugin: 'unregistered' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'PLUGIN_NOT_REGISTERED',
                    message: expect.stringContaining('after ensurePluginAvailable'),
                },
            });
        });

        it('answers OPERATION_NOT_FOUND for an operation the plugin does not implement', async () => {
            harness();

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'teleport' }),
            ).resolves.toMatchObject({
                ok: false,
                error: { code: 'OPERATION_NOT_FOUND' },
            });
        });

        it('answers WORKER_PLUGIN_THREW when the operation throws', async () => {
            const h = harness();
            h.generate.mockRejectedValue(new Error('upstream 500'));

            await expect(run({ pluginId: PLUGIN_ID, operation: 'generate' })).resolves.toEqual({
                ok: false,
                error: { message: 'upstream 500', code: 'WORKER_PLUGIN_THREW' },
            });
        });
    });

    /**
     * Nest's real behaviour for an absent provider: `get` THROWS. These are the
     * cases that matter — each promised a named answer, and each used to escape
     * `run` as an `UnknownElementException` instead.
     */
    describe('an absent service — Nest THROWS for it', () => {
        it('no installer: install is skipped and the operation still reaches the registry and runs', async () => {
            const h = harness({ installer: 'absent' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate', args: { n: 2 } }),
            ).resolves.toEqual({
                ok: true,
                result: { generated: true, args: { n: 2 } },
            });
            expect(h.generate).toHaveBeenCalledTimes(1);
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        it('no installer, plugin not registered: the registry check answers PLUGIN_NOT_REGISTERED', async () => {
            harness({ installer: 'absent', plugin: 'unregistered' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'PLUGIN_NOT_REGISTERED',
                    message: expect.stringContaining('no plugin installer is bound'),
                },
            });
        });

        it('no registry: PLUGIN_NOT_REGISTERED, as an envelope — not a throw', async () => {
            const h = harness({ registry: 'absent' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'PLUGIN_NOT_REGISTERED',
                    message: expect.stringContaining('no plugin registry is bound'),
                },
            });
            expect(h.generate).not.toHaveBeenCalled();
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        it('neither service: PLUGIN_NOT_REGISTERED, as an envelope — not a throw', async () => {
            harness({ installer: 'absent', registry: 'absent' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'PLUGIN_NOT_REGISTERED',
                    message: expect.stringContaining('no plugin registry is bound'),
                },
            });
        });
    });

    /**
     * The worker context and the operation lookup — the defects that made the
     * path unable to succeed at all (and the envelope contract breakable).
     */
    describe('booting, hydrating and resolving the operation', () => {
        it('boots its own module with abortOnError: false, and one attempt', () => {
            expect(registered.retry).toEqual({ maxAttempts: 1 });
        });

        it('answers WORKER_CONTEXT_BOOT_FAILED — never exits or throws — when the context cannot boot', async () => {
            createApplicationContextMock.mockRejectedValueOnce(
                new Error('TRIGGER_INTERNAL_API_URL is not configured'),
            );

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'WORKER_CONTEXT_BOOT_FAILED',
                    message: expect.stringContaining('TRIGGER_INTERNAL_API_URL is not configured'),
                },
            });
        });

        it('passes abortOnError: false, so Nest cannot process.exit on a boot failure', async () => {
            harness();

            await run({ pluginId: PLUGIN_ID, operation: 'generate' });

            expect(createApplicationContextMock).toHaveBeenCalledWith(expect.anything(), {
                abortOnError: false,
            });
        });

        it('refuses a payload without a plugin id or operation before booting anything', async () => {
            await expect(run({ pluginId: '', operation: 'generate' })).resolves.toMatchObject({
                ok: false,
                error: { code: 'INVALID_PAYLOAD' },
            });
            expect(createApplicationContextMock).not.toHaveBeenCalled();
        });

        it('hydrates the bundled plugins BEFORE looking the plugin up', async () => {
            const order: string[] = [];
            const initialize = vi.fn(async () => {
                order.push('hydrate');
            });
            const h = harness({ hydrator: { initialize } });
            (h.registry as { get: ReturnType<typeof vi.fn> }).get.mockImplementation(() => {
                order.push('lookup');
                return { plugin: { generate: h.generate } };
            });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: true,
            });
            expect(order).toEqual(['hydrate', 'lookup']);
        });

        it('answers WORKER_PLUGIN_HYDRATE_FAILED when loading the bundled plugins throws', async () => {
            const h = harness({
                hydrator: { initialize: vi.fn(async () => Promise.reject(new Error('disk gone'))) },
            });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'WORKER_PLUGIN_HYDRATE_FAILED',
                    message: expect.stringContaining('disk gone'),
                },
            });
            expect(h.generate).not.toHaveBeenCalled();
        });

        it('answers WORKER_PLUGIN_LOAD_FAILED for a plugin registered in an error state', async () => {
            const h = harness({ entry: { state: 'error', error: 'bad manifest', plugin: {} } });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'WORKER_PLUGIN_LOAD_FAILED',
                    message: expect.stringContaining('bad manifest'),
                },
            });
            expect(h.generate).not.toHaveBeenCalled();
        });

        /**
         * What the registry really holds: a lazy proxy whose `get` answers a
         * forwarding function for ANY property name. `typeof plugin[op]` was
         * therefore always 'function' — OPERATION_NOT_FOUND could never be
         * answered, and lifecycle hooks and inherited members were callable.
         */
        function lazyEntry(real: object, materializeError?: Error) {
            const stub = {
                __materialize: vi.fn(async () => {
                    if (materializeError) throw materializeError;
                    return real;
                }),
            };
            const proxy = new Proxy(stub, {
                get(target, prop) {
                    if (prop in target) return Reflect.get(target, prop);
                    return () => {
                        throw new TypeError(`forwarded ${String(prop)}`);
                    };
                },
            });
            return { state: 'loaded', plugin: proxy };
        }

        class RealPlugin {
            async onLoad() {}
            async onUnload() {}
            async generate(args?: Record<string, unknown>) {
                return { generated: true, args };
            }
            _internal() {
                return 'private';
            }
        }

        it('calls a real operation on the MATERIALISED plugin behind a lazy proxy', async () => {
            harness({ entry: lazyEntry(new RealPlugin()) });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate', args: { n: 3 } }),
            ).resolves.toEqual({ ok: true, result: { generated: true, args: { n: 3 } } });
        });

        it.each([
            'teleport',
            'constructor',
            '__materialize',
            'onUnload',
            'onLoad',
            'toString',
            'hasOwnProperty',
            '_internal',
            'generate.call',
        ])(
            'answers OPERATION_NOT_FOUND for %s — the proxy’s forwarding function is not an operation',
            async (op) => {
                harness({ entry: lazyEntry(new RealPlugin()) });

                await expect(run({ pluginId: PLUGIN_ID, operation: op })).resolves.toMatchObject({
                    ok: false,
                    error: { code: 'OPERATION_NOT_FOUND' },
                });
            },
        );

        it('answers WORKER_PLUGIN_LOAD_FAILED when the plugin will not materialise', async () => {
            harness({ entry: lazyEntry(new RealPlugin(), new Error('import failed')) });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'WORKER_PLUGIN_LOAD_FAILED',
                    message: expect.stringContaining('import failed'),
                },
            });
        });

        it('still answers its envelope when closing the context fails', async () => {
            const h = harness();
            h.close.mockRejectedValue(new Error('close failed'));

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: true,
            });
        });
    });
});
