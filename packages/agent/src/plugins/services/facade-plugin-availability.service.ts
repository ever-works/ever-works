import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import { PluginRepository } from '../repositories/plugin.repository';
import { PluginRegistryService, type RegisteredPlugin } from './plugin-registry.service';
import { PluginInstallerService } from './plugin-installer.service';
import { PluginLoaderService } from './plugin-loader.service';
import { materializePlugin, pluginLoadFailure } from './plugin-operation.util';

/** How long a plugin that could not be made available is not asked for again. */
const MISS_BACKOFF_MS = 60_000;

/**
 * The most misses remembered at once. The ids come from requests (an explicit
 * provider override, e.g. `x-provider-override`), so without a bound a caller
 * sending many made-up ids would grow the list for good. Past the bound the
 * oldest miss is forgotten first — it is then simply looked up again.
 */
const MAX_MISSES = 1_000;

/**
 * EW-693 T26 / FR-15 (owner decision 2026-09-25) — install-on-use for facades.
 *
 * In `dynamic` distribution mode a plugin can be installed on one replica
 * (the one that handled the enable) and absent from another. A facade that
 * resolves such a plugin BY ID — an explicit provider override, or the Work's
 * active plugin — asks this service for it (`BaseFacadeService.resolvePlugin`).
 * It asks the installer to place the pinned version on THIS replica
 * (`ensureLocalInstall`), registers the directory it answers
 * (`loader.registerFromPath`), loads it, then reads the registry again; that
 * entry is what the facade uses (in-process, FR-15).
 *
 * Off unless BOTH hold, so bundled deployments and dynamic ones that set
 * nothing see no change (FR-22):
 * - `PluginsModuleOptions.distributionMode === 'dynamic'`, and
 * - `PluginsModuleOptions.facadeInstallOnUse === true`
 *   (`PLUGIN_FACADE_INSTALL_ON_USE` on the API).
 *
 * Only a plugin the platform already installed AND pinned is asked for — a
 * `registry`-sourced plugin row in state `installed` with its `registrySpec`
 * and `installedVersion`. An id a request made up, a plugin nobody enabled, or
 * a row with no pin never reaches the installer: enabling stays the install
 * step (FR-21), and a facade call never performs a first-ever install, an
 * unpinned (`@latest`) install, or an outbound fetch for an unknown package.
 *
 * `ensureLocalInstall` also requires the row's `integrity` (FR-10) and admits
 * only first-party or allowlisted packages (FR-11) — both before any download
 * — and it NEVER writes the shared row: a facade call can neither mark a
 * plugin installed nor flip it to `error` for every replica.
 *
 * It never throws. A lookup, install or registration failure is logged and
 * answered as "absent" — the facade then answers exactly as it would have
 * without it — and that plugin is not asked for again for 60 s. At most 1,000
 * misses are remembered; past that the oldest is forgotten first. A plugin
 * whose `onLoad` fails while loading is answered as absent too.
 *
 * (Until EW-693 T27 the switch was inert: the service called
 * `ensurePluginAvailable`, which trusted the shared row — nothing was fetched
 * on a replica that had not run the install — and nothing registered the
 * plugin.)
 */
@Injectable()
export class FacadePluginAvailabilityService {
    private readonly logger = new Logger(FacadePluginAvailabilityService.name);
    private readonly switchedOn: boolean;
    /**
     * pluginId → epoch ms until which a miss is answered without asking again.
     * Insertion order is expiry order (every entry gets the same backoff, and
     * a re-recorded miss is moved to the end), so the oldest is always first.
     */
    private readonly misses = new Map<string, number>();

    constructor(
        @Inject(PLUGINS_MODULE_OPTIONS)
        options: PluginsModuleOptions,
        private readonly registry: PluginRegistryService,
        private readonly pluginRepository: PluginRepository,
        @Optional()
        private readonly installer?: PluginInstallerService,
        @Optional()
        private readonly loader?: PluginLoaderService,
    ) {
        this.switchedOn =
            options?.distributionMode === 'dynamic' && options?.facadeInstallOnUse === true;
    }

    /** Whether a facade miss may be installed on use in this process. */
    isEnabled(): boolean {
        return this.switchedOn && !!this.installer;
    }

    /**
     * The plugin registered as `pluginId` in this process — after installing
     * it on this replica and registering it when it is absent and
     * {@link isEnabled}. `undefined` = absent.
     */
    async ensureRegistered(pluginId: string): Promise<RegisteredPlugin | undefined> {
        const registered = this.registry.get(pluginId);
        if (registered || !this.isEnabled()) return registered;

        const until = this.misses.get(pluginId);
        if (until !== undefined) {
            if (Date.now() < until) return undefined;
            this.misses.delete(pluginId);
        }

        let row: Awaited<ReturnType<PluginRepository['findByPluginId']>>;
        try {
            row = await this.pluginRepository.findByPluginId(pluginId);
        } catch (err) {
            this.logger.warn(
                `Install-on-use: could not read the plugin row for "${pluginId}" (${errorText(err)}).`,
            );
            return this.miss(pluginId);
        }
        if (
            !row ||
            row.source !== 'registry' ||
            row.installState !== 'installed' ||
            !row.registrySpec ||
            !row.installedVersion
        ) {
            return this.miss(pluginId);
        }

        try {
            // T27: the pinned version, into THIS replica's store; no row write.
            const local = await this.installer!.ensureLocalInstall(pluginId);
            if (!this.registry.get(pluginId)) {
                if (!this.loader) {
                    this.logger.warn(
                        `Install-on-use: plugin "${pluginId}" is installed on this replica, but no ` +
                            'plugin loader is bound to register it; the facade resolves without it.',
                    );
                    return this.miss(pluginId);
                }
                const loaded = await this.loader.registerFromPath(local.installPath, {
                    expectedId: pluginId,
                });
                if (!loaded.success) {
                    this.logger.warn(
                        `Install-on-use: plugin "${pluginId}" could not be registered: ${loaded.error}`,
                    );
                    return this.miss(pluginId);
                }
            }
        } catch (err) {
            this.logger.warn(`Install-on-use of plugin "${pluginId}" failed: ${errorText(err)}`);
            return this.miss(pluginId);
        }

        const after = this.registry.get(pluginId);
        if (!after) {
            this.logger.warn(
                `Install-on-use: plugin "${pluginId}" is installed but not registered in this process; ` +
                    'the facade resolves without it.',
            );
            return this.miss(pluginId);
        }
        // Load it now: facades and the settings paths read
        // `plugin.settingsSchema` synchronously, and a cold lazy proxy answers
        // `{}` for it. A load (or `onLoad`) failure lands on the entry.
        try {
            await materializePlugin(after.plugin);
        } catch {
            // Recorded on the entry by the loader's failure hook; checked below.
        }
        const failure = pluginLoadFailure(after, pluginId);
        if (failure) {
            this.logger.warn(`Install-on-use: ${failure}; the facade resolves without it.`);
            return this.miss(pluginId);
        }
        return after;
    }

    /**
     * Remember a miss for {@link MISS_BACKOFF_MS}: drop the misses that have
     * expired, then — if the list is still full — the oldest, so it never holds
     * more than {@link MAX_MISSES}.
     */
    private miss(pluginId: string): undefined {
        const now = Date.now();
        for (const [id, until] of this.misses) {
            if (until > now) break;
            this.misses.delete(id);
        }
        this.misses.delete(pluginId);
        while (this.misses.size >= MAX_MISSES) {
            const oldest = this.misses.keys().next().value as string;
            this.misses.delete(oldest);
        }
        this.misses.set(pluginId, now + MISS_BACKOFF_MS);
        return undefined;
    }
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
