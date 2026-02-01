import { Logger } from '@nestjs/common';
import {
    PluginRegistryService,
    RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import type { IPlugin } from '@ever-works/plugin';

export interface BaseFacadeOptions {
    userId?: string;
    directoryId?: string;
    providerOverride?: string;
}

export interface DefaultProviderInfo {
    id: string;
    name: string;
}

/**
 * Abstract base class for capability facades.
 *
 * Handles provider resolution, settings resolution (4-level: Directory > User > Admin > Plugin defaults),
 * and enable resolution (3-level: Directory > User > autoEnable).
 */
export abstract class BaseFacadeService {
    protected abstract readonly CAPABILITY: string;
    protected abstract readonly logger: Logger;

    constructor(
        protected readonly registry: PluginRegistryService,
        protected readonly settingsService: PluginSettingsService,
        protected readonly directoryPluginRepository?: DirectoryPluginRepository,
        protected readonly userPluginRepository?: UserPluginRepository,
    ) {}

    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

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

    async getDefaultProvider(
        directoryId?: string,
        userId?: string,
    ): Promise<DefaultProviderInfo | null> {
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
                // Fall through
            }
        }

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

    /** Enable resolution: Directory > User > autoEnable */
    protected async isPluginEnabled(
        pluginId: string,
        directoryId?: string,
        userId?: string,
    ): Promise<boolean> {
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
                // Continue
            }
        }

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

    /** Get a setting value with type validation. Returns undefined if missing or wrong type. */
    protected getSettingTyped<T>(
        settings: Record<string, unknown>,
        key: string,
        expectedType: 'string' | 'number' | 'boolean' | 'object' | 'array',
    ): T | undefined {
        const value = settings[key];

        if (value === undefined || value === null) {
            return undefined;
        }

        const actualType = Array.isArray(value) ? 'array' : typeof value;

        if (actualType !== expectedType) {
            this.logger.warn(
                `Setting '${key}' has type '${actualType}', expected '${expectedType}'`,
            );
            return undefined;
        }

        return value as T;
    }

    /** Get a required setting. Throws if missing or wrong type. */
    protected getSettingRequired<T>(
        settings: Record<string, unknown>,
        key: string,
        expectedType: 'string' | 'number' | 'boolean' | 'object' | 'array',
        pluginId?: string,
    ): T {
        const value = this.getSettingTyped<T>(settings, key, expectedType);

        if (value === undefined) {
            const plugin = pluginId ? ` for plugin '${pluginId}'` : '';
            throw new Error(`Required setting '${key}'${plugin} is missing or has wrong type`);
        }

        return value;
    }

    /** Get a setting with fallback to default value. */
    protected getSettingWithDefault<T>(
        settings: Record<string, unknown>,
        key: string,
        expectedType: 'string' | 'number' | 'boolean' | 'object' | 'array',
        defaultValue: T,
    ): T {
        const value = this.getSettingTyped<T>(settings, key, expectedType);
        return value ?? defaultValue;
    }

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
