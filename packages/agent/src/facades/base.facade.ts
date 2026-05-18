import { Logger } from '@nestjs/common';
import {
    PluginRegistryService,
    RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import type { IPlugin, FacadeOptions, PluginIcon } from '@ever-works/plugin';

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

export interface DefaultProviderInfo {
    id: string;
    name: string;
}

export interface UserProviderInfo {
    id: string;
    name: string;
    description?: string;
    icon?: PluginIcon;
    providerName?: string;
    enabled: boolean;
    isDefault: boolean;
    selectableProviderCategories: readonly string[];
}

/**
 * Abstract base class for capability facades.
 * Handles provider resolution, settings hierarchy, and enable checks.
 *
 * FacadeOptions (with userId) is required on all public methods that resolve
 * plugins or settings. Without it, settings degrade to admin/env/defaults only.
 */
export abstract class BaseFacadeService {
    protected abstract readonly CAPABILITY: string;
    protected abstract readonly logger: Logger;

    constructor(
        protected readonly registry: PluginRegistryService,
        protected readonly settingsService: PluginSettingsService | undefined,
        protected readonly workPluginRepository?: WorkPluginRepository,
    ) {}

    async getActiveProviderName(facadeOptions: FacadeOptions): Promise<string | null> {
        const info = await this.getDefaultProvider(facadeOptions.workId, facadeOptions.userId);
        return info?.name ?? null;
    }

    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'loaded');
    }

    getAvailableProviders(): Array<{
        id: string;
        name: string;
        enabled: boolean;
    }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: this.getProviderName(p.plugin),
            enabled: p.state === 'loaded',
        }));
    }

    // User-scoped listing for picker UIs (Code-edit dialog, AI provider picker,
    // etc.). Mirrors the filter sequence used by the generator form-schema
    // service: by-capability + loaded + not supplementary + enabled-for-user,
    // with defaultForCapabilities sorted first.
    async getAvailableProvidersForUser(
        userId: string,
        workId?: string,
    ): Promise<UserProviderInfo[]> {
        const enabled = await this.getEnabledPlugins(workId as string, userId);
        return enabled
            .filter((p) => !p.manifest.supplementary)
            .map((p) => ({
                id: p.plugin.id,
                name: p.manifest.name ?? p.plugin.id,
                description: p.manifest.description,
                icon: p.manifest.icon,
                providerName: this.getProviderName(p.plugin),
                enabled: true,
                isDefault: p.manifest.defaultForCapabilities?.includes(this.CAPABILITY) ?? false,
                selectableProviderCategories: p.manifest.selectableProviderCategories ?? [],
            }));
    }

    async getDefaultProvider(
        workId?: string,
        userId?: string,
    ): Promise<DefaultProviderInfo | null> {
        if (workId && this.workPluginRepository) {
            try {
                const activePlugin = await this.workPluginRepository.findActiveByCapability(
                    workId,
                    this.CAPABILITY,
                );

                if (activePlugin) {
                    const registered = this.registry.get(activePlugin.pluginId);
                    if (registered && registered.state === 'loaded') {
                        // Verify plugin is enabled for this scope (work + user)
                        const isEnabled = await this.isPluginEnabled(
                            activePlugin.pluginId,
                            workId,
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

        const enabledPlugins = await this.getEnabledPlugins(workId, userId);

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
        workId: string,
        userId: string,
    ): Promise<boolean> {
        return this.registry.isPluginEnabledForScope(pluginId, workId, userId);
    }

    // Get resolved settings using 4-level hierarchy: Work > User > Admin > Plugin defaults
    protected async getResolvedSettings(
        pluginId: string,
        options: FacadeOptions,
    ): Promise<Record<string, unknown>> {
        if (!this.settingsService) {
            return {};
        }
        return this.settingsService.getSettings(pluginId, {
            userId: options.userId,
            workId: options.workId,
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

    protected async findActivePluginForWork(workId: string): Promise<RegisteredPlugin | null> {
        if (!this.workPluginRepository) {
            return null;
        }

        try {
            const activePlugin = await this.workPluginRepository.findActiveByCapability(
                workId,
                this.CAPABILITY,
            );

            if (activePlugin) {
                const registered = this.registry.get(activePlugin.pluginId);
                if (registered && registered.state === 'loaded') {
                    return registered;
                }
            }
        } catch {
            // Fall through
        }

        return null;
    }

    protected async getEnabledPlugins(workId: string, userId: string): Promise<RegisteredPlugin[]> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const result: RegisteredPlugin[] = [];

        for (const p of plugins) {
            if (p.state !== 'loaded') continue;

            const isEnabled = await this.isPluginEnabled(p.plugin.id, workId, userId);
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

    // Resolve plugin: providerOverride > work active > defaultForCapabilities > first enabled
    protected async resolvePlugin<T extends IPlugin>(
        providerOverride?: string,
        userId?: string,
        workId?: string,
    ): Promise<T> {
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                registered &&
                registered.manifest.capabilities.includes(this.CAPABILITY) &&
                registered.state === 'loaded'
            ) {
                const isEnabled = await this.isPluginEnabled(providerOverride, workId, userId);
                if (isEnabled) return registered.plugin as T;
            }
            throw new ProviderNotFoundError(providerOverride, this.CAPABILITY);
        }

        if (workId) {
            const activePlugin = await this.findActivePluginForWork(workId);
            if (activePlugin) return activePlugin.plugin as T;
        }

        const enabledPlugins = await this.getEnabledPlugins(workId, userId);
        if (enabledPlugins.length > 0) {
            return enabledPlugins[0].plugin as T;
        }

        throw new NoProviderError(this.CAPABILITY);
    }
}
