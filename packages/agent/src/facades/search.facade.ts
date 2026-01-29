import { Injectable, Logger } from '@nestjs/common';
import type {
    ISearchFacade,
    SearchFacadeResult,
    SearchFacadeOptions,
    ExtractedContent,
    ISearchPlugin,
    IContentExtractorPlugin,
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
 * Uses the plugin registry to dynamically resolve search providers.
 * Supports 4-level settings resolution hierarchy.
 */
@Injectable()
export class SearchFacadeService implements ISearchFacade {
    private readonly logger = new Logger(SearchFacadeService.name);
    private readonly SEARCH_CAPABILITY = 'search';
    private readonly EXTRACTOR_CAPABILITY = 'content-extractor';

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
     * Extract content from a URL.
     *
     * Note: The interface requires SearchFacadeOptions, but internally we support
     * extended options for provider resolution. Callers can pass ExtendedSearchFacadeOptions.
     */
    async extractContent(
        url: string,
        facadeOptions?: SearchFacadeOptions,
    ): Promise<ExtractedContent> {
        // Cast to extended options for internal provider resolution
        const extendedOptions = facadeOptions as ExtendedSearchFacadeOptions | undefined;

        const plugin = await this.resolveExtractorPlugin(
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
        const result = await plugin.extract({ url, settings });

        return {
            url: result.url,
            rawContent: result.content || result.markdown || '',
            images: result.images?.map((img) => img.src),
        };
    }

    /**
     * Check if any search provider plugin is configured and available.
     */
    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.SEARCH_CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    /**
     * Check if local content extraction is configured.
     * In the plugin model, this checks for a local content extractor plugin.
     */
    isLocalExtractionConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.EXTRACTOR_CAPABILITY);
        return plugins.some((p) => p.state === 'enabled' && p.plugin.id === 'local-extractor');
    }

    /**
     * Get all available search provider plugins.
     */
    getAvailableProviders(): Array<{
        id: string;
        name: string;
        enabled: boolean;
    }> {
        const plugins = this.registry.getByCapability(this.SEARCH_CAPABILITY);
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
                registered.manifest.capabilities.includes(this.SEARCH_CAPABILITY) &&
                registered.state === 'enabled'
            ) {
                return registered.plugin as ISearchPlugin;
            }
            throw new SearchProviderNotFoundError(providerOverride);
        }

        // Fall back to first enabled search provider
        const plugins = this.registry.getByCapability(this.SEARCH_CAPABILITY);
        const enabled = plugins.find((p) => p.state === 'enabled');

        if (enabled) {
            return enabled.plugin as ISearchPlugin;
        }

        throw new NoSearchProviderError();
    }

    /**
     * Resolve which content extractor plugin to use.
     */
    private async resolveExtractorPlugin(
        providerOverride?: string,
        userId?: string,
        directoryId?: string,
    ): Promise<IContentExtractorPlugin> {
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                registered &&
                registered.manifest.capabilities.includes(this.EXTRACTOR_CAPABILITY) &&
                registered.state === 'enabled'
            ) {
                return registered.plugin as IContentExtractorPlugin;
            }
            throw new SearchProviderNotFoundError(providerOverride);
        }

        // Fall back to first enabled content extractor
        const plugins = this.registry.getByCapability(this.EXTRACTOR_CAPABILITY);
        const enabled = plugins.find((p) => p.state === 'enabled');

        if (enabled) {
            return enabled.plugin as IContentExtractorPlugin;
        }

        // If no dedicated extractor, try search plugins that also support extraction
        const searchPlugins = this.registry.getByCapability(this.SEARCH_CAPABILITY);
        for (const sp of searchPlugins) {
            if (
                sp.state === 'enabled' &&
                sp.manifest.capabilities.includes(this.EXTRACTOR_CAPABILITY)
            ) {
                return sp.plugin as IContentExtractorPlugin;
            }
        }

        throw new NoSearchProviderError();
    }
}
