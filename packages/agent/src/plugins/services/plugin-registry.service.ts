import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
    IPlugin,
    PluginManifest,
    PluginCategory,
    PluginState,
    PluginRuntimeInfo,
    PluginStateTransition,
} from '@ever-works/plugin';
import { PluginEvents } from '../plugins.constants';
import { WorkPluginRepository } from '../repositories/work-plugin.repository';
import { UserPluginRepository } from '../repositories/user-plugin.repository';
import { hasActiveCapability } from '../utils/active-capabilities.util';
import {
    createLazyPluginProxy,
    LazyPluginStub,
    OnFirstMaterialize,
    OnMaterializeError,
    PluginInstanceLoader,
} from './lazy-plugin-proxy';

export interface PluginEnableContext {
    systemPlugin?: boolean;
    autoEnable?: boolean;
    userPlugin?: { enabled: boolean; autoEnableForWorks?: boolean } | null;
    workPlugin?: { enabled: boolean } | null;
    hasWorkContext: boolean;
}

/**
 * Pure enable-resolution algorithm. Single source of truth.
 *
 * Priority:
 * 1. System plugins → always enabled
 * 2. User-level DISABLE → cascades globally
 * 3. Work explicit record → use its enabled value
 * 4. User autoEnableForWorks (work context) → true
 * 5. User record exists → enabled outside work, false inside work
 * 6. Fallback to manifest autoEnable (default false)
 */
export function resolvePluginEnabled(ctx: PluginEnableContext): boolean {
    if (ctx.systemPlugin) return true;
    if (ctx.userPlugin !== undefined && ctx.userPlugin !== null && !ctx.userPlugin.enabled)
        return false;
    if (ctx.hasWorkContext && ctx.workPlugin !== undefined && ctx.workPlugin !== null)
        return ctx.workPlugin.enabled;
    if (ctx.hasWorkContext && ctx.userPlugin?.autoEnableForWorks) return true;
    if (ctx.userPlugin !== undefined && ctx.userPlugin !== null) {
        // In work context, user-level enabled does NOT cascade to works
        // unless autoEnableForWorks is true (already checked above).
        if (ctx.hasWorkContext) return false;
        return ctx.userPlugin.enabled;
    }
    return ctx.autoEnable ?? false;
}

/**
 * Make `plugin.settingsSchema` and `plugin.configurationMode` answer the plugin
 * CLASS's values before a caller reads them synchronously.
 *
 * The registry holds every plugin discovered on disk as a lazy proxy
 * (`lazy-plugin-proxy.ts`). Until the proxy materialises, it answers `{}` for
 * the schema and `undefined` for the configuration mode — the package.json
 * manifest carries neither — so a reader sees no fields, no `required` list,
 * no `x-envVar` / `x-secret` / `x-scope` markers and the `hybrid` default.
 * Await this first.
 *
 * A plugin that is not a lazy proxy, or one that has materialised, answers at
 * once without importing anything. Otherwise the plugin is imported (and its
 * first-materialise hook — `onLoad` — runs, as on any first use). A reader
 * reached from inside the plugin's own `onLoad` (e.g. through
 * `context.getSettings`) finds it materialised already, so this never waits
 * on the `onLoad` that is calling it.
 *
 * That is also why this is for READING the schema only, never for picking a
 * plugin to use: a caller that arrives while another caller's first load is
 * still running (the proxy is marked materialised before the hook has run
 * `onLoad`) gets `true` at once, before `onLoad` has settled — or failed. A
 * caller that selects or uses the plugin takes {@link loadRegisteredPlugins},
 * which waits for that first load.
 *
 * The same load brings the rest of what only the class knows onto the
 * registry entry: the loader folds the class's `getManifest()` into the
 * entry's manifest in the same synchronous step that marks the proxy
 * materialised (icon, `uiHints`, `visibility`, `defaultForCapabilities`,
 * `supplementary`, `selectableProviderCategories` — whatever package.json
 * leaves unset), and a failing `onLoad` leaves the entry in `error`.
 *
 * @param entry - the plugin's registry entry, when the caller has it. An entry
 *   already in `error` is not loaded again (answers `false`): a proxy whose
 *   import failed resets itself, so every read would re-run the import and the
 *   failure hook (another `error` write to the database, another state-history
 *   entry, another STATE_CHANGED event) — and could not bring the plugin back
 *   anyway, as `callOnLoad` refuses a plugin in `error`.
 * @returns `false` when the plugin cannot be materialised, or `entry` is in
 *   `error`. On a failed import the proxy's failure hook has recorded `error`
 *   on the registry entry and the schema reads stay cold, so a caller should
 *   treat the plugin as unusable — as the readiness filters skip any entry in
 *   `error`.
 */
export async function loadPluginSchema(
    plugin: unknown,
    entry?: Pick<RegisteredPlugin, 'state'>,
): Promise<boolean> {
    if (entry?.state === 'error') return false;
    const lazy = plugin as Partial<Pick<LazyPluginStub, '__isMaterialized' | '__materialize'>>;
    if (!lazy || typeof lazy.__materialize !== 'function' || lazy.__isMaterialized === true) {
        return true;
    }
    try {
        await lazy.__materialize();
        return true;
    } catch {
        return false;
    }
}

/**
 * Load several registry entries (in parallel) for USE, answering — in their
 * order — the ones that are still `loaded` once their first load has SETTLED.
 *
 * For a caller that picks among candidates by what only the plugin class knows
 * (its schema, its configuration mode, the manifest fields its `getManifest()`
 * adds) and must skip a candidate that cannot load, exactly as it would have
 * skipped one whose load failed at boot. Pass only the entries the caller may
 * actually use (e.g. those enabled for the scope): each one is imported. An
 * entry not `loaded` beforehand is left out without being loaded (again).
 *
 * Unlike {@link loadPluginSchema}, this WAITS for a first load another caller
 * started: a lazy proxy marks itself materialised before its first-materialise
 * hook has awaited the loader's manifest DB upsert and run `onLoad`, so without
 * the wait a second caller inside that window would be answered a plugin whose
 * `onLoad` has not run — or is about to fail and put the entry in `error`.
 * Never call it from inside a plugin's own `onLoad` for that same plugin: it
 * would wait on itself (settings reads from `onLoad` go through
 * {@link loadPluginSchema}, which does not wait).
 */
export async function loadRegisteredPlugins(
    entries: readonly RegisteredPlugin[],
): Promise<RegisteredPlugin[]> {
    const loaded = await Promise.all(
        entries.map((entry) => (entry.state === 'loaded' ? loadForUse(entry.plugin) : false)),
    );
    return entries.filter((entry, index) => loaded[index] && entry.state === 'loaded');
}

/**
 * Materialise `plugin` and wait until its first load — `onLoad` included — has
 * settled (`__materialize({ waitForLoad: true })`). `false` when the import
 * fails; an `onLoad` failure resolves `true` here and shows as the entry's
 * `error` state, which {@link loadRegisteredPlugins} checks afterwards.
 */
async function loadForUse(plugin: unknown): Promise<boolean> {
    const lazy = plugin as Partial<Pick<LazyPluginStub, '__materialize'>>;
    if (!lazy || typeof lazy.__materialize !== 'function') return true;
    try {
        await lazy.__materialize({ waitForLoad: true });
        return true;
    } catch {
        return false;
    }
}

export interface RegisteredPlugin {
    plugin: IPlugin;
    manifest: PluginManifest;
    state: PluginState;
    builtIn: boolean;
    installPath?: string;
    registeredAt: number;
    loadedAt?: number;
    stateHistory: PluginStateTransition[];
    error?: Error | string;
}

/**
 * In-memory registry of loaded plugins with fast lookups by ID, category, and capability.
 */
@Injectable()
export class PluginRegistryService {
    private readonly logger = new Logger(PluginRegistryService.name);
    private readonly plugins = new Map<string, RegisteredPlugin>();
    private readonly byCategory = new Map<PluginCategory, Set<string>>();
    private readonly byCapability = new Map<string, Set<string>>();

    constructor(
        private readonly eventEmitter: EventEmitter2,
        @Optional() private readonly workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly userPluginRepository?: UserPluginRepository,
    ) {}

    /**
     * Register a manifest-only stub backed by a lazy loader. The real plugin
     * module is not imported until the first method call on the returned
     * stub (or an explicit `__materialize()` call), at which point
     * `onFirstMaterialize` runs exactly once to drive the lifecycle hooks.
     *
     * Category / capability indexes are populated immediately so discovery
     * queries (`getByCapability`, `getByCategory`) work without forcing a
     * load. The registered state is `'loaded'` so existing readiness filters
     * keep working — lazy materialization is invisible to consumers.
     */
    registerLazy(
        manifest: PluginManifest,
        loader: PluginInstanceLoader,
        options?: {
            builtIn?: boolean;
            installPath?: string;
            onFirstMaterialize?: OnFirstMaterialize;
            onMaterializeError?: OnMaterializeError;
        },
    ): RegisteredPlugin {
        if (this.plugins.has(manifest.id)) {
            throw new Error(`Plugin "${manifest.id}" is already registered`);
        }
        const stub: LazyPluginStub = createLazyPluginProxy(
            manifest,
            loader,
            options?.onFirstMaterialize,
            options?.onMaterializeError,
        );
        return this.register(stub, manifest, {
            builtIn: options?.builtIn,
            installPath: options?.installPath,
            state: 'loaded',
        });
    }

    /**
     * Replace the in-memory manifest for a registered plugin. Used after
     * lazy materialization to fold in fields the plugin class fills in
     * via `getManifest()` (icon, homepage, readme, etc.) that the package.json
     * manifest didn't carry. Capability / category indexes are not touched —
     * the runtime manifest can only enrich, not change those.
     */
    updateRegisteredManifest(pluginId: string, manifest: PluginManifest): boolean {
        const registered = this.plugins.get(pluginId);
        if (!registered) return false;
        registered.manifest = manifest;
        return true;
    }

    register(
        plugin: IPlugin,
        manifest: PluginManifest,
        options?: {
            builtIn?: boolean;
            installPath?: string;
            state?: PluginState;
        },
    ): RegisteredPlugin {
        const pluginId = plugin.id;

        if (this.plugins.has(pluginId)) {
            throw new Error(`Plugin "${pluginId}" is already registered`);
        }

        const registered: RegisteredPlugin = {
            plugin,
            manifest,
            state: options?.state || 'unloaded',
            builtIn: options?.builtIn || false,
            installPath: options?.installPath,
            registeredAt: Date.now(),
            stateHistory: [
                {
                    from: 'unloaded',
                    to: options?.state || 'unloaded',
                    timestamp: Date.now(),
                },
            ],
        };

        this.plugins.set(pluginId, registered);

        if (!this.byCategory.has(manifest.category)) {
            this.byCategory.set(manifest.category, new Set());
        }
        this.byCategory.get(manifest.category)!.add(pluginId);

        for (const capability of manifest.capabilities) {
            if (!this.byCapability.has(capability)) {
                this.byCapability.set(capability, new Set());
            }
            this.byCapability.get(capability)!.add(pluginId);
        }

        this.logger.log(`Registered plugin: ${pluginId} v${manifest.version}`);

        this.eventEmitter.emit(PluginEvents.REGISTERED, {
            pluginId,
            version: manifest.version,
            category: manifest.category,
            capabilities: manifest.capabilities,
            timestamp: Date.now(),
        });

        return registered;
    }

    unregister(pluginId: string): boolean {
        const registered = this.plugins.get(pluginId);
        if (!registered) {
            return false;
        }

        const categorySet = this.byCategory.get(registered.manifest.category);
        if (categorySet) {
            categorySet.delete(pluginId);
            if (categorySet.size === 0) {
                this.byCategory.delete(registered.manifest.category);
            }
        }

        for (const capability of registered.manifest.capabilities) {
            const capabilitySet = this.byCapability.get(capability);
            if (capabilitySet) {
                capabilitySet.delete(pluginId);
                if (capabilitySet.size === 0) {
                    this.byCapability.delete(capability);
                }
            }
        }

        this.plugins.delete(pluginId);

        this.logger.log(`Unregistered plugin: ${pluginId}`);

        this.eventEmitter.emit(PluginEvents.UNREGISTERED, {
            pluginId,
            timestamp: Date.now(),
        });

        return true;
    }

    get(pluginId: string): RegisteredPlugin | undefined {
        return this.plugins.get(pluginId);
    }

    getPlugin(pluginId: string): IPlugin | undefined {
        return this.plugins.get(pluginId)?.plugin;
    }

    has(pluginId: string): boolean {
        return this.plugins.has(pluginId);
    }

    getAll(): RegisteredPlugin[] {
        return Array.from(this.plugins.values());
    }

    getPluginIds(): string[] {
        return Array.from(this.plugins.keys());
    }

    getByCategory(category: PluginCategory): RegisteredPlugin[] {
        const pluginIds = this.byCategory.get(category);
        if (!pluginIds) {
            return [];
        }
        return Array.from(pluginIds)
            .map((id) => this.plugins.get(id))
            .filter((p): p is RegisteredPlugin => p !== undefined);
    }

    getByCapability(capability: string): RegisteredPlugin[] {
        const pluginIds = this.byCapability.get(capability);
        if (!pluginIds) {
            return [];
        }
        return Array.from(pluginIds)
            .map((id) => this.plugins.get(id))
            .filter((p): p is RegisteredPlugin => p !== undefined);
    }

    /**
     * Notifications v2 (EW-650) — convenience discovery for the
     * EmailFacadeService. Returns every loaded plugin that declares
     * the EMAIL_OUTBOUND capability.
     */
    getOutboundEmailProviders(): RegisteredPlugin[] {
        return this.getByCapability('email-outbound').filter((p) => p.state === 'loaded');
    }

    /**
     * Notifications v2 (EW-650) — convenience discovery for the
     * email inbound webhook controller. Returns every loaded plugin
     * that declares the EMAIL_INBOUND capability.
     */
    getInboundEmailProviders(): RegisteredPlugin[] {
        return this.getByCapability('email-inbound').filter((p) => p.state === 'loaded');
    }

    /**
     * Notifications v2 (sibling of EW-650) — convenience discovery
     * for the NotificationChannelFacadeService. Returns every loaded
     * plugin that declares the umbrella NOTIFICATION_CHANNEL
     * capability (Discord / Slack / Telegram / WhatsApp / Novu / …).
     */
    getNotificationChannelProviders(): RegisteredPlugin[] {
        return this.getByCapability('notification-channel').filter((p) => p.state === 'loaded');
    }

    /**
     * Returns first ready plugin with this capability in defaultForCapabilities.
     *
     * Synchronous, so it reads each entry's manifest as registered: a plugin
     * still cold (a lazy proxy nothing has used yet) carries only its
     * package.json manifest, without the `defaultForCapabilities` its class's
     * `getManifest()` may add. Prefer {@link getDefaultForCapabilityScoped},
     * which loads its candidates first.
     */
    getDefaultForCapability(capability: string): RegisteredPlugin | undefined {
        const plugins = this.getByCapability(capability);
        const readyPlugins = plugins.filter((p) => p.state === 'loaded');

        return readyPlugins.find((p) => p.manifest.defaultForCapabilities?.includes(capability));
    }

    /** Get all plugins in the 'loaded' (ready) state */
    getReady(): RegisteredPlugin[] {
        return Array.from(this.plugins.values()).filter((p) => p.state === 'loaded');
    }

    getByState(state: PluginState): RegisteredPlugin[] {
        return Array.from(this.plugins.values()).filter((p) => p.state === state);
    }

    getBuiltIn(): RegisteredPlugin[] {
        return Array.from(this.plugins.values()).filter((p) => p.builtIn);
    }

    updateState(pluginId: string, newState: PluginState, error?: Error | string): boolean {
        const registered = this.plugins.get(pluginId);
        if (!registered) {
            return false;
        }

        const oldState = registered.state;
        registered.state = newState;
        registered.stateHistory.push({
            from: oldState,
            to: newState,
            timestamp: Date.now(),
            error: error instanceof Error ? error.message : error,
        });

        if (newState === 'loaded') {
            registered.loadedAt = Date.now();
        }

        if (error) {
            registered.error = error;
        } else if (newState !== 'error') {
            registered.error = undefined;
        }

        this.eventEmitter.emit(PluginEvents.STATE_CHANGED, {
            pluginId,
            oldState,
            newState,
            error: error instanceof Error ? error.message : error,
            timestamp: Date.now(),
        });

        return true;
    }

    getRuntimeInfo(pluginId: string): PluginRuntimeInfo | undefined {
        const registered = this.plugins.get(pluginId);
        if (!registered) {
            return undefined;
        }

        return {
            pluginId,
            state: registered.state,
            stateHistory: registered.stateHistory,
            loadedAt: registered.loadedAt,
            error: registered.error,
        };
    }

    getVersionsMap(): Map<string, { version: string }> {
        const map = new Map<string, { version: string }>();
        for (const [id, registered] of this.plugins) {
            map.set(id, { version: registered.manifest.version });
        }
        return map;
    }

    count(): number {
        return this.plugins.size;
    }

    getAvailableCategories(): PluginCategory[] {
        return Array.from(this.byCategory.keys());
    }

    getAvailableCapabilities(): string[] {
        return Array.from(this.byCapability.keys());
    }

    clear(): void {
        this.plugins.clear();
        this.byCategory.clear();
        this.byCapability.clear();
        this.logger.warn('Registry cleared');
    }

    /** Get default plugin for capability with scope resolution (work > user > manifest) */
    async getDefaultForCapabilityScoped(
        capability: string,
        workId?: string,
        userId?: string,
    ): Promise<RegisteredPlugin | undefined> {
        const plugins = this.getByCapability(capability);
        const enabledPlugins = plugins.filter((p) => p.state === 'loaded');

        // Every candidate returned below is loaded first (loadRegisteredPlugins):
        // a plugin nobody has used yet is a cold lazy proxy whose entry lacks
        // the `defaultForCapabilities` its class's getManifest() may add, and
        // whose import or onLoad may yet fail — a failure found here puts it in
        // `error` and it is skipped, as it would have been had it failed at boot.
        // A first load another request started is waited for, onLoad included.
        if (workId && this.workPluginRepository) {
            for (const registered of enabledPlugins) {
                try {
                    const dp = await this.workPluginRepository.findByWorkAndPlugin(
                        workId,
                        registered.plugin.id,
                    );
                    if (
                        dp?.enabled &&
                        hasActiveCapability(dp, capability) &&
                        (await loadRegisteredPlugins([registered])).length > 0
                    ) {
                        return registered;
                    }
                } catch {
                    // Continue
                }
            }
        }

        const enabledForScope: RegisteredPlugin[] = [];
        for (const registered of enabledPlugins) {
            const isEnabled = await this.isPluginEnabledForScope(
                registered.plugin.id,
                workId,
                userId,
            );
            if (isEnabled) {
                enabledForScope.push(registered);
            }
        }

        const usable = await loadRegisteredPlugins(enabledForScope);
        return (
            usable.find((registered) =>
                registered.manifest.defaultForCapabilities?.includes(capability),
            ) ?? usable[0]
        );
    }

    /**
     * The `loaded` plugins (for `capability`, or all) enabled for the scope.
     *
     * Each returned entry has materialised and finished its first load, onLoad
     * included — one another caller started is waited for
     * ({@link loadRegisteredPlugins}):
     * callers pick a provider by reading `settingsSchema` / `configurationMode`
     * (its required settings, its `x-envVar` bindings) and manifest fields such
     * as `defaultForCapabilities` synchronously, which a cold lazy proxy
     * answers with `{}` / `undefined` / the package.json manifest alone. An
     * entry that cannot be materialised, or whose onLoad fails, is left out —
     * it is now in `error`, the state every readiness filter skips.
     */
    async getEnabledPluginsScoped(
        capability?: string,
        workId?: string,
        userId?: string,
    ): Promise<RegisteredPlugin[]> {
        const plugins = capability ? this.getByCapability(capability) : this.getReady();
        const result: RegisteredPlugin[] = [];

        for (const registered of plugins) {
            if (registered.state !== 'loaded') continue;

            const isEnabled = await this.isPluginEnabledForScope(
                registered.plugin.id,
                workId,
                userId,
            );
            if (isEnabled) {
                result.push(registered);
            }
        }

        return loadRegisteredPlugins(result);
    }

    /**
     * Check if plugin is enabled for scope.
     * Fetches DB records then delegates to resolvePluginEnabled().
     */
    async isPluginEnabledForScope(
        pluginId: string,
        workId?: string,
        userId?: string,
    ): Promise<boolean> {
        const registered = this.plugins.get(pluginId);

        let userPlugin = null;
        if (userId && this.userPluginRepository) {
            try {
                userPlugin = await this.userPluginRepository.findByUserAndPlugin(userId, pluginId);
            } catch {
                // Continue
            }
        }

        let workPlugin = null;
        if (workId && this.workPluginRepository) {
            try {
                workPlugin = await this.workPluginRepository.findByWorkAndPlugin(workId, pluginId);
            } catch {
                // Continue
            }
        }

        return resolvePluginEnabled({
            systemPlugin: registered?.manifest?.systemPlugin,
            autoEnable: registered?.manifest?.autoEnable,
            userPlugin,
            workPlugin,
            hasWorkContext: !!workId,
        });
    }
}
