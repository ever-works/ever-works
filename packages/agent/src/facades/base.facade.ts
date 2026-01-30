import { Logger } from '@nestjs/common';
import {
    PluginRegistryService,
    RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import type { IPlugin } from '@ever-works/plugin';

/**
 * Options for facade operations that support context-aware resolution.
 */
export interface BaseFacadeOptions {
    /** User ID for settings and enable resolution */
    userId?: string;
    /** Directory ID for settings and enable resolution */
    directoryId?: string;
    /** Override provider (plugin ID) */
    providerOverride?: string;
}

/**
 * Default provider information returned by getDefaultProvider.
 */
export interface DefaultProviderInfo {
    id: string;
    name: string;
}

/**
 * Abstract base class for all capability facades.
 *
 * Facades are thin service wrappers that abstract plugin interactions from the rest
 * of the application. They handle:
 * 1. Provider Resolution - Determining which plugin to use
 * 2. Settings Resolution - Getting the correct configuration
 * 3. Enable Resolution - Three-level configuration (Directory > User > Generation)
 * 4. Plugin Invocation - Calling the plugin with resolved settings
 * 5. Error Handling - Uniform error handling across capabilities
 *
 * ## Three-Level Enable Resolution
 *
 * ```
 * isPluginEnabled(pluginId, directoryId, userId)
 *     │
 *     ├─ 1. Check DirectoryPlugin.enabled (Level 2)
 *     │     └─ If DirectoryPluginEntity exists: return directoryPlugin.enabled
 *     │
 *     ├─ 2. Check UserPlugin.enabled (Level 1)
 *     │     └─ If UserPluginEntity exists: return userPlugin.enabled
 *     │
 *     ├─ 3. Check manifest.autoEnable
 *     │     └─ If manifest.autoEnable is true: return true
 *     │
 *     └─ 4. Default to enabled (plugin is in registry with state=enabled)
 * ```
 *
 * ## Settings Resolution (4-Level Hierarchy)
 *
 * Settings are resolved using PluginSettingsService with 4-level hierarchy:
 * 1. Directory settings (highest priority)
 * 2. User settings
 * 3. Admin settings
 * 4. Plugin defaults (lowest priority)
 *
 * ## Usage
 *
 * Extend this class and implement the abstract members:
 *
 * ```typescript
 * @Injectable()
 * export class MyFacadeService extends BaseFacadeService {
 *     protected readonly CAPABILITY = 'my-capability';
 *
 *     // Implement your capability-specific methods
 *     async doSomething(options: MyOptions): Promise<MyResult> {
 *         const plugin = await this.resolvePlugin(options.directoryId, options.userId);
 *         const settings = await this.getResolvedSettings(plugin.id, options);
 *         return plugin.doSomething({ ...options, settings });
 *     }
 * }
 * ```
 */
export abstract class BaseFacadeService {
    /**
     * The capability string this facade handles (e.g., 'search', 'screenshot', 'ai-provider').
     * Must be implemented by subclasses.
     */
    protected abstract readonly CAPABILITY: string;

    /**
     * Logger instance. Subclasses should create their own logger with their class name.
     */
    protected abstract readonly logger: Logger;

    constructor(
        protected readonly registry: PluginRegistryService,
        protected readonly settingsService: PluginSettingsService,
        protected readonly directoryPluginRepository?: DirectoryPluginRepository,
        protected readonly userPluginRepository?: UserPluginRepository,
    ) {}

    /**
     * Check if any provider plugin for this capability is configured and available.
     */
    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    /**
     * Get all available provider plugins for this capability.
     */
    getAvailableProviders(): Array<{
        id: string;
        name: string;
        enabled: boolean;
    }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: p.plugin.name,
            enabled: p.state === 'enabled',
        }));
    }

    /**
     * Get the default provider for this capability in a directory.
     *
     * Resolution order:
     * 1. DirectoryPlugin with activeCapability matching this capability
     * 2. First enabled plugin with this capability
     */
    async getDefaultProvider(
        directoryId?: string,
        userId?: string,
    ): Promise<DefaultProviderInfo | null> {
        // 1. Check for directory-level default via activeCapability
        if (directoryId && this.directoryPluginRepository) {
            try {
                const activePlugin = await this.directoryPluginRepository.findActiveByCapability(
                    directoryId,
                    this.CAPABILITY,
                );

                if (activePlugin) {
                    const registered = this.registry.get(activePlugin.pluginId);
                    if (registered && registered.state === 'enabled') {
                        return {
                            id: registered.plugin.id,
                            name: this.getProviderName(registered.plugin),
                        };
                    }
                }
            } catch {
                // Fall through to default resolution
            }
        }

        // 2. Fall back to first enabled plugin with this capability
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabledPlugin = plugins.find((p) => p.state === 'enabled');

        if (enabledPlugin) {
            return {
                id: enabledPlugin.plugin.id,
                name: this.getProviderName(enabledPlugin.plugin),
            };
        }

        return null;
    }

    /**
     * Check if a plugin is enabled for a specific context.
     *
     * Resolution order (three-level configuration):
     * 1. DirectoryPlugin.enabled (Level 2) - if record exists, use it
     * 2. UserPlugin.enabled (Level 1) - if record exists, use it
     * 3. autoEnable in manifest - plugin default
     * 4. Default to enabled (registry already filtered by enabled state)
     *
     * Level 2 takes precedence over Level 1.
     */
    protected async isPluginEnabled(
        pluginId: string,
        directoryId?: string,
        userId?: string,
    ): Promise<boolean> {
        // Level 2: Check DirectoryPlugin record (highest priority for directory context)
        if (directoryId && this.directoryPluginRepository) {
            try {
                const directoryPlugin =
                    await this.directoryPluginRepository.findByDirectoryAndPlugin(
                        directoryId,
                        pluginId,
                    );

                if (directoryPlugin !== null) {
                    return directoryPlugin.enabled;
                }
            } catch {
                // Continue to Level 1
            }
        }

        // Level 1: Check UserPlugin record (user-level toggle)
        if (userId && this.userPluginRepository) {
            try {
                const userPlugin = await this.userPluginRepository.findByUserAndPlugin(
                    userId,
                    pluginId,
                );

                if (userPlugin !== null) {
                    return userPlugin.enabled;
                }
            } catch {
                // Continue to autoEnable
            }
        }

        // Check autoEnable in manifest
        const registered = this.registry.get(pluginId);
        if (registered?.manifest?.autoEnable) {
            return true;
        }

        // Default to enabled if no explicit setting (registry already filtered by enabled state)
        return true;
    }

    /**
     * Get resolved settings for a plugin using the 4-level hierarchy.
     *
     * Settings are merged from:
     * 1. Plugin defaults (lowest priority)
     * 2. Admin settings
     * 3. User settings
     * 4. Directory settings (highest priority)
     */
    protected async getResolvedSettings(
        pluginId: string,
        options?: BaseFacadeOptions,
    ): Promise<Record<string, unknown>> {
        return this.settingsService.getSettings(pluginId, {
            userId: options?.userId,
            directoryId: options?.directoryId,
            includeSecrets: true,
        });
    }

    /**
     * Get the provider/display name from a plugin.
     * Override in subclasses if the plugin interface has a specific property for this.
     */
    protected getProviderName(plugin: IPlugin): string {
        // Try common provider name properties
        const providerName = (plugin as { providerName?: string }).providerName;
        if (providerName) {
            return providerName;
        }

        const sourceName = (plugin as { sourceName?: string }).sourceName;
        if (sourceName) {
            return sourceName;
        }

        return plugin.name;
    }

    /**
     * Find the directory-level active plugin for this capability.
     * Returns null if no active plugin is set for this directory.
     */
    protected async findActivePluginForDirectory(
        directoryId: string,
    ): Promise<RegisteredPlugin | null> {
        if (!this.directoryPluginRepository) {
            return null;
        }

        try {
            const activePlugin = await this.directoryPluginRepository.findActiveByCapability(
                directoryId,
                this.CAPABILITY,
            );

            if (activePlugin) {
                const registered = this.registry.get(activePlugin.pluginId);
                if (registered && registered.state === 'enabled') {
                    return registered;
                }
            }
        } catch {
            // Fall through
        }

        return null;
    }

    /**
     * Get all enabled plugins for this capability that pass the enable check.
     */
    protected async getEnabledPlugins(
        directoryId?: string,
        userId?: string,
    ): Promise<RegisteredPlugin[]> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const result: RegisteredPlugin[] = [];

        for (const p of plugins) {
            if (p.state !== 'enabled') continue;

            const isEnabled = await this.isPluginEnabled(p.plugin.id, directoryId, userId);
            if (isEnabled) {
                result.push(p);
            }
        }

        return result;
    }
}
