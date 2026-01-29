import { Injectable, Logger } from '@nestjs/common';
import type {
    ISearchFacade,
    SearchFacadeResult,
    SearchFacadeOptions,
    ISearchPlugin,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';

/**
 * Search Facade Error Base
 */
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

/**
 * No search provider configured error
 */
export class NoSearchProviderError extends SearchFacadeError {
    constructor() {
        super('No search provider configured or available', 'getPlugin');
        this.name = 'NoSearchProviderError';
    }
}

/**
 * Search provider not found error
 */
export class SearchProviderNotFoundError extends SearchFacadeError {
    constructor(providerId: string) {
        super(`Search provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'SearchProviderNotFoundError';
    }
}

/**
 * Extended facade options for internal provider resolution
 */
export interface ExtendedSearchFacadeOptions extends SearchFacadeOptions {
    /** User ID for settings resolution */
    userId?: string;
    /** Directory ID for settings resolution */
    directoryId?: string;
    /** Override provider (plugin ID) */
    providerOverride?: string;
}

/**
 * Search Facade service for pipeline steps.
 *
 * Provides web search capabilities ONLY.
 * Content extraction is handled by ContentExtractorFacadeService.
 *
 * Uses the plugin registry to dynamically resolve search providers.
 * Supports 4-level settings resolution hierarchy.
 */
@Injectable()
export class SearchFacadeService implements ISearchFacade {
    private readonly logger = new Logger(SearchFacadeService.name);
    private readonly CAPABILITY = 'search';

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    /**
     * Perform a web search.
     */
    async search(query: string, options?: SearchFacadeOptions): Promise<SearchFacadeResult[]> {
        const extendedOptions = options as ExtendedSearchFacadeOptions | undefined;
        const plugin = await this.resolveSearchPlugin(
            extendedOptions?.providerOverride,
            extendedOptions?.userId,
            extendedOptions?.directoryId,
        );

        // Get resolved settings for the plugin (user/directory scoped)
        const settings = await this.settingsService.getSettings(plugin.id, {
            userId: extendedOptions?.userId,
            directoryId: extendedOptions?.directoryId,
            includeSecrets: true,
        });

        // Pass settings to plugin so it can use API keys, etc.
        const response = await plugin.search({
            query,
            limit: options?.maxResults,
            includeDomains: options?.includeDomains as string[],
            excludeDomains: options?.excludeDomains as string[],
            settings, // Pass resolved settings to plugin
        });

        return response.results.map((r, index) => ({
            title: r.title,
            url: r.url,
            score: 1 - index * 0.05, // Generate score based on position
            publishedDate: r.publishedDate,
        }));
    }

    /**
     * Check if any search provider plugin is configured and available.
     */
    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    /**
     * Get all available search provider plugins.
     */
    getAvailableProviders(): Array<{
        id: string;
        name: string;
        enabled: boolean;
    }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as ISearchPlugin).providerName,
            enabled: p.state === 'enabled',
        }));
    }

    /**
     * Resolve which search plugin to use.
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
                return registered.plugin as ISearchPlugin;
            }
            throw new SearchProviderNotFoundError(providerOverride);
        }

        // Fall back to first enabled search provider
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabled = plugins.find((p) => p.state === 'enabled');

        if (enabled) {
            return enabled.plugin as ISearchPlugin;
        }

        throw new NoSearchProviderError();
    }
}
