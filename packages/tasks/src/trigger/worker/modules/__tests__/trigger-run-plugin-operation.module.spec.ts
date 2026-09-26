import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import superjson from 'superjson';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import {
    PLUGINS_MODULE_OPTIONS,
    PluginInstallerService,
    PluginRegistryService,
    type PacoteLike,
    type PluginsModuleOptions,
} from '@ever-works/agent/plugins';
import { getOptionalProvider } from '@ever-works/agent/utils';
import {
    TriggerRunPluginOperationModule,
    workerDistributionOptionsFromEnv,
} from '../trigger-run-plugin-operation.module';
import { TriggerPluginHydratorService } from '../../services/trigger-plugin-hydrator.service';
import {
    executePluginOperation,
    type RunPluginOperationOutcome,
} from '../../../../tasks/trigger/run-plugin-operation.task';

/**
 * EW-693 / T27 — does the worker context `run-plugin-operation` runs in actually
 * BOOT, bind a plugin registry, and run a plugin operation end to end?
 *
 * No mocks of the container, the registry, the loader or the lazy proxy: the
 * REAL module boots against a loopback stub API (which must receive zero
 * requests, as for every worker module), the REAL hydrator discovers a fixture
 * plugin from `pluginPaths`, the REAL registry hands out its lazy proxy, and the
 * task's own post-boot body (`executePluginOperation`) runs operations on it.
 *
 * What this pins, each a defect the previous task had:
 *
 * 1. the context binds the registry (the old `TriggerInternalModule` context
 *    bound neither it nor the installer, so every run answered
 *    PLUGIN_NOT_REGISTERED);
 * 2. `PluginInstallerService` is bound, and INERT in bundled mode (the
 *    default): a plugin the image does not carry is answered
 *    PLUGIN_NOT_REGISTERED and nothing is dialled. (Before T27's
 *    runtime-installed half this pinned the installer as NOT bound; the second
 *    `describe` below pins what it does in dynamic mode);
 * 3. a real lazy proxy answers a function for ANY property, so the operation
 *    check has to run on the materialised plugin — `constructor`,
 *    `__materialize`, `onUnload`, `toString` and `_secret` are refused;
 * 4. only operations the manifest DECLARES (`everworks.plugin.operations`) are
 *    callable: inherited helpers (`emitEvent`, `log` — `protected` on the real
 *    `BasePlugin`), a TS-`private`-style method and a function-valued class
 *    field were all reachable by name before, and are refused now;
 * 5. a lazily registered plugin whose `onLoad` throws while materialising
 *    answers WORKER_PLUGIN_LOAD_FAILED — its operation used to run anyway,
 *    because the failure is recorded on the registry entry, not thrown.
 */

const FIXTURE_PLUGINS = path.resolve(__dirname, 'fixtures/run-plugin-operation');

describe('TriggerRunPluginOperationModule (EW-693 T27) — the real worker context', () => {
    let context: INestApplicationContext;
    let stubApi: Server;
    let stubRequests = 0;

    beforeAll(async () => {
        stubApi = createServer((_request, response) => {
            stubRequests += 1;
            response.writeHead(501, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'the stub answers nothing' }));
        });
        await new Promise<void>((resolve) => stubApi.listen(0, '127.0.0.1', () => resolve()));
        const port = (stubApi.address() as { port: number }).port;
        process.env.TRIGGER_INTERNAL_API_URL = `http://127.0.0.1:${port}`;
        process.env.TRIGGER_INTERNAL_SECRET = 't27-spec-secret';

        context = await NestFactory.createApplicationContext(
            TriggerRunPluginOperationModule.forRoot({ pluginPaths: [FIXTURE_PLUGINS] }),
            { abortOnError: false, logger: false },
        );
    }, 180_000);

    afterAll(async () => {
        await context?.close();
        await new Promise<void>((resolve) => stubApi?.close(() => resolve()));
    });

    const execute = (
        operation: string,
        args?: Record<string, unknown>,
        pluginId = 'fixture-echo',
    ) =>
        executePluginOperation(context, {
            pluginId,
            operation,
            args,
        }) as Promise<RunPluginOperationOutcome>;

    it('boots, and dials nothing while booting', () => {
        expect(context).toBeDefined();
        expect(stubRequests).toBe(0);
    });

    it('binds the plugin registry and the hydrator', () => {
        expect(context.get(PluginRegistryService, { strict: false })).toBeInstanceOf(
            PluginRegistryService,
        );
        expect(context.get(TriggerPluginHydratorService, { strict: false })).toBeInstanceOf(
            TriggerPluginHydratorService,
        );
    });

    // T27 — was "does NOT bind PluginInstallerService — install in the worker
    // is hydration" (`toThrow(UnknownElementException)`). That pinned the gap
    // T27's runtime-installed half closes: the worker now binds an installer
    // that pins the API's version, uses its own store and never writes the
    // shared row. In bundled mode (the default) it is inert — the cases below
    // still dial nothing and still name the image.
    it('binds PluginInstallerService — inert in bundled mode, the default', () => {
        const installer = context.get(PluginInstallerService, { strict: false });
        expect(installer).toBeInstanceOf(PluginInstallerService);
        expect(installer.getDistributionMode()).toBe('bundled');
    });

    it('runs an operation of a plugin bundled in the worker, end to end', async () => {
        await expect(execute('echo', { n: 1 })).resolves.toEqual({
            ok: true,
            result: { echoed: { n: 1 } },
        });
        // The registry really handed out a lazy proxy, now materialised.
        const entry = context.get(PluginRegistryService, { strict: false }).get('fixture-echo');
        expect((entry?.plugin as unknown as { __isMaterialized?: boolean }).__isMaterialized).toBe(
            true,
        );
    });

    it.each(['teleport', 'constructor', '__materialize', 'onUnload', 'toString', '_secret'])(
        'refuses %s — the real lazy proxy answers a function for any name',
        async (operation) => {
            await expect(execute(operation)).resolves.toMatchObject({
                ok: false,
                error: { code: 'OPERATION_NOT_FOUND' },
            });
        },
    );

    it.each(['emitEvent', 'log', 'replaceFile', 'runPrompt'])(
        'refuses %s — callable on the class, but the manifest does not declare it',
        async (operation) => {
            delete (globalThis as { __fixtureEchoHelpersCalled?: unknown })
                .__fixtureEchoHelpersCalled;

            await expect(
                execute(operation, { flags: ['--dangerously-bypass'] }),
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: 'OPERATION_NOT_FOUND',
                    message: expect.stringContaining('does not declare operation'),
                },
            });
            expect(
                (globalThis as { __fixtureEchoHelpersCalled?: unknown }).__fixtureEchoHelpersCalled,
            ).toBeUndefined();
        },
    );

    it('answers OPERATION_NOT_FOUND, saying so, for a declared operation the class lacks', async () => {
        await expect(execute('declaredButMissing')).resolves.toMatchObject({
            ok: false,
            error: {
                code: 'OPERATION_NOT_FOUND',
                message: expect.stringContaining(
                    'declares operation "declaredButMissing" but does not implement it',
                ),
            },
        });
    });

    it('answers WORKER_PLUGIN_LOAD_FAILED — and runs nothing — when onLoad throws while the plugin loads', async () => {
        delete (globalThis as { __fixtureOnloadThrowsTouched?: unknown })
            .__fixtureOnloadThrowsTouched;

        await expect(execute('touch', undefined, 'fixture-onload-throws')).resolves.toMatchObject({
            ok: false,
            error: {
                code: 'WORKER_PLUGIN_LOAD_FAILED',
                message: expect.stringContaining('required setting "apiKey" is missing'),
            },
        });
        expect(
            (globalThis as { __fixtureOnloadThrowsTouched?: unknown }).__fixtureOnloadThrowsTouched,
        ).toBeUndefined();
        const entry = context
            .get(PluginRegistryService, { strict: false })
            .get('fixture-onload-throws');
        expect(entry?.state).toBe('error');

        // And again: now refused before loading, from the recorded state.
        await expect(execute('touch', undefined, 'fixture-onload-throws')).resolves.toMatchObject({
            ok: false,
            error: { code: 'WORKER_PLUGIN_LOAD_FAILED' },
        });
        expect(
            (globalThis as { __fixtureOnloadThrowsTouched?: unknown }).__fixtureOnloadThrowsTouched,
        ).toBeUndefined();
    });

    it('reports an operation that throws as WORKER_PLUGIN_THREW', async () => {
        await expect(execute('explode')).resolves.toEqual({
            ok: false,
            error: { code: 'WORKER_PLUGIN_THREW', message: 'fixture exploded' },
        });
    });

    it('answers PLUGIN_NOT_REGISTERED, naming the image, for a plugin that is not bundled', async () => {
        await expect(execute('echo', undefined, 'not-in-this-image')).resolves.toMatchObject({
            ok: false,
            error: {
                code: 'PLUGIN_NOT_REGISTERED',
                message: expect.stringContaining('not bundled in the worker image'),
            },
        });
    });

    it('still dialled nothing after running operations', () => {
        expect(stubRequests).toBe(0);
    });
});

/**
 * EW-693 / T27 — the RUNTIME-INSTALLED half, against the REAL module in
 * dynamic mode: a plugin the worker image does not carry.
 *
 * The worker must install the version the API PINNED, into its OWN store, and
 * register it — and must not write the API's shared install row: in the worker
 * `PluginRepository` is a proxy to the API, so a write here would flip the
 * platform-wide row. The only double is the registry client (a pacote stub
 * that "downloads" `fixtures/runtime-registry/fixture-runtime`, which is
 * outside `pluginPaths`) and the internal API, a loopback stub that answers
 * `PluginRepository.findByPluginId` with the pinned row and records every call.
 *
 * Before T27 the worker bound no installer, and this plugin answered
 * PLUGIN_NOT_REGISTERED ("not bundled in the worker image").
 */
const RUNTIME_FIXTURE = path.resolve(__dirname, 'fixtures/runtime-registry/fixture-runtime');

const PINNED_ROW = {
    pluginId: 'fixture-runtime',
    source: 'registry',
    installState: 'installed',
    registrySpec: '@ever-works/fixture-runtime-plugin@1.0.0',
    installedVersion: '1.0.0',
    integrity: 'sha512-fixture-runtime',
};

describe('TriggerRunPluginOperationModule (EW-693 T27) — a plugin installed at runtime (dynamic mode)', () => {
    let context: INestApplicationContext;
    let stubApi: Server;
    let installDir: string;
    const calls: Array<{ name: string; method: string; args: unknown[] }> = [];
    const extracts: Array<{ spec: string; dest: string; integrity?: unknown }> = [];

    /** The registry client: "downloads" the fixture package into `dest`. */
    const pacote: PacoteLike = {
        async manifest(spec: string) {
            throw new Error(`a pinned install must not resolve ${spec}`);
        },
        async extract(spec: string, dest: string, opts?: Record<string, unknown>) {
            extracts.push({ spec, dest, integrity: opts?.integrity });
            await fs.cp(RUNTIME_FIXTURE, dest, { recursive: true });
            return undefined;
        },
    };

    const dynamicOptions = () => ({
        pluginPaths: [FIXTURE_PLUGINS],
        distributionMode: 'dynamic' as const,
        installDir,
    });

    async function boot(): Promise<INestApplicationContext> {
        const booted = await NestFactory.createApplicationContext(
            TriggerRunPluginOperationModule.forRoot(dynamicOptions()),
            { abortOnError: false, logger: false },
        );
        // `getOptionalProvider`: before T27 no installer was bound at all.
        getOptionalProvider<PluginInstallerService>(
            booted,
            PluginInstallerService,
        )?.setPacoteForTests(pacote);
        return booted;
    }

    beforeAll(async () => {
        installDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ew693-worker-store-'));
        stubApi = createServer((request, response) => {
            let body = '';
            request.on('data', (chunk) => (body += chunk));
            request.on('end', () => {
                const parsed = JSON.parse(body || '{}') as {
                    name: string;
                    method: string;
                    args: { json: unknown; meta?: unknown };
                };
                const args = superjson.deserialize(parsed.args as never) as unknown[];
                calls.push({ name: parsed.name, method: parsed.method, args });
                if (parsed.name === 'PluginRepository' && parsed.method === 'findByPluginId') {
                    const row = args[0] === PINNED_ROW.pluginId ? PINNED_ROW : null;
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ result: superjson.serialize(row) }));
                    return;
                }
                response.writeHead(501, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'the stub answers only findByPluginId' }));
            });
        });
        await new Promise<void>((resolve) => stubApi.listen(0, '127.0.0.1', () => resolve()));
        const port = (stubApi.address() as { port: number }).port;
        process.env.TRIGGER_INTERNAL_API_URL = `http://127.0.0.1:${port}`;
        process.env.TRIGGER_INTERNAL_SECRET = 't27-spec-secret';

        context = await boot();
    }, 180_000);

    afterAll(async () => {
        await context?.close();
        await new Promise<void>((resolve) => stubApi?.close(() => resolve()));
        await fs.rm(installDir, { recursive: true, force: true }).catch(() => undefined);
    });

    const execute = (
        ctx: INestApplicationContext,
        pluginId: string,
        args?: Record<string, unknown>,
    ) =>
        executePluginOperation(ctx, {
            pluginId,
            operation: 'echo',
            args,
        }) as Promise<RunPluginOperationOutcome>;

    it('installs the pinned version into its own store, registers it, and runs it', async () => {
        const outcome = await execute(context, 'fixture-runtime', { n: 7 });

        expect(outcome).toMatchObject({ ok: true, result: { echoed: { n: 7 } } });
        // The copy in THIS worker's store ran — not the fixture directory.
        const loadedFrom = (outcome.result as { loadedFrom: string }).loadedFrom;
        expect(path.resolve(loadedFrom).startsWith(path.resolve(installDir))).toBe(true);
        expect(loadedFrom).toContain('.versions');

        // The version and integrity the API pinned — fetched once.
        expect(extracts).toHaveLength(1);
        expect(extracts[0]).toMatchObject({
            spec: '@ever-works/fixture-runtime-plugin@1.0.0',
            integrity: 'sha512-fixture-runtime',
        });

        const entry = context.get(PluginRegistryService, { strict: false }).get('fixture-runtime');
        expect(entry?.builtIn).toBe(false);
        expect(path.resolve(entry!.installPath!).startsWith(path.resolve(installDir))).toBe(true);
    });

    it('only READ the pin from the API — the shared install row was never written', () => {
        expect(calls.length).toBeGreaterThan(0);
        expect(
            calls.every((c) => c.name === 'PluginRepository' && c.method === 'findByPluginId'),
        ).toBe(true);
        expect(calls.filter((c) => c.method === 'updateInstallState')).toEqual([]);
    });

    it('runs a plugin the image carries without asking the API or the registry ("bundled wins")', async () => {
        const before = { calls: calls.length, extracts: extracts.length };

        await expect(execute(context, 'fixture-echo', { n: 1 })).resolves.toEqual({
            ok: true,
            result: { echoed: { n: 1 } },
        });

        expect(calls.length).toBe(before.calls);
        expect(extracts.length).toBe(before.extracts);
    });

    it('refuses — before any download — a plugin the API has not pinned', async () => {
        const before = extracts.length;

        await expect(execute(context, 'not-pinned-anywhere')).resolves.toMatchObject({
            ok: false,
            error: { code: 'WORKER_INSTALL_REFUSED' },
        });
        expect(extracts.length).toBe(before);
    });

    it('a fresh worker context on the same machine answers from its store — no second download', async () => {
        const second = await boot();
        try {
            await expect(execute(second, 'fixture-runtime', { n: 8 })).resolves.toMatchObject({
                ok: true,
                result: { echoed: { n: 8 } },
            });
        } finally {
            await second.close();
        }
        expect(extracts).toHaveLength(1);
    }, 180_000);
});

/**
 * EW-693 / T27 — the worker's distribution switch. The same variables, with the
 * same parse, as the API's `config.plugins`: bundled unless
 * `PLUGIN_DISTRIBUTION_MODE` is `dynamic` (any case). The store defaults to
 * `<cwd>/.plugin-store` — under the directory whose `node_modules` holds the
 * plugins' dependencies — and the caller's options win over the environment.
 */
describe('TriggerRunPluginOperationModule (EW-693 T27) — its distribution options', () => {
    it('is bundled by default, with the store under the working directory', () => {
        expect(workerDistributionOptionsFromEnv({})).toEqual({
            distributionMode: 'bundled',
            installDir: path.resolve(process.cwd(), '.plugin-store'),
        });
    });

    it('reads PLUGIN_DISTRIBUTION_MODE as the API does, and passes the registry settings when set', () => {
        expect(
            workerDistributionOptionsFromEnv({
                PLUGIN_DISTRIBUTION_MODE: 'DYNAMIC',
                PLUGIN_INSTALL_DIR: '/data/plugin-store',
                PLUGIN_REGISTRY_URL: 'https://npm.mirror.example',
                PLUGIN_REGISTRY_GITHUB_URL: 'https://npm.pkg.github.example',
                PLUGIN_REGISTRY_TOKEN: 'registry-token',
            }),
        ).toEqual({
            distributionMode: 'dynamic',
            installDir: '/data/plugin-store',
            registryUrl: 'https://npm.mirror.example',
            registryGithubUrl: 'https://npm.pkg.github.example',
            registryToken: 'registry-token',
        });
        expect(
            workerDistributionOptionsFromEnv({ PLUGIN_DISTRIBUTION_MODE: 'dynamc' }),
        ).toMatchObject({
            distributionMode: 'bundled',
        });
    });

    it('layers the caller’s options over the environment’s', () => {
        const previous = process.env.PLUGIN_DISTRIBUTION_MODE;
        process.env.PLUGIN_DISTRIBUTION_MODE = 'dynamic';
        try {
            const pluginsModule = TriggerRunPluginOperationModule.forRoot({
                distributionMode: 'bundled',
            }).imports![0] as { providers: Array<{ provide?: unknown; useValue?: unknown }> };
            const options = pluginsModule.providers.find(
                (provider) => provider.provide === PLUGINS_MODULE_OPTIONS,
            )!.useValue as PluginsModuleOptions;

            expect(options.distributionMode).toBe('bundled');
            expect(options.installDir).toBe(path.resolve(process.cwd(), '.plugin-store'));
        } finally {
            if (previous === undefined) delete process.env.PLUGIN_DISTRIBUTION_MODE;
            else process.env.PLUGIN_DISTRIBUTION_MODE = previous;
        }
    });
});
