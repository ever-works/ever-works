import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import {
    AppRuntimePluginRegistryBootstrap,
    TriggerAppRuntimeModule,
} from '../trigger-app-runtime.module';
import { TriggerPluginHydratorService } from '../../services/trigger-plugin-hydrator.service';

/**
 * **The App runtime worker's plugin registry is populated** (lane aw-managed-debug, 2026-10-18).
 *
 * Every `app-cluster-io` task resolves its plugin — the `k8s` plugin for `your-cluster`, the
 * `apps-tier` plugin for `ever-works-apps` — through `AppRuntimeFacadeService` and the registry.
 * No task that boots `TriggerAppRuntimeModule` ever called the plugin bootstrap, so on prod
 * (worker 20261018.4, run `run_cmvdl1xd81sut2y47j7sqnvo5`) the registry was EMPTY and the
 * managed Postgres row read `clusterUnreachable` with no cluster ever dialled:
 * `No enabled deployment plugin declares the 'apps-tier' capability for work …`.
 *
 * The module now bootstraps the registry itself. These cases pin that:
 *
 * 1. booting the module discovers the plugins on disk (`./plugins`, as `prepare:plugins` lays
 *    them out in the worker image) — a fixture `apps-tier` plugin is in the registry, indexed by
 *    its capability, after `createApplicationContext` and nothing else;
 * 2. the bootstrap provider never fails the context: a hydrator that throws, or none at all, is a
 *    warning, and the facade then answers its own named refusal.
 */

const FIXTURE_ID = 'fixture-apps-tier';

/** A disk plugin in the layout `packages/tasks/scripts/prepare-plugins.js` writes. */
function writeFixturePlugin(root: string): void {
    const dir = path.join(root, 'plugins', FIXTURE_ID);
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify(
            {
                name: `@ever-works/${FIXTURE_ID}-plugin`,
                version: '1.0.0',
                main: './dist/index.cjs',
                everworks: {
                    plugin: {
                        id: FIXTURE_ID,
                        name: 'Fixture apps tier',
                        version: '1.0.0',
                        category: 'deployment',
                        capabilities: ['deployment', 'apps-tier', 'app-dependency'],
                        description: 'Spec fixture',
                        author: { name: 'Ever Works Team' },
                        license: 'AGPL-3.0',
                        autoEnable: true,
                        systemPlugin: true,
                        builtIn: true,
                        visibility: 'hidden',
                    },
                },
            },
            null,
            2,
        ),
    );
    // Never imported by these cases (lazy registration reads the manifest only).
    fs.writeFileSync(
        path.join(dir, 'dist', 'index.cjs'),
        "throw new Error('the fixture plugin must not be imported at boot');\n",
    );
}

describe('TriggerAppRuntimeModule — the plugin registry is bootstrapped at boot', () => {
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
        process.env.TRIGGER_INTERNAL_SECRET = 'plugin-registry-spec-secret';

        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-app-runtime-plugins-'));
        writeFixturePlugin(tmp);
        // The worker resolves `./plugins` against its cwd (`PluginLoaderService`).
        process.chdir(tmp);

        context = await NestFactory.createApplicationContext(TriggerAppRuntimeModule, {
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

    it('binds the bootstrap provider', () => {
        expect(context.get(AppRuntimePluginRegistryBootstrap, { strict: false })).toBeInstanceOf(
            AppRuntimePluginRegistryBootstrap,
        );
    });

    it('has the disk plugins registered — the apps-tier one indexed by its capability', () => {
        const registry = context.get(PluginRegistryService, { strict: false });

        expect(registry.get(FIXTURE_ID)?.state).toBe('loaded');
        expect(registry.getByCapability('apps-tier').map((entry) => entry.plugin.id)).toContain(
            FIXTURE_ID,
        );
    });
});

describe('AppRuntimePluginRegistryBootstrap — never fails the context', () => {
    it('initialises the hydrator once', async () => {
        const initialize = vi.fn().mockResolvedValue(undefined);
        const bootstrap = new AppRuntimePluginRegistryBootstrap({
            initialize,
        } as unknown as TriggerPluginHydratorService);

        await bootstrap.onApplicationBootstrap();

        expect(initialize).toHaveBeenCalledTimes(1);
    });

    it('logs, and resolves, when the hydrator throws', async () => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
            const bootstrap = new AppRuntimePluginRegistryBootstrap({
                initialize: vi.fn().mockRejectedValue(new Error('plugins dir unreadable')),
            } as unknown as TriggerPluginHydratorService);

            await expect(bootstrap.onApplicationBootstrap()).resolves.toBeUndefined();
            expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
                'could not be bootstrapped: Error: plugins dir unreadable',
            );
        } finally {
            warn.mockRestore();
        }
    });

    it('logs, and resolves, when no hydrator is bound', async () => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
            await expect(
                new AppRuntimePluginRegistryBootstrap(undefined).onApplicationBootstrap(),
            ).resolves.toBeUndefined();
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});
