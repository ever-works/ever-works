import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

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
        PluginLoaderService: class PluginLoaderService {},
        // The REAL refusal class: the task tells a refusal (FR-10/FR-11) from
        // a failed fetch by it.
        PluginInstallRefusedError: actual.PluginInstallRefusedError,
        materializePlugin: actual.materializePlugin,
        resolvePluginOperation: actual.resolvePluginOperation,
        describeMissingOperation: actual.describeMissingOperation,
        pluginLoadFailure: actual.pluginLoadFailure,
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
import { Logger } from '@nestjs/common';
import {
    PluginInstallerService,
    PluginInstallRefusedError,
    PluginLoaderService,
    PluginRegistryService,
} from '@ever-works/agent/plugins';
import {
    PLUGIN_OPERATION_MAX_DURATION_SECONDS,
    PLUGIN_OPERATION_TASK_ID,
} from '@ever-works/agent/tasks';
import { runPluginOperationTask } from '../tasks/trigger/run-plugin-operation.task';
import { TriggerPluginHydratorService } from '../trigger/worker/services/trigger-plugin-hydrator.service';

const registered = recorded.find((entry) => entry.id === 'run-plugin-operation') as Record<
    string,
    any
>;
const run = (payload: Record<string, unknown>) => registered.run(payload);

const PLUGIN_ID = 'acme-generator';

/**
 * The manifest of a plugin that declares `generate` — only declared operations
 * can be called by name (`everworks.plugin.operations`).
 */
const DECLARES_GENERATE = { id: PLUGIN_ID, operations: [{ name: 'generate' }] };

interface InstallerDouble {
    getDistributionMode: ReturnType<typeof vi.fn>;
    ensureLocalInstall: ReturnType<typeof vi.fn>;
    /** The API-side method that trusts — and writes — the shared row. Never called here. */
    ensurePluginAvailable: ReturnType<typeof vi.fn>;
}

interface Harness {
    installer: InstallerDouble | 'absent';
    registry: { get: ReturnType<typeof vi.fn> } | 'absent';
    loader: { registerFromPath: ReturnType<typeof vi.fn> } | 'absent';
    close: ReturnType<typeof vi.fn>;
    generate: ReturnType<typeof vi.fn>;
}

/** Where the double installer "places" a runtime-installed plugin. */
const INSTALL_PATH = '/worker/.plugin-store/.versions/@ever-works__acme-generator-plugin/1.2.0';

/**
 * A worker context whose `get` behaves the way Nest's does: it answers the
 * bound service, and THROWS `UnknownElementException` for one that is absent.
 *
 * `plugin: 'unregistered'` — the plugin is not in the image; with
 * `mode: 'dynamic'` the double loader registers it (`registerFromPath`), after
 * which the registry answers it.
 */
function harness(
    over: {
        installer?: 'absent';
        registry?: 'absent';
        loader?: 'absent';
        plugin?: 'unregistered';
        mode?: 'bundled' | 'dynamic';
        hydrator?: { initialize: ReturnType<typeof vi.fn> };
        entry?: unknown;
    } = {},
): Harness {
    const generate = vi.fn(async (args?: Record<string, unknown>) => ({ generated: true, args }));
    let registeredAtRuntime = false;
    const h: Harness = {
        installer: over.installer ?? {
            getDistributionMode: vi.fn(() => over.mode ?? 'bundled'),
            ensureLocalInstall: vi.fn(async (id: string) => ({
                pluginId: id,
                packageName: '@ever-works/acme-generator-plugin',
                version: '1.2.0',
                integrity: 'sha512-pinned',
                installPath: INSTALL_PATH,
                registrySpec: '@ever-works/acme-generator-plugin@1.2.0',
            })),
            ensurePluginAvailable: vi.fn(async () => undefined),
        },
        registry: over.registry ?? {
            get: vi.fn((id: string) =>
                id !== PLUGIN_ID || (over.plugin === 'unregistered' && !registeredAtRuntime)
                    ? undefined
                    : (over.entry ?? { manifest: DECLARES_GENERATE, plugin: { generate } }),
            ),
        },
        loader: over.loader ?? {
            registerFromPath: vi.fn(async (_path: string, opts: { expectedId: string }) => {
                registeredAtRuntime = true;
                return { success: true, pluginId: opts.expectedId };
            }),
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
                      : token === PluginLoaderService
                        ? h.loader
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

    it('registers under the agent’s shared constants — the id the dispatcher triggers, and the budget the router waits on', () => {
        // The agent package is NOT mocked here: these are the values the router
        // and `TriggerService.dispatchPluginOperation` use.
        expect(registered.id).toBe(PLUGIN_OPERATION_TASK_ID);
        expect(registered.maxDuration).toBe(PLUGIN_OPERATION_MAX_DURATION_SECONDS);
    });

    describe('with both services bound', () => {
        // T27 — was "installs the plugin, then runs the operation", which
        // pinned the old order: `ensurePluginAvailable` BEFORE hydrating, for
        // every plugin — a method that trusts, and writes, the API's shared
        // install row. A plugin in the image is now run without asking the
        // installer at all ("bundled wins").
        it('runs the operation of a plugin in the image with the payload’s args — the installer is not asked', async () => {
            const h = harness({ mode: 'dynamic' });

            const outcome = await run({
                pluginId: PLUGIN_ID,
                operation: 'generate',
                args: { n: 1 },
            });

            expect(outcome).toEqual({ ok: true, result: { generated: true, args: { n: 1 } } });
            const installer = h.installer as InstallerDouble;
            expect(installer.ensureLocalInstall).not.toHaveBeenCalled();
            expect(installer.ensurePluginAvailable).not.toHaveBeenCalled();
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        // T27 — was driven by `ensurePluginAvailable` rejecting for a plugin
        // that was already registered. The install step is now
        // `ensureLocalInstall`, reached only for a plugin not in the image.
        it('answers WORKER_INSTALL_FAILED when the install throws, and runs nothing', async () => {
            const h = harness({ mode: 'dynamic', plugin: 'unregistered' });
            (h.installer as InstallerDouble).ensureLocalInstall.mockRejectedValue(
                new Error('integrity mismatch'),
            );

            await expect(run({ pluginId: PLUGIN_ID, operation: 'generate' })).resolves.toEqual({
                ok: false,
                error: { message: 'integrity mismatch', code: 'WORKER_INSTALL_FAILED' },
            });
            expect(h.generate).not.toHaveBeenCalled();
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        // T27 — was 'after ensurePluginAvailable': in bundled mode (the
        // default) nothing is installed, and the answer names the image.
        it('answers PLUGIN_NOT_REGISTERED when the registry does not know the plugin', async () => {
            const h = harness({ plugin: 'unregistered' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'PLUGIN_NOT_REGISTERED',
                    message: expect.stringContaining('not bundled in the worker image'),
                },
            });
            expect((h.installer as InstallerDouble).ensureLocalInstall).not.toHaveBeenCalled();
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
     * T27's runtime-installed half. A plugin that is not in the worker image,
     * in dynamic mode: hydrate first, then install the version the API PINNED
     * into this worker's own store (`ensureLocalInstall` — never the method
     * that writes the shared row), register the extracted directory, and look
     * it up again.
     */
    describe('a plugin that is not in the image (T27 — runtime-installed)', () => {
        it('hydrates, installs the pinned version, registers the extracted directory, then runs', async () => {
            const order: string[] = [];
            const initialize = vi.fn(async () => {
                order.push('hydrate');
            });
            const h = harness({
                mode: 'dynamic',
                plugin: 'unregistered',
                hydrator: { initialize },
            });
            const installer = h.installer as InstallerDouble;
            const registry = h.registry as { get: ReturnType<typeof vi.fn> };
            const loader = h.loader as { registerFromPath: ReturnType<typeof vi.fn> };
            const lookup = registry.get.getMockImplementation()!;
            registry.get.mockImplementation((id: string) => {
                order.push('lookup');
                return lookup(id);
            });
            const install = installer.ensureLocalInstall.getMockImplementation()!;
            installer.ensureLocalInstall.mockImplementation(async (id: string) => {
                order.push('install');
                return install(id);
            });
            const register = loader.registerFromPath.getMockImplementation()!;
            loader.registerFromPath.mockImplementation(async (p: string, o: unknown) => {
                order.push('register');
                return register(p, o);
            });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate', args: { n: 4 } }),
            ).resolves.toEqual({ ok: true, result: { generated: true, args: { n: 4 } } });

            expect(order).toEqual(['hydrate', 'lookup', 'install', 'register', 'lookup']);
            expect(installer.ensureLocalInstall).toHaveBeenCalledWith(PLUGIN_ID);
            expect(loader.registerFromPath).toHaveBeenCalledWith(INSTALL_PATH, {
                expectedId: PLUGIN_ID,
            });
            expect(installer.ensurePluginAvailable).not.toHaveBeenCalled();
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        it('answers WORKER_INSTALL_REFUSED — and runs nothing — when the installer refuses (FR-10/FR-11)', async () => {
            const h = harness({ mode: 'dynamic', plugin: 'unregistered' });
            (h.installer as InstallerDouble).ensureLocalInstall.mockRejectedValue(
                new PluginInstallRefusedError(
                    PLUGIN_ID,
                    'Package "@acme/generator" is not on the admin allowlist.',
                ),
            );

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'WORKER_INSTALL_REFUSED',
                    message: expect.stringContaining('not on the admin allowlist'),
                },
            });
            expect(
                (h.loader as { registerFromPath: ReturnType<typeof vi.fn> }).registerFromPath,
            ).not.toHaveBeenCalled();
            expect(h.generate).not.toHaveBeenCalled();
        });

        it('answers WORKER_INSTALL_FAILED, carrying the loader’s reason, when the extracted directory cannot be registered', async () => {
            const h = harness({ mode: 'dynamic', plugin: 'unregistered' });
            (
                h.loader as { registerFromPath: ReturnType<typeof vi.fn> }
            ).registerFromPath.mockResolvedValue({
                success: false,
                pluginId: PLUGIN_ID,
                error: 'The package declares plugin "someone-else", not "acme-generator"',
            });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'WORKER_INSTALL_FAILED',
                    message: expect.stringContaining('declares plugin "someone-else"'),
                },
            });
            expect(h.generate).not.toHaveBeenCalled();
        });

        it('answers WORKER_INSTALL_FAILED when no plugin loader is bound to register it', async () => {
            const h = harness({ mode: 'dynamic', plugin: 'unregistered', loader: 'absent' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'WORKER_INSTALL_FAILED',
                    message: expect.stringContaining('no plugin loader'),
                },
            });
            expect(h.generate).not.toHaveBeenCalled();
        });

        it('answers PLUGIN_NOT_REGISTERED when the plugin is still absent after it was installed and registered', async () => {
            const h = harness({ mode: 'dynamic', plugin: 'unregistered' });
            (h.registry as { get: ReturnType<typeof vi.fn> }).get.mockReturnValue(undefined);

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'PLUGIN_NOT_REGISTERED',
                    message: expect.stringContaining('after installing it'),
                },
            });
            expect(h.generate).not.toHaveBeenCalled();
        });

        it('never installs in bundled mode — a plugin not in the image is PLUGIN_NOT_REGISTERED', async () => {
            const h = harness({ mode: 'bundled', plugin: 'unregistered' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: { code: 'PLUGIN_NOT_REGISTERED' },
            });
            const installer = h.installer as InstallerDouble;
            expect(installer.ensureLocalInstall).not.toHaveBeenCalled();
            expect(installer.ensurePluginAvailable).not.toHaveBeenCalled();
        });
    });

    /**
     * "The image wins" — and the image is chosen at BUILD time
     * (`prepare-plugins.js` reads PLUGIN_DISTRIBUTION_MODE when the worker is
     * deployed), while runtime installs follow the RUN-time mode. A worker run
     * in dynamic mode on an image built in bundled mode (the default) carries
     * distributable plugins, and runs its own copy, not the version the API
     * pinned. That is allowed, but it must not be silent. No API call is needed
     * to notice: the manifest says whether the plugin is distributable.
     *
     * Each case uses its own manifest version: the warning is once per plugin
     * version per process, and the process outlives a test.
     */
    describe('a distributable plugin the image carries, in dynamic mode (T27 — image/pin skew)', () => {
        let warn: MockInstance;

        beforeEach(() => {
            warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        });

        afterEach(() => {
            warn.mockRestore();
        });

        const inImage = (manifest: Record<string, unknown>) => ({
            manifest: { ...DECLARES_GENERATE, ...manifest },
            plugin: { generate: vi.fn(async () => ({ generated: true })) },
        });

        const skewWarnings = () =>
            warn.mock.calls
                .map(([message]) => String(message))
                .filter((message) => message.includes('PLUGIN_DISTRIBUTION_MODE=dynamic'));

        it('runs the image’s copy, and warns — once per process — that it is not the pinned version', async () => {
            const h = harness({ mode: 'dynamic', entry: inImage({ version: '9.0.1' }) });

            await expect(run({ pluginId: PLUGIN_ID, operation: 'generate' })).resolves.toEqual({
                ok: true,
                result: { generated: true },
            });
            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({ ok: true });

            const warnings = skewWarnings();
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain(`"${PLUGIN_ID}"`);
            expect(warnings[0]).toContain('9.0.1');
            expect(warnings[0]).toContain('pinned');
            expect((h.installer as InstallerDouble).ensureLocalInstall).not.toHaveBeenCalled();
        });

        it.each([
            ['declared core', { version: '9.0.2', distribution: 'core' }],
            ['a system plugin with no distribution', { version: '9.0.3', systemPlugin: true }],
        ])('does not warn for %s — core plugins belong in every image', async (_l, manifest) => {
            harness({ mode: 'dynamic', entry: inImage(manifest) });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({ ok: true });

            expect(skewWarnings()).toEqual([]);
        });

        it('does not warn in bundled mode — there the image is the distribution', async () => {
            harness({ mode: 'bundled', entry: inImage({ version: '9.0.4' }) });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({ ok: true });

            expect(skewWarnings()).toEqual([]);
        });

        it('does not warn for a plugin it installed at runtime — that IS the pinned version', async () => {
            harness({
                mode: 'dynamic',
                plugin: 'unregistered',
                entry: inImage({ version: '9.0.5' }),
            });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({ ok: true });

            expect(skewWarnings()).toEqual([]);
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
                return { manifest: DECLARES_GENERATE, plugin: { generate: h.generate } };
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
            return { state: 'loaded', manifest: DECLARES_GENERATE, plugin: proxy };
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

        /**
         * The allowlist: TypeScript `private`/`protected` are erased at runtime,
         * so a method the class defines is NOT an operation unless the manifest
         * declares it.
         */
        it('answers OPERATION_NOT_FOUND — and calls nothing — for a method the manifest does not declare', async () => {
            class WithHelper extends RealPlugin {
                helper = vi.fn(async () => 'helped');
                async runPrompt() {
                    return 'spawned';
                }
            }
            const real = new WithHelper();
            const runPrompt = vi.spyOn(WithHelper.prototype, 'runPrompt');

            for (const op of ['helper', 'runPrompt']) {
                harness({ entry: lazyEntry(real) });
                await expect(run({ pluginId: PLUGIN_ID, operation: op })).resolves.toMatchObject({
                    ok: false,
                    error: {
                        code: 'OPERATION_NOT_FOUND',
                        message: expect.stringContaining(`does not declare operation "${op}"`),
                    },
                });
            }
            expect(real.helper).not.toHaveBeenCalled();
            expect(runPrompt).not.toHaveBeenCalled();
            runPrompt.mockRestore();
        });

        it('calls nothing for a plugin whose manifest declares no operations', async () => {
            const generate = vi.fn();
            harness({ entry: { plugin: { generate } } });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: { code: 'OPERATION_NOT_FOUND' },
            });
            expect(generate).not.toHaveBeenCalled();
        });

        it.each(['onLoad', 'constructor', '_internal', 'toString'])(
            'refuses %s even when the manifest declares it — the name rules and the Object.prototype boundary still apply',
            async (op) => {
                const entry = lazyEntry(new RealPlugin());
                harness({
                    entry: {
                        ...entry,
                        manifest: {
                            id: PLUGIN_ID,
                            operations: [{ name: 'generate' }, { name: op }],
                        },
                    },
                });

                await expect(run({ pluginId: PLUGIN_ID, operation: op })).resolves.toMatchObject({
                    ok: false,
                    error: { code: 'OPERATION_NOT_FOUND' },
                });
            },
        );

        it('answers OPERATION_NOT_FOUND, saying so, for a declared operation the class lacks', async () => {
            const entry = lazyEntry(new RealPlugin());
            harness({
                entry: {
                    ...entry,
                    manifest: {
                        id: PLUGIN_ID,
                        operations: [{ name: 'generate' }, { name: 'publish' }],
                    },
                },
            });

            await expect(run({ pluginId: PLUGIN_ID, operation: 'publish' })).resolves.toMatchObject(
                {
                    ok: false,
                    error: {
                        code: 'OPERATION_NOT_FOUND',
                        message: expect.stringContaining(
                            'declares operation "publish" but does not implement it',
                        ),
                    },
                },
            );
        });

        /**
         * A lazy plugin's `onLoad` runs inside its first materialisation; a throw
         * there is recorded on the registry entry (`callOnLoad`) and
         * `__materialize` still resolves. The state has to be read again.
         */
        it('answers WORKER_PLUGIN_LOAD_FAILED — and runs nothing — when onLoad fails while the plugin materialises', async () => {
            const real = new RealPlugin();
            const generate = vi.spyOn(real, 'generate');
            const entry: Record<string, unknown> = lazyEntry(real);
            const plugin = entry.plugin as { __materialize: ReturnType<typeof vi.fn> };
            plugin.__materialize.mockImplementation(async () => {
                entry.state = 'error';
                entry.error = new Error('onLoad: required setting "apiKey" is missing');
                return real;
            });
            harness({ entry });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'WORKER_PLUGIN_LOAD_FAILED',
                    message: expect.stringContaining('required setting "apiKey" is missing'),
                },
            });
            expect(generate).not.toHaveBeenCalled();
        });

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
