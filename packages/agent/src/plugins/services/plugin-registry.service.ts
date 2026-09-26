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
    isColdLazyPlugin,
    LazyPluginStub,
    OnFirstMaterialize,
    OnMaterializeError,
    PluginInstanceLoader,
} from './lazy-plugin-proxy';
import { pluginLoadFailure } from './plugin-operation.util';

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
 * How many plugins one fan-out loads at a time when nothing overrides it —
 * see {@link pluginLoadConcurrency}.
 */
export const DEFAULT_PLUGIN_LOAD_CONCURRENCY = 6;

/**
 * How many plugins one fan-out that loads plugins ({@link loadRegisteredPlugins},
 * {@link loadPluginSchemas}, {@link loadPluginsForListing}) imports at a time.
 *
 * The first load of a plugin is a dynamic import, its synchronous module
 * evaluation, the loader's manifest DB upsert (find + update + find) and its
 * `onLoad`. A plugins page or onboarding catalog over ~100 cold plugins used to
 * start all of them at once, queueing ~300 queries on the pool (pg's 10
 * connections, no wait timeout) and ~5 s of module evaluation in front of every
 * other request of the process.
 *
 * {@link DEFAULT_PLUGIN_LOAD_CONCURRENCY} (6) unless the `PLUGIN_LOAD_CONCURRENCY`
 * environment variable is a positive integer, which overrides it — read on each
 * fan-out, so it applies without a rebuild. The bound is per fan-out, not
 * process-wide: a process-wide pool would deadlock a load whose `onLoad` loads
 * another plugin while every slot is held.
 */
export function pluginLoadConcurrency(): number {
    const raw = process.env.PLUGIN_LOAD_CONCURRENCY?.trim();
    if (raw && /^\d+$/.test(raw)) {
        const parsed = Number.parseInt(raw, 10);
        if (parsed > 0) return parsed;
    }
    return DEFAULT_PLUGIN_LOAD_CONCURRENCY;
}

/**
 * `task` over `items` with at most `limit` running at a time (default
 * {@link pluginLoadConcurrency}), answering the results in `items` order. The
 * one bounded fan-out every plugin-loading list goes through.
 */
export async function mapWithPluginLoadLimit<T, R>(
    items: readonly T[],
    task: (item: T, index: number) => Promise<R>,
    limit: number = pluginLoadConcurrency(),
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index], index);
        }
    };
    const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
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
 * A plugin that is not a lazy proxy, or one whose plugin is imported already,
 * answers at once without importing or waiting. Otherwise the plugin is
 * imported (and its first-materialise hook — `onLoad` — runs, as on any first
 * use), and this resolves once that first load has settled. A reader reached
 * from inside the plugin's own `onLoad` (e.g. through `context.getSettings`)
 * finds it imported already, so this never waits on the `onLoad` calling it.
 *
 * That is also why this is for READING the schema only, never for picking a
 * plugin to use: a caller that arrives while another caller's first load is
 * still running (the plugin is imported before the hook has run `onLoad`) gets
 * `true` at once, before `onLoad` has settled — or failed. A caller that
 * selects or uses the plugin takes {@link loadRegisteredPlugins} or
 * `materializePlugin`, which wait for that first load.
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
 * {@link loadPluginSchema} over several registry entries, at most
 * {@link pluginLoadConcurrency} at a time; the results in `entries` order.
 */
export function loadPluginSchemas(entries: readonly RegisteredPlugin[]): Promise<boolean[]> {
    return mapWithPluginLoadLimit(entries, (entry) => loadPluginSchema(entry.plugin, entry));
}

/**
 * Load, for a LIST or CATALOG, the plugins whose class-only fields the list may
 * show or decide on: the `builtIn` ones among `entries` — those the boot
 * before lazy builtIns (60916d328) had loaded — and every entry in
 * `options.inUse`, whatever its `builtIn` flag. One bounded fan-out: at most
 * {@link pluginLoadConcurrency} at a time.
 *
 * `inUse` is what the list's viewer USES: the plugins the user has enabled
 * (the settings menu and settings page list exactly those), or the ones a Work
 * has enabled (its list picks the Work's capability providers from them). A
 * plugin in use is loaded when it is used anyway, and deciding on it by its
 * package.json manifest alone is wrong: notion-extractor declares
 * `supplementary` only in its class, and a cold `{}` schema has no settings to
 * show or configure.
 *
 * Any other plugin that is not `builtIn` and still cold stays cold: a list
 * shows its package.json manifest and the cold proxy's `{}` schema, exactly as
 * it did when disk builtIns loaded at boot. Loading it for a catalog would
 * import a plugin nobody uses and run its `onLoad` side effects
 * (github-storage's `onLoad` throws without its git-lfs binaries, putting it
 * in `error`). One already imported, or already in `error`, needs no load
 * either way. A caller that USES a plugin — its detail page, its settings, a
 * selection — loads it whatever its `builtIn` flag says.
 *
 * With `PLUGIN_EAGER_BUILTINS=true` every builtIn is loaded at boot, so only
 * the non-builtIns in use are loaded here.
 */
export async function loadPluginsForListing(
    entries: readonly RegisteredPlugin[],
    options: { readonly inUse?: readonly RegisteredPlugin[] } = {},
): Promise<void> {
    const toLoad = new Set(entries.filter((entry) => entry.builtIn));
    for (const entry of options.inUse ?? []) toLoad.add(entry);
    await loadPluginSchemas([...toLoad]);
}

/**
 * Whether a LIST leaves `entry`'s plugin as it is — a cold lazy proxy that
 * {@link loadPluginsForListing} did not load (not `builtIn`, and not in use by
 * the list's viewer, so still cold). Anything the list would otherwise read
 * through a service that loads the plugin (the settings service's resolution)
 * is skipped for it: with the cold `{}` schema it projects nothing anyway.
 */
export function staysColdForListing(entry: Pick<RegisteredPlugin, 'plugin' | 'builtIn'>): boolean {
    return !entry.builtIn && isColdLazyPlugin(entry.plugin);
}

/**
 * Load several registry entries for USE, answering — in their order — the ones
 * that are still `loaded` once their first load has SETTLED. At most
 * {@link pluginLoadConcurrency} load at a time.
 *
 * For a caller that picks among candidates by what only the plugin class knows
 * (its schema, its configuration mode, the manifest fields its `getManifest()`
 * adds) and must skip a candidate that cannot load, exactly as it would have
 * skipped one whose load failed at boot. Pass only the entries the caller may
 * actually use (e.g. those enabled for the scope): each one is imported. An
 * entry not `loaded` beforehand is left out without being loaded (again).
 *
 * Unlike {@link loadPluginSchema}, this WAITS for a first load another caller
 * started: a lazy proxy is imported before its first-materialise hook has run
 * `onLoad` (and the loader's manifest DB upsert), so without the wait a second
 * caller inside that window would be answered a plugin whose `onLoad` has not
 * run — or is about to fail and put the entry in `error`. Called from inside a
 * plugin's own `onLoad` for that same plugin, the wait would be on itself: that
 * entry is then left out (the proxy refuses the wait rather than hang).
 */
export async function loadRegisteredPlugins(
    entries: readonly RegisteredPlugin[],
): Promise<RegisteredPlugin[]> {
    const loaded = await mapWithPluginLoadLimit(entries, (entry) =>
        entry.state === 'loaded' ? loadForUse(entry.plugin) : Promise.resolve(false),
    );
    return entries.filter((entry, index) => loaded[index] && entry.state === 'loaded');
}

/**
 * Materialise `plugin` and wait until its first load — `onLoad` included — has
 * settled (`__materialize({ waitForLoad: true })`). `false` when the import
 * fails (or the proxy refuses a wait on itself); an `onLoad` failure resolves
 * `true` here and shows as the entry's `error` state, which
 * {@link loadRegisteredPlugins} checks afterwards.
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
        // The entry, once registered below: a method call that waited through
        // the proxy for the first load is refused when that load put it in
        // `error` (a failing onLoad — callOnLoad records it here).
        let entry: RegisteredPlugin | undefined;
        const stub: LazyPluginStub = createLazyPluginProxy(
            manifest,
            loader,
            options?.onFirstMaterialize,
            options?.onMaterializeError,
            () => pluginLoadFailure(entry, manifest.id),
        );
        entry = this.register(stub, manifest, {
            builtIn: options?.builtIn,
            installPath: options?.installPath,
            state: 'loaded',
        });
        return entry;
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
