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
 * Loader callback used by lazy-registered plugins. Returns the
 * fully-constructed IPlugin instance — invoked at most once per
 * plugin id (memoized by `ensureLoaded`), the first time something
 * actually needs the runtime.
 */
export type LazyPluginLoader = (pluginId: string) => Promise<IPlugin>;

/**
 * Optional hook the bootstrap layer wires onto the registry so the
 * lazy-load path can fire `onLoad` lifecycle after `ensureLoaded`
 * constructs the plugin. Kept as an injected callback (not a direct
 * dep on PluginLifecycleManagerService) so the registry stays a
 * leaf-level service with no upward NestJS dependency.
 */
export type PluginPostLoadHook = (pluginId: string) => Promise<void>;

export interface RegisteredPlugin {
    /**
     * The plugin runtime instance. Eager-registered plugins always
     * have this set; lazy-registered plugins leave it `undefined`
     * until `ensureLoaded` fires the deferred `import()` and stores
     * the constructed instance here.
     */
    plugin?: IPlugin;
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

    /**
     * Lazy-load support: deferred constructor + memoised resolution
     * promise per plugin id. Populated by `registerLazy`; drained by
     * `ensureLoaded`. Eager-registered plugins (system plugins, tests,
     * pre-constructed built-ins) never touch these maps.
     */
    private readonly lazyLoaders = new Map<string, LazyPluginLoader>();
    private readonly loadPromises = new Map<string, Promise<IPlugin>>();
    private postLoadHook: PluginPostLoadHook | null = null;

    constructor(
        private readonly eventEmitter: EventEmitter2,
        @Optional() private readonly workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly userPluginRepository?: UserPluginRepository,
    ) {}

    /**
     * Wire the post-load hook (typically `lifecycleManager.callOnLoad`)
     * so lazy-loaded plugins fire `onLoad` after construction. Eager
     * mode doesn't use this — the bootstrap iterates `callOnLoad` itself.
     */
    setPostLoadHook(hook: PluginPostLoadHook | null): void {
        this.postLoadHook = hook;
    }

    /**
     * Register a plugin manifest with a deferred loader. The plugin
     * code is NOT imported here — the entry is added to the indices
     * (by-id / by-category / by-capability) using manifest fields only,
     * and the `loader` is parked for the first `ensureLoaded(id)` call.
     *
     * Use this in place of `register()` for any plugin you don't need
     * fully constructed at boot. The first runtime consumer (typically
     * a facade calling `ensureLoaded` from `resolvePlugin`) triggers
     * the deferred `import()`.
     */
    registerLazy(
        manifest: PluginManifest,
        loader: LazyPluginLoader,
        options?: {
            builtIn?: boolean;
            installPath?: string;
        },
    ): RegisteredPlugin {
        const pluginId = manifest.id;

        if (this.plugins.has(pluginId)) {
            throw new Error(`Plugin "${pluginId}" is already registered`);
        }

        const registered: RegisteredPlugin = {
            plugin: undefined,
            manifest,
            state: 'unloaded',
            builtIn: options?.builtIn || false,
            installPath: options?.installPath,
            registeredAt: Date.now(),
            stateHistory: [
                {
                    from: 'unloaded',
                    to: 'unloaded',
                    timestamp: Date.now(),
                },
            ],
        };

        this.plugins.set(pluginId, registered);
        this.lazyLoaders.set(pluginId, loader);

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

        this.logger.debug(`Registered lazy plugin: ${pluginId} v${manifest.version}`);

        this.eventEmitter.emit(PluginEvents.REGISTERED, {
            pluginId,
            version: manifest.version,
            category: manifest.category,
            capabilities: manifest.capabilities,
            timestamp: Date.now(),
            lazy: true,
        });

        return registered;
    }

    /**
     * Materialise a lazy-registered plugin: invoke the deferred loader,
     * attach the resulting IPlugin to the registry entry, transition
     * state to `loaded`, and fire the post-load hook (typically
     * `onLoad`). Subsequent calls return the cached instance instantly.
     *
     * Throws if the plugin id is unknown, or rejects with the loader's
     * error if the deferred import fails (state transitions to `error`).
     * Failed loads are NOT retried — the rejected promise is kept so
     * repeat callers see the same failure deterministically.
     *
     * For eager-registered plugins this is a no-op fast path: the
     * cached `plugin` is returned without any extra work.
     */
    async ensureLoaded(pluginId: string): Promise<IPlugin> {
        const registered = this.plugins.get(pluginId);
        if (!registered) {
            throw new Error(`Plugin "${pluginId}" is not registered`);
        }

        if (registered.state === 'loaded' && registered.plugin) {
            return registered.plugin;
        }

        if (registered.state === 'error') {
            throw new Error(
                `Plugin "${pluginId}" previously failed to load: ${
                    registered.error instanceof Error
                        ? registered.error.message
                        : registered.error ?? 'unknown error'
                }`,
            );
        }

        const cached = this.loadPromises.get(pluginId);
        if (cached) return cached;

        const loader = this.lazyLoaders.get(pluginId);
        if (!loader) {
            throw new Error(
                `Plugin "${pluginId}" has no lazy loader registered ` +
                    `(state=${registered.state}, plugin=${registered.plugin ? 'present' : 'missing'})`,
            );
        }

        this.updateState(pluginId, 'loading');

        const promise = (async () => {
            const plugin = await loader(pluginId);
            registered.plugin = plugin;
            this.updateState(pluginId, 'loaded');
            if (this.postLoadHook) {
                await this.postLoadHook(pluginId);
            }
            return plugin;
        })().catch((error) => {
            this.loadPromises.delete(pluginId);
            this.updateState(pluginId, 'error', error as Error);
            throw error;
        });

        this.loadPromises.set(pluginId, promise);
        return promise;
    }

    /**
     * `true` when the plugin id was registered lazily (has a parked
     * loader). Caller-side gate for "should I call ensureLoaded
     * before reading `.plugin`?". Eager registrations return `false`.
     */
    isLazy(pluginId: string): boolean {
        return this.lazyLoaders.has(pluginId);
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
        this.lazyLoaders.delete(pluginId);
        this.loadPromises.delete(pluginId);

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

    /** Returns first ready plugin with this capability in defaultForCapabilities */
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
        this.lazyLoaders.clear();
        this.loadPromises.clear();
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

        if (workId && this.workPluginRepository) {
            for (const registered of enabledPlugins) {
                try {
                    const dp = await this.workPluginRepository.findByWorkAndPlugin(
                        workId,
                        registered.plugin.id,
                    );
                    if (dp?.enabled && hasActiveCapability(dp, capability)) {
                        return registered;
                    }
                } catch {
                    // Continue
                }
            }
        }

        for (const registered of enabledPlugins) {
            const isEnabled = await this.isPluginEnabledForScope(
                registered.plugin.id,
                workId,
                userId,
            );
            if (isEnabled && registered.manifest.defaultForCapabilities?.includes(capability)) {
                return registered;
            }
        }

        for (const registered of enabledPlugins) {
            const isEnabled = await this.isPluginEnabledForScope(
                registered.plugin.id,
                workId,
                userId,
            );
            if (isEnabled) {
                return registered;
            }
        }

        return undefined;
    }

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

        return result;
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
