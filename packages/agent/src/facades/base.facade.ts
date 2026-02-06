import { Logger } from '@nestjs/common';
import {
    PluginRegistryService,
    RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import type { IPlugin } from '@ever-works/plugin';

// Common error classes for all facades
export class FacadeError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly provider?: string,
        public readonly cause?: Error,
    ) {
        super(message);
        this.name = 'FacadeError';
    }
}

export class NoProviderError extends FacadeError {
    constructor(capability: string) {
        super(`No ${capability} provider configured or available`, 'getPlugin');
        this.name = 'NoProviderError';
    }
}

export class ProviderNotFoundError extends FacadeError {
    constructor(providerId: string, capability: string) {
        super(`${capability} provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'ProviderNotFoundError';
    }
}

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
 * Handles provider resolution, settings hierarchy, and enable checks.
 */
export abstract class BaseFacadeService {
    protected abstract readonly CAPABILITY: string;
    protected abstract readonly logger: Logger;

    constructor(
        protected readonly registry: PluginRegistryService,
        protected readonly settingsService: PluginSettingsService | undefined,
        protected readonly directoryPluginRepository?: DirectoryPluginRepository,
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
                        // Verify plugin is enabled for this scope (directory + user)
                        const isEnabled = await this.isPluginEnabled(
                            activePlugin.pluginId,
                            directoryId,
                            userId,
                        );
                        if (isEnabled) {
                            return {
                                id: registered.plugin.id,
                                name: this.getProviderName(registered.plugin),
                            };
                        }
                    }
                }
            } catch {
                // Fall through
            }
        }

        const enabledPlugins = await this.getEnabledPlugins(directoryId, userId);

        if (enabledPlugins.length > 0) {
            return {
                id: enabledPlugins[0].plugin.id,
                name: this.getProviderName(enabledPlugins[0].plugin),
            };
        }

        return null;
    }

    protected async isPluginEnabled(
        pluginId: string,
        directoryId?: string,
        userId?: string,
    ): Promise<boolean> {
        return this.registry.isPluginEnabledForScope(pluginId, directoryId, userId);
    }

    // Get resolved settings using 4-level hierarchy: Directory > User > Admin > Plugin defaults
    protected async getResolvedSettings(
        pluginId: string,
        options?: BaseFacadeOptions,
    ): Promise<Record<string, unknown>> {
        if (!this.settingsService) {
            return {};
        }
        return this.settingsService.getSettings(pluginId, {
            userId: options?.userId,
            directoryId: options?.directoryId,
            includeSecrets: true,
        });
    }

    // Get the provider/display name from a plugin
    protected getProviderName(plugin: IPlugin): string {
        const providerName = (plugin as { providerName?: string }).providerName;
        if (providerName) return providerName;

        const sourceName = (plugin as { sourceName?: string }).sourceName;
        if (sourceName) return sourceName;

        return plugin.name;
    }

    // Get a setting value with type validation. Returns undefined if missing or wrong type.
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

    // Get a required setting. Throws if missing or wrong type.
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

    // Get a setting with fallback to default value.
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

        // Sort: plugins with defaultForCapabilities matching this.CAPABILITY come first
        result.sort((a, b) => {
            const aDefault = a.manifest.defaultForCapabilities?.includes(this.CAPABILITY) ? 0 : 1;
            const bDefault = b.manifest.defaultForCapabilities?.includes(this.CAPABILITY) ? 0 : 1;
            return aDefault - bDefault;
        });

        return result;
    }
}
