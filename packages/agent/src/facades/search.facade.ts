import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    ISearchFacade,
    SearchFacadeResult,
    SearchFacadeOptions,
    ISearchPlugin,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';

export class SearchFacadeError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly provider?: string,
        public readonly cause?: Error,
    ) {
        super(message);
        this.name = 'SearchFacadeError';
    }
}

export class NoSearchProviderError extends SearchFacadeError {
    constructor() {
        super('No search provider configured or available', 'getPlugin');
        this.name = 'NoSearchProviderError';
    }
}

export class SearchProviderNotFoundError extends SearchFacadeError {
    constructor(providerId: string) {
        super(`Search provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'SearchProviderNotFoundError';
    }
}

export interface ExtendedSearchFacadeOptions extends SearchFacadeOptions {
    userId?: string;
    directoryId?: string;
    providerOverride?: string;
}

/**
 * Search Facade - web search capabilities via plugin registry.
 * Uses three-level enable resolution: Directory > User > autoEnable.
 */
@Injectable()
export class SearchFacadeService implements ISearchFacade {
    private readonly logger = new Logger(SearchFacadeService.name);
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.SEARCH;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
        @Optional() private readonly directoryPluginRepository?: DirectoryPluginRepository,
        @Optional() private readonly userPluginRepository?: UserPluginRepository,
    ) {}

    async search(query: string, options?: SearchFacadeOptions): Promise<SearchFacadeResult[]> {
        const extendedOptions = options as ExtendedSearchFacadeOptions | undefined;
        const plugin = await this.resolveSearchPlugin(
            extendedOptions?.providerOverride,
            extendedOptions?.userId,
            extendedOptions?.directoryId,
        );

        const settings = await this.settingsService.getSettings(plugin.id, {
            userId: extendedOptions?.userId,
            directoryId: extendedOptions?.directoryId,
            includeSecrets: true,
        });

        const response = await plugin.search({
            query,
            limit: options?.maxResults,
            includeDomains: options?.includeDomains as string[],
            excludeDomains: options?.excludeDomains as string[],
            settings,
        });

        return response.results.map((r, index) => ({
            title: r.title,
            url: r.url,
            score: 1 - index * 0.05,
            publishedDate: r.publishedDate,
        }));
    }

    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as ISearchPlugin).providerName,
            enabled: p.state === 'enabled',
        }));
    }

    /**
     * Resolution: override > directory default (activeCapability) > first enabled
     */
    private async resolveSearchPlugin(
        providerOverride?: string,
        userId?: string,
        directoryId?: string,
    ): Promise<ISearchPlugin> {
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                registered &&
                registered.manifest.capabilities.includes(this.CAPABILITY) &&
                registered.state === 'enabled'
            ) {
                const isEnabled = await this.isPluginEnabled(providerOverride, directoryId, userId);
                if (isEnabled) return registered.plugin as ISearchPlugin;
            }
            throw new SearchProviderNotFoundError(providerOverride);
        }

        if (directoryId && this.directoryPluginRepository) {
            try {
                const activePlugin = await this.directoryPluginRepository.findActiveByCapability(
                    directoryId,
                    this.CAPABILITY,
                );
                if (activePlugin) {
                    const registered = this.registry.get(activePlugin.pluginId);
                    if (registered && registered.state === 'enabled') {
                        return registered.plugin as ISearchPlugin;
                    }
                }
            } catch {
                // Fall through
            }
        }

        const plugins = this.registry.getByCapability(this.CAPABILITY);
        for (const p of plugins) {
            if (p.state !== 'enabled') continue;
            const isEnabled = await this.isPluginEnabled(p.plugin.id, directoryId, userId);
            if (isEnabled) return p.plugin as ISearchPlugin;
        }

        throw new NoSearchProviderError();
    }

    /**
     * Enable resolution: Directory (L2) > User (L1) > autoEnable
     */
    private async isPluginEnabled(
        pluginId: string,
        directoryId?: string,
        userId?: string,
    ): Promise<boolean> {
        if (directoryId && this.directoryPluginRepository) {
            try {
                const dp = await this.directoryPluginRepository.findByDirectoryAndPlugin(
                    directoryId,
                    pluginId,
                );
                if (dp !== null) return dp.enabled;
            } catch {
                // Continue
            }
        }

        if (userId && this.userPluginRepository) {
            try {
                const up = await this.userPluginRepository.findByUserAndPlugin(userId, pluginId);
                if (up !== null) return up.enabled;
            } catch {
                // Continue
            }
        }

        const registered = this.registry.get(pluginId);
        return registered?.manifest?.autoEnable ?? true;
    }

    async getDefaultProvider(
        directoryId?: string,
        userId?: string,
    ): Promise<{ id: string; name: string } | null> {
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
                            name: (registered.plugin as ISearchPlugin).providerName,
                        };
                    }
                }
            } catch {
                // Fall through
            }
        }

        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabled = plugins.find((p) => p.state === 'enabled');
        if (enabled) {
            return {
                id: enabled.plugin.id,
                name: (enabled.plugin as ISearchPlugin).providerName,
            };
        }

        return null;
    }
}
