import { Injectable, Logger } from '@nestjs/common';
import type {
    IContentExtractorFacade,
    IContentExtractorPlugin,
    FacadeExtractedContent,
    FacadeExtractionOptions,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';

/**
 * Content Extractor Facade Error Base
 */
export class ContentExtractorFacadeError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly provider?: string,
        public readonly cause?: Error,
    ) {
        super(message);
        this.name = 'ContentExtractorFacadeError';
    }
}

/**
 * No content extractor provider configured error
 */
export class NoContentExtractorProviderError extends ContentExtractorFacadeError {
    constructor() {
        super('No content extractor provider configured or available', 'getPlugin');
        this.name = 'NoContentExtractorProviderError';
    }
}

/**
 * Content extractor provider not found error
 */
export class ContentExtractorProviderNotFoundError extends ContentExtractorFacadeError {
    constructor(providerId: string) {
        super(`Content extractor provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'ContentExtractorProviderNotFoundError';
    }
}

/**
 * Extended facade options for internal provider resolution
 */
export interface ExtendedFacadeExtractionOptions extends FacadeExtractionOptions {
    /** User ID for settings resolution */
    userId?: string;
    /** Directory ID for settings resolution */
    directoryId?: string;
}

/**
 * Content Extractor Facade service for pipeline steps.
 *
 * Provides unified content extraction from any URL.
 * Routes to appropriate plugin based on URL pattern or user selection.
 *
 * Resolution order:
 * 1. Explicit provider override
 * 2. Non-system extractors (Tavily Extract, Firecrawl)
 * 3. System/default extractor (local-content-extractor)
 */
@Injectable()
export class ContentExtractorFacadeService implements IContentExtractorFacade {
    private readonly logger = new Logger(ContentExtractorFacadeService.name);
    private readonly CAPABILITY = 'content-extractor';

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    /**
     * Extract content from a URL.
     *
     * Resolution priority:
     * 1. Explicit provider override (if specified)
     * 2. Non-system content extractors (API-based like Tavily)
     * 3. System/default content extractor (local-content-extractor)
     *
     * This ensures API-based extractors are preferred when configured,
     * with local extraction as the universal fallback.
     */
    async extractContent(
        url: string,
        options?: FacadeExtractionOptions,
    ): Promise<FacadeExtractedContent | null> {
        try {
            // Cast to extended options for internal provider resolution
            const extendedOptions = options as ExtendedFacadeExtractionOptions | undefined;

            const plugin = await this.resolvePlugin(
                url,
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

            const result = await plugin.extract({ url, settings });
            return {
                url: result.url,
                rawContent: result.content || result.markdown || '',
                images: result.images?.map((img) => img.src),
                metadata: result.metadata as Record<string, unknown> | undefined,
            };
        } catch (error) {
            if (error instanceof NoContentExtractorProviderError) {
                this.logger.debug(`No content extractor plugin available for URL: ${url}`);
                return null;
            }
            this.logger.warn(
                `Content extraction failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        }
    }

    /**
     * Check if content extraction is configured and available.
     *
     * @returns true if any content extractor plugin is enabled
     */
    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    /**
     * Get all available content extractor provider plugins.
     */
    getAvailableProviders(): Array<{
        id: string;
        name: string;
        enabled: boolean;
    }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IContentExtractorPlugin).providerName,
            enabled: p.state === 'enabled',
        }));
    }

    /**
     * Resolve which content extractor plugin to use.
     *
     * Priority order:
     * 1. Explicit provider override (if specified)
     * 2. Non-system content extractor plugins (API-based like Tavily)
     * 3. System/default content extractor (local-content-extractor)
     *
     * For each candidate, checks if plugin can extract the URL via canExtract().
     *
     * This ensures API-based extractors are preferred when configured,
     * with local extraction as the universal fallback.
     */
    private async resolvePlugin(
        url: string,
        providerOverride?: string,
        userId?: string,
        directoryId?: string,
    ): Promise<IContentExtractorPlugin> {
        // 1. Explicit override
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                registered &&
                registered.manifest.capabilities.includes(this.CAPABILITY) &&
                registered.state === 'enabled'
            ) {
                const plugin = registered.plugin as IContentExtractorPlugin;
                // Check if plugin can handle this URL
                if (plugin.canExtract) {
                    const canHandle = await plugin.canExtract(url);
                    if (!canHandle) {
                        this.logger.warn(
                            `Override plugin ${providerOverride} cannot extract URL: ${url}`,
                        );
                        throw new ContentExtractorProviderNotFoundError(providerOverride);
                    }
                }
                return plugin;
            }
            throw new ContentExtractorProviderNotFoundError(providerOverride);
        }

        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabledPlugins = plugins.filter((p) => p.state === 'enabled');

        // 2. Try non-system content extractors first (API-based extractors)
        const nonSystemExtractors = enabledPlugins.filter(
            (p) => !p.manifest.systemPlugin && !(p.plugin as { isDefault?: boolean }).isDefault,
        );

        for (const registered of nonSystemExtractors) {
            const plugin = registered.plugin as IContentExtractorPlugin;
            // Check if plugin can handle this URL
            if (plugin.canExtract) {
                const canHandle = await plugin.canExtract(url);
                if (!canHandle) continue;
            }
            return plugin;
        }

        // 3. Fall back to system/default content extractor (local-content-extractor)
        const defaultExtractor = enabledPlugins.find(
            (p) => p.manifest.systemPlugin || (p.plugin as { isDefault?: boolean }).isDefault,
        );

        if (defaultExtractor) {
            const plugin = defaultExtractor.plugin as IContentExtractorPlugin;
            // Check if default plugin can handle this URL
            if (plugin.canExtract) {
                const canHandle = await plugin.canExtract(url);
                if (!canHandle) {
                    throw new NoContentExtractorProviderError();
                }
            }
            return plugin;
        }

        // 4. Last resort - any enabled extractor that can handle the URL
        for (const registered of enabledPlugins) {
            const plugin = registered.plugin as IContentExtractorPlugin;
            if (plugin.canExtract) {
                const canHandle = await plugin.canExtract(url);
                if (!canHandle) continue;
            }
            return plugin;
        }

        throw new NoContentExtractorProviderError();
    }
}
