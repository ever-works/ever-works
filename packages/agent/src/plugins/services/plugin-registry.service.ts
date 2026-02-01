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
import { DirectoryPluginRepository } from '../repositories/directory-plugin.repository';
import { UserPluginRepository } from '../repositories/user-plugin.repository';

/**
 * Registered plugin with metadata and runtime info
 */
export interface RegisteredPlugin {
    /**
     * The plugin instance
     */
    plugin: IPlugin;

    /**
     * Plugin manifest metadata
     */
    manifest: PluginManifest;

    /**
     * Current plugin state
     */
    state: PluginState;

    /**
     * Whether the plugin is built-in
     */
    builtIn: boolean;

    /**
     * File system path (for external plugins)
     */
    installPath?: string;

    /**
     * When the plugin was registered
     */
    registeredAt: number;

    /**
     * When the plugin was loaded
     */
    loadedAt?: number;

    /**
     * When the plugin was enabled
     */
    enabledAt?: number;

    /**
     * State transition history
     */
    stateHistory: PluginStateTransition[];

    /**
     * Last error if in error state
     */
    error?: Error | string;
}

/**
 * Service for managing the in-memory registry of loaded plugins.
 * Provides fast lookups by ID, category, and capability.
 */
@Injectable()
export class PluginRegistryService {
    private readonly logger = new Logger(PluginRegistryService.name);

    /**
     * Map of plugin ID to registered plugin
     */
    private readonly plugins = new Map<string, RegisteredPlugin>();

    /**
     * Index of plugins by category
     */
    private readonly byCategory = new Map<PluginCategory, Set<string>>();

    /**
     * Index of plugins by capability
     */
    private readonly byCapability = new Map<string, Set<string>>();

    constructor(
        private readonly eventEmitter: EventEmitter2,
        @Optional() private readonly directoryPluginRepository?: DirectoryPluginRepository,
        @Optional() private readonly userPluginRepository?: UserPluginRepository,
    ) {}

    /**
     * Register a plugin in the registry
     */
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

        // Add to main registry
        this.plugins.set(pluginId, registered);

        // Index by category
        if (!this.byCategory.has(manifest.category)) {
            this.byCategory.set(manifest.category, new Set());
        }
        this.byCategory.get(manifest.category)!.add(pluginId);

        // Index by capabilities
        for (const capability of manifest.capabilities) {
            if (!this.byCapability.has(capability)) {
                this.byCapability.set(capability, new Set());
            }
            this.byCapability.get(capability)!.add(pluginId);
        }

        this.logger.log(`Registered plugin: ${pluginId} v${manifest.version}`);

        // Emit registration event
        this.eventEmitter.emit(PluginEvents.REGISTERED, {
            pluginId,
            version: manifest.version,
            category: manifest.category,
            capabilities: manifest.capabilities,
            timestamp: Date.now(),
        });

        return registered;
    }

    /**
     * Unregister a plugin from the registry
     */
    unregister(pluginId: string): boolean {
        const registered = this.plugins.get(pluginId);
        if (!registered) {
            return false;
        }

        // Remove from category index
        const categorySet = this.byCategory.get(registered.manifest.category);
        if (categorySet) {
            categorySet.delete(pluginId);
            if (categorySet.size === 0) {
                this.byCategory.delete(registered.manifest.category);
            }
        }

        // Remove from capability indexes
        for (const capability of registered.manifest.capabilities) {
            const capabilitySet = this.byCapability.get(capability);
            if (capabilitySet) {
                capabilitySet.delete(pluginId);
                if (capabilitySet.size === 0) {
                    this.byCapability.delete(capability);
                }
            }
        }

        // Remove from main registry
        this.plugins.delete(pluginId);

        this.logger.log(`Unregistered plugin: ${pluginId}`);

        // Emit unregistration event
        this.eventEmitter.emit(PluginEvents.UNREGISTERED, {
            pluginId,
            timestamp: Date.now(),
        });

        return true;
    }

    /**
     * Get a registered plugin by ID
     */
    get(pluginId: string): RegisteredPlugin | undefined {
        return this.plugins.get(pluginId);
    }

    /**
     * Get the plugin instance by ID
     */
    getPlugin(pluginId: string): IPlugin | undefined {
        return this.plugins.get(pluginId)?.plugin;
    }

    /**
     * Check if a plugin is registered
     */
    has(pluginId: string): boolean {
        return this.plugins.has(pluginId);
    }

    /**
     * Get all registered plugins
     */
    getAll(): RegisteredPlugin[] {
        return Array.from(this.plugins.values());
    }

    /**
     * Get all plugin IDs
     */
    getPluginIds(): string[] {
        return Array.from(this.plugins.keys());
    }

    /**
     * Get plugins by category
     */
    getByCategory(category: PluginCategory): RegisteredPlugin[] {
        const pluginIds = this.byCategory.get(category);
        if (!pluginIds) {
            return [];
        }
        return Array.from(pluginIds)
            .map((id) => this.plugins.get(id))
            .filter((p): p is RegisteredPlugin => p !== undefined);
    }

    /**
     * Get plugins by capability
     */
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
     * Get the default plugin for a specific capability.
     *
     * Returns the first enabled plugin that has this capability
     * listed in its defaultForCapabilities array.
     */
    getDefaultForCapability(capability: string): RegisteredPlugin | undefined {
        const plugins = this.getByCapability(capability);
        const enabledPlugins = plugins.filter((p) => p.state === 'enabled');

        return enabledPlugins.find((p) => p.manifest.defaultForCapabilities?.includes(capability));
    }

    /**
     * Get all enabled plugins
     */
    getEnabled(): RegisteredPlugin[] {
        return Array.from(this.plugins.values()).filter((p) => p.state === 'enabled');
    }

    /**
     * Get all plugins in a specific state
     */
    getByState(state: PluginState): RegisteredPlugin[] {
        return Array.from(this.plugins.values()).filter((p) => p.state === state);
    }

    /**
     * Get all built-in plugins
     */
    getBuiltIn(): RegisteredPlugin[] {
        return Array.from(this.plugins.values()).filter((p) => p.builtIn);
    }

    /**
     * Update plugin state
     */
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
        } else if (newState === 'enabled') {
            registered.enabledAt = Date.now();
        }

        if (error) {
            registered.error = error;
        } else if (newState !== 'error') {
            registered.error = undefined;
        }

        // Emit state change event
        this.eventEmitter.emit(PluginEvents.STATE_CHANGED, {
            pluginId,
            oldState,
            newState,
            error: error instanceof Error ? error.message : error,
            timestamp: Date.now(),
        });

        return true;
    }

    /**
     * Get runtime info for a plugin
     */
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
            enabledAt: registered.enabledAt,
            error: registered.error,
        };
    }

    /**
     * Get versions map for dependency checking
     */
    getVersionsMap(): Map<string, { version: string }> {
        const map = new Map<string, { version: string }>();
        for (const [id, registered] of this.plugins) {
            map.set(id, { version: registered.manifest.version });
        }
        return map;
    }

    /**
     * Get count of registered plugins
     */
    count(): number {
        return this.plugins.size;
    }

    /**
     * Get available categories (categories that have at least one plugin)
     */
    getAvailableCategories(): PluginCategory[] {
        return Array.from(this.byCategory.keys());
    }

    /**
     * Get available capabilities (capabilities that have at least one plugin)
     */
    getAvailableCapabilities(): string[] {
        return Array.from(this.byCapability.keys());
    }

    /**
     * Clear all plugins (mainly for testing)
     */
    clear(): void {
        this.plugins.clear();
        this.byCategory.clear();
        this.byCapability.clear();
        this.logger.warn('Registry cleared');
    }

    /**
     * Get the default plugin for a capability with scope resolution.
     *
     * Resolution priority:
     * 1. Directory activeCapability setting (if directoryId provided)
     * 2. User preference (if userId provided)
     * 3. Manifest defaultForCapabilities
     *
     * Also checks that the plugin is enabled at the appropriate scope level.
     */
    async getDefaultForCapabilityScoped(
        capability: string,
        directoryId?: string,
        userId?: string,
    ): Promise<RegisteredPlugin | undefined> {
        const plugins = this.getByCapability(capability);
        const enabledPlugins = plugins.filter((p) => p.state === 'enabled');

        // Check directory-level activeCapability first
        if (directoryId && this.directoryPluginRepository) {
            for (const registered of enabledPlugins) {
                try {
                    const dp = await this.directoryPluginRepository.findByDirectoryAndPlugin(
                        directoryId,
                        registered.plugin.id,
                    );
                    if (dp?.activeCapability === capability && dp.enabled) {
                        return registered;
                    }
                } catch {
                    // Continue checking
                }
            }
        }

        // Check if any plugin passes the enable check and is marked as default
        for (const registered of enabledPlugins) {
            const isEnabled = await this.isPluginEnabledForScope(
                registered.plugin.id,
                directoryId,
                userId,
            );
            if (isEnabled && registered.manifest.defaultForCapabilities?.includes(capability)) {
                return registered;
            }
        }

        // Return first enabled plugin that passes scope check
        for (const registered of enabledPlugins) {
            const isEnabled = await this.isPluginEnabledForScope(
                registered.plugin.id,
                directoryId,
                userId,
            );
            if (isEnabled) {
                return registered;
            }
        }

        return undefined;
    }

    /**
     * Get all enabled plugins with scope filtering.
     *
     * Only returns plugins that are enabled at the directory/user level.
     */
    async getEnabledPluginsScoped(
        capability?: string,
        directoryId?: string,
        userId?: string,
    ): Promise<RegisteredPlugin[]> {
        const plugins = capability ? this.getByCapability(capability) : this.getEnabled();
        const result: RegisteredPlugin[] = [];

        for (const registered of plugins) {
            if (registered.state !== 'enabled') continue;

            const isEnabled = await this.isPluginEnabledForScope(
                registered.plugin.id,
                directoryId,
                userId,
            );
            if (isEnabled) {
                result.push(registered);
            }
        }

        return result;
    }

    /**
     * Check if a plugin is enabled for the given scope.
     *
     * Enable resolution: Directory (L2) > User (L1) > autoEnable
     */
    private async isPluginEnabledForScope(
        pluginId: string,
        directoryId?: string,
        userId?: string,
    ): Promise<boolean> {
        // Level 2: Directory-level enable state
        if (directoryId && this.directoryPluginRepository) {
            try {
                const dp = await this.directoryPluginRepository.findByDirectoryAndPlugin(
                    directoryId,
                    pluginId,
                );
                if (dp !== null) return dp.enabled;
            } catch {
                // Continue to next level
            }
        }

        // Level 1: User-level enable state
        if (userId && this.userPluginRepository) {
            try {
                const up = await this.userPluginRepository.findByUserAndPlugin(userId, pluginId);
                if (up !== null) return up.enabled;
            } catch {
                // Continue to fallback
            }
        }

        // Fallback: autoEnable from manifest
        const registered = this.plugins.get(pluginId);
        return registered?.manifest?.autoEnable ?? true;
    }
}
