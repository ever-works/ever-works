import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import { PluginInstallerService, PluginRegistryService } from '@ever-works/agent/plugins';
import { TriggerRunPluginOperationModule } from '../trigger-run-plugin-operation.module';
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
 * 2. `PluginInstallerService` is deliberately NOT bound — "install" in the
 *    worker is hydration from the bundled image;
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

    it('does NOT bind PluginInstallerService — install in the worker is hydration', () => {
        expect(() => context.get(PluginInstallerService, { strict: false })).toThrow(
            UnknownElementException,
        );
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
