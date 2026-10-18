import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { AppDependencyFacadeService, AppRuntimeFacadeService } from '@ever-works/agent/facades';
import { TriggerPluginsModule } from '../trigger-plugins.module';
import { TriggerAppRuntimeModule } from '../trigger-app-runtime.module';
import { AppDependencyProvisionWorkerModule } from '../../../../tasks/trigger/app-dependency-provision.task';

/**
 * **One plugin registry per worker context** (lane aw-managed-debug, 2026-10-18).
 *
 * Nest 11 keys a dynamic module by REFERENCE, so every `TriggerPluginsModule.forRoot()` call
 * used to be its own module instance — its own `PluginRegistryService`. The
 * `app-dependency-provision` context imports `TriggerWorkerModule` AND `TriggerAppRuntimeModule`,
 * each with its own `forRoot()`: the App runtime module bootstrapped ITS registry (so the
 * runtime facade found the `apps-tier` plugin and prepared the namespace), while the task's
 * `AppDependencyFacadeService` read the OTHER, empty one and `resolve('k8s-apps-tier', …)`
 * answered `null` — `providerNotSupported` on prod (worker 20261018.5, runs
 * `run_cmvdsnwul27sl2x2viw5z0cu0` / `run_cmvdsnx6o1jos2z1rfg425oup`).
 *
 * Pinned here:
 *
 * 1. an option-less `forRoot()` is the SAME module object every time (an options call is not);
 * 2. booting the task's real module, the registry the dependency facade reads IS the one the
 *    runtime facade reads, and it holds the disk plugins: a fixture `app-dependency` plugin laid
 *    out like `prepare:plugins`' `./plugins` resolves through `AppDependencyFacadeService` —
 *    exactly the call that answered `null` on prod.
 */

const FIXTURE_ID = 'fixture-managed-deps';
const FIXTURE_PROVIDER = 'fixture-inline-postgres';

/** A disk `app-dependency` plugin, in the layout `packages/tasks/scripts/prepare-plugins.js` writes. */
function writeFixturePlugin(root: string): void {
    const dir = path.join(root, 'plugins', FIXTURE_ID);
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    const manifest = {
        id: FIXTURE_ID,
        name: 'Fixture managed dependencies',
        version: '1.0.0',
        category: 'deployment',
        capabilities: ['app-dependency'],
        description: 'Spec fixture',
        author: { name: 'Ever Works Team' },
        license: 'AGPL-3.0',
        autoEnable: true,
        systemPlugin: true,
        builtIn: true,
        visibility: 'hidden',
    };
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify(
            {
                name: `@ever-works/${FIXTURE_ID}-plugin`,
                version: '1.0.0',
                main: './dist/index.cjs',
                everworks: { plugin: manifest },
            },
            null,
            2,
        ),
    );
    fs.writeFileSync(
        path.join(dir, 'dist', 'index.cjs'),
        [
            "'use strict';",
            'class FixtureManagedDependencies {',
            '    constructor() {',
            `        this.id = '${FIXTURE_ID}';`,
            "        this.name = 'Fixture managed dependencies';",
            "        this.version = '1.0.0';",
            "        this.category = 'deployment';",
            "        this.capabilities = ['app-dependency'];",
            '        this.dependencyProviders = [',
            `            { id: '${FIXTURE_PROVIDER}', kind: 'postgres', targets: ['ever-works-apps'], label: 'Fixture', preference: 10, backupPolicy: 'none' },`,
            '        ];',
            '    }',
            `    getManifest() { return ${JSON.stringify(manifest)}; }`,
            '    async onLoad() {}',
            '    async onUnload() {}',
            '    async supports() { return { supported: true }; }',
            "    async provision() { return { state: 'ready', outputs: {} }; }",
            '    async getOutputs() { return {}; }',
            "    async deprovision() { return { state: 'released' }; }",
            "    async backupStatus() { return { state: 'none' }; }",
            '}',
            'module.exports = FixtureManagedDependencies;',
            'module.exports.default = FixtureManagedDependencies;',
            '',
        ].join('\n'),
    );
}

describe('TriggerPluginsModule.forRoot() — one module object', () => {
    it('answers the same module for every option-less call', () => {
        expect(TriggerPluginsModule.forRoot()).toBe(TriggerPluginsModule.forRoot());
        expect(TriggerPluginsModule.forRoot({})).toBe(TriggerPluginsModule.forRoot());
    });

    it('answers a module of its own for a call with options', () => {
        expect(TriggerPluginsModule.forRoot({ pluginPaths: ['./elsewhere'] })).not.toBe(
            TriggerPluginsModule.forRoot(),
        );
    });
});

describe('app-dependency-provision — the dependency facade reads the bootstrapped registry', () => {
    let context: INestApplicationContext;
    let stubApi: Server;
    let tmp: string;
    const cwd = process.cwd();

    beforeAll(async () => {
        stubApi = createServer((_request, response) => {
            response.writeHead(501, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'the stub answers nothing' }));
        });
        await new Promise<void>((resolve) => stubApi.listen(0, '127.0.0.1', () => resolve()));
        const port = (stubApi.address() as { port: number }).port;
        process.env.TRIGGER_INTERNAL_API_URL = `http://127.0.0.1:${port}`;
        process.env.TRIGGER_INTERNAL_SECRET = 'single-registry-spec-secret';

        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-single-registry-'));
        writeFixturePlugin(tmp);
        // The worker resolves `./plugins` against its cwd (`PluginLoaderService`).
        process.chdir(tmp);

        context = await NestFactory.createApplicationContext(AppDependencyProvisionWorkerModule, {
            abortOnError: false,
            logger: false,
        });
    }, 180_000);

    afterAll(async () => {
        await context?.close();
        process.chdir(cwd);
        await new Promise<void>((resolve) => stubApi?.close(() => resolve()));
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('has ONE registry: the runtime facade and the dependency facade share it', () => {
        const runtime = context
            .select(TriggerAppRuntimeModule)
            .get(AppRuntimeFacadeService, { strict: true }) as unknown as {
            registry: PluginRegistryService;
        };
        // The task module's OWN facade — the one its `AppDependenciesService` is handed.
        const dependencies = context
            .select(AppDependencyProvisionWorkerModule)
            .get(AppDependencyFacadeService, { strict: true }) as unknown as {
            registry: PluginRegistryService;
        };

        expect(dependencies.registry).toBe(runtime.registry);
        expect(dependencies.registry.get(FIXTURE_ID)?.state).toBe('loaded');
    });

    it('resolves a stored (plugin, provider) pair — the call that answered null on prod', async () => {
        const facade = context
            .select(AppDependencyProvisionWorkerModule)
            .get(AppDependencyFacadeService, { strict: true });

        const resolved = await facade.resolve(FIXTURE_ID, FIXTURE_PROVIDER, 'postgres');

        expect(resolved?.selection).toMatchObject({
            providerPluginId: FIXTURE_ID,
            providerId: FIXTURE_PROVIDER,
        });
    });
});
