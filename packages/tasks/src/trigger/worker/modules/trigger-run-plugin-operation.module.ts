import { DynamicModule, Module } from '@nestjs/common';
import type { PluginsModuleOptions } from '@ever-works/agent/plugins';
import { TriggerPluginsModule } from './trigger-plugins.module';
import { TriggerRemoteCacheModule } from './trigger-remote-cache.module';

/**
 * EW-693 / T27 — the worker context `run-plugin-operation` runs a plugin
 * operation in. The narrowest graph that has a working plugin registry:
 *
 * - `TriggerPluginsModule.forRoot()` (@Global): the registry, loader, bootstrap
 *   and `TriggerPluginHydratorService`, which fills the registry from the
 *   plugins bundled into the worker image (`prepare-plugins.js` copies every
 *   first-party plugin, in bundled AND dynamic mode).
 * - `TriggerRemoteCacheModule.forRoot()` (@Global): `CACHE_MANAGER`, a
 *   non-optional dependency of `PluginContextFactoryService` — the plugins
 *   module alone fails to boot without it (the same pairing the workflow-run
 *   and app-runtime worker modules use).
 *
 * The task used to boot `TriggerInternalModule`, which binds NEITHER the
 * registry nor the installer, so every run answered PLUGIN_NOT_REGISTERED
 * (verified with a runtime probe against @nestjs/core 11.1.18).
 *
 * ## "Install" in the worker is hydration — `PluginInstallerService` is NOT bound
 *
 * Deliberately. In bundled mode it is inert (`ensurePluginAvailable` answers
 * null). In dynamic mode today it would trust — and WRITE — the API's shared
 * install-state row over the network, place files on an ephemeral machine, and
 * never register the plugin: no code loads a plugin after an install, and the
 * loader skips the symlink it creates. A worker-side installer for third-party
 * packages needs its own design (local fast path, no shared-row writes, register
 * the extracted directory). Until then a plugin that is not in the worker image
 * is answered PLUGIN_NOT_REGISTERED, naming that cause.
 *
 * `forRoot(options)` passes plugin options through to `TriggerPluginsModule`
 * (the task uses the defaults; the boot spec points `pluginPaths` at a fixture).
 */
@Module({})
export class TriggerRunPluginOperationModule {
    static forRoot(pluginOptions: PluginsModuleOptions = {}): DynamicModule {
        return {
            module: TriggerRunPluginOperationModule,
            imports: [
                TriggerPluginsModule.forRoot(pluginOptions),
                TriggerRemoteCacheModule.forRoot(),
            ],
        };
    }
}
