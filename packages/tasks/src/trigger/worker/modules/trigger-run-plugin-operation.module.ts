import * as path from 'path';
import { DynamicModule, Module } from '@nestjs/common';
import { PluginAllowlistRepository, PluginInstallerService } from '@ever-works/agent/plugins';
import type { PluginsModuleOptions } from '@ever-works/agent/plugins';
import { TriggerPluginsModule } from './trigger-plugins.module';
import { TriggerRemoteCacheModule } from './trigger-remote-cache.module';
import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { createRemoteProxy } from '../remote-proxy';

/**
 * EW-693 / T27 — the remote target the worker's allowlist reads go to. The API
 * registers it in `TriggerInternalController`'s `remoteMap` as a reader that
 * exposes `findByPackageName` ONLY; the repository itself, whose other methods
 * write, is not a remote target.
 */
export const PLUGIN_ALLOWLIST_READER = 'PluginAllowlistReader';

/**
 * EW-693 / T27 — the worker's distribution settings, read from the same
 * environment variables as the API's (`apps/api/src/config/constants.ts`,
 * `config.plugins`), so one variable means the same thing on both:
 *
 * - `PLUGIN_DISTRIBUTION_MODE` — `dynamic` (case-insensitive) or, for
 *   anything else including unset, `bundled` (the default; fail-safe).
 * - `PLUGIN_REGISTRY_URL`, `PLUGIN_REGISTRY_GITHUB_URL`, `PLUGIN_REGISTRY_TOKEN`
 *   — passed only when set; the installer has the same defaults as the API.
 * - `PLUGIN_INSTALL_DIR` — the worker's own store. Default
 *   `<cwd>/.plugin-store`: it must sit under the directory whose
 *   `node_modules` holds the plugins' external dependencies (installed through
 *   `additionalPackages` in `trigger.config.ts`), because a runtime-installed
 *   package resolves its imports by walking up from its own location — so not
 *   `os.tmpdir()`.
 */
export function workerDistributionOptionsFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): PluginsModuleOptions {
    const options: PluginsModuleOptions = {
        distributionMode:
            (env.PLUGIN_DISTRIBUTION_MODE ?? '').toLowerCase() === 'dynamic'
                ? 'dynamic'
                : 'bundled',
        installDir: env.PLUGIN_INSTALL_DIR || path.resolve(process.cwd(), '.plugin-store'),
    };
    if (env.PLUGIN_REGISTRY_URL) options.registryUrl = env.PLUGIN_REGISTRY_URL;
    if (env.PLUGIN_REGISTRY_GITHUB_URL) options.registryGithubUrl = env.PLUGIN_REGISTRY_GITHUB_URL;
    if (env.PLUGIN_REGISTRY_TOKEN) options.registryToken = env.PLUGIN_REGISTRY_TOKEN;
    return options;
}

/**
 * EW-693 / T27 — the worker context `run-plugin-operation` runs a plugin
 * operation in. The narrowest graph that has a working plugin registry:
 *
 * - `TriggerPluginsModule.forRoot()` (@Global): the registry, loader, bootstrap
 *   and `TriggerPluginHydratorService`, which fills the registry from the
 *   plugins in the worker image (`prepare-plugins.js` copies every first-party
 *   plugin in bundled mode, and only the core ones when the image is built for
 *   dynamic mode).
 * - `TriggerRemoteCacheModule.forRoot()` (@Global): `CACHE_MANAGER`, a
 *   non-optional dependency of `PluginContextFactoryService` — the plugins
 *   module alone fails to boot without it (the same pairing the workflow-run
 *   and app-runtime worker modules use).
 * - `TriggerInternalModule`: `TriggerInternalApiClient`, for the allowlist
 *   proxy below.
 *
 * The task used to boot `TriggerInternalModule` alone, which binds NEITHER the
 * registry nor the installer, so every run answered PLUGIN_NOT_REGISTERED
 * (verified with a runtime probe against @nestjs/core 11.1.18).
 *
 * ## The installer (T27's runtime-installed half)
 *
 * `PluginInstallerService` is bound. In bundled mode (the default) it is inert:
 * the task never calls it. In dynamic mode, for a plugin the image does not
 * carry, the task calls `ensureLocalInstall` — the version the API PINNED
 * (exact version + integrity), allowlist first, into this worker's own store
 * (`installDir`), never writing the API's shared install row — and registers
 * the extracted directory with `loader.registerFromPath`. Its dependencies:
 *
 * - `PLUGINS_MODULE_OPTIONS` and the `PluginRepository` proxy, from
 *   `TriggerPluginsModule`. The installer only READS the row
 *   (`findByPluginId`, over the internal API).
 * - `PluginAllowlistRepository` — a proxy to the API's read-only
 *   `PluginAllowlistReader`, so an allowlisted third-party package can run in
 *   the worker (owner decision), checked before any download (FR-11).
 *
 * `forRoot(options)` layers the caller's plugin options OVER the
 * environment's ({@link workerDistributionOptionsFromEnv}) and passes them to
 * `TriggerPluginsModule` (the task uses the defaults; the boot spec points
 * `pluginPaths` at a fixture and switches dynamic mode on explicitly).
 */
@Module({})
export class TriggerRunPluginOperationModule {
    static forRoot(pluginOptions: PluginsModuleOptions = {}): DynamicModule {
        return {
            module: TriggerRunPluginOperationModule,
            imports: [
                TriggerPluginsModule.forRoot({
                    ...workerDistributionOptionsFromEnv(),
                    ...pluginOptions,
                }),
                TriggerRemoteCacheModule.forRoot(),
                TriggerInternalModule,
            ],
            providers: [
                {
                    provide: PluginAllowlistRepository,
                    useFactory: (apiClient: TriggerInternalApiClient) =>
                        createRemoteProxy(apiClient, PLUGIN_ALLOWLIST_READER),
                    inject: [TriggerInternalApiClient],
                },
                PluginInstallerService,
            ],
            exports: [PluginInstallerService],
        };
    }
}
