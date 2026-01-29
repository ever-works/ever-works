import { Injectable, Logger } from '@nestjs/common';
import type {
    IContentExtractorFacade,
    IContentExtractorPlugin,
    DataSourceContent,
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
 * Facade options for provider resolution
 */
export interface ContentExtractorFacadeOptions {
    /** User ID for settings resolution */
    userId?: string;
    /** Directory ID for settings resolution */
    directoryId?: string;
    /** Override provider (plugin ID) */
    providerOverride?: string;
}

/**
 * Content Extractor Facade service for pipeline steps.
 *
 * Uses the plugin registry to dynamically resolve content extractor providers.
 * All content extraction is plugin-based - no hardcoded platform-specific logic.
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
     * Extract content from a URL using the appropriate data source plugin.
     * Required by IContentExtractorFacade interface.
     *
     * Uses plugin-based routing to find the best extractor for the URL.
     * Each plugin can declare whether it can handle a specific URL via canExtract().
     */
    async extractContent(
        url: string,
        facadeOptions?: ContentExtractorFacadeOptions,
    ): Promise<DataSourceContent | null> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);

        for (const registered of plugins) {
            if (registered.state !== 'enabled') continue;

            const plugin = registered.plugin as IContentExtractorPlugin;

            // Check if plugin can handle this URL (if canExtract method exists)
            if (plugin.canExtract) {
                const canHandle = await plugin.canExtract(url);
                if (!canHandle) continue;
            }

            try {
                // Get resolved settings for the plugin (user/directory scoped)
                const settings = await this.settingsService.getSettings(plugin.id, {
                    userId: facadeOptions?.userId,
                    directoryId: facadeOptions?.directoryId,
                    includeSecrets: true,
                });

                const result = await plugin.extract({ url, settings });
                return {
                    rawContent: result.content || result.markdown || '',
                    metadata: result.metadata as Record<string, unknown> | undefined,
                };
            } catch (error) {
                this.logger.warn(
                    `Plugin ${plugin.id} failed to extract: ${error instanceof Error ? error.message : String(error)}`,
                );
                continue; // Try next plugin
            }
        }

        this.logger.debug(`No content extractor plugin available for URL: ${url}`);
        return null;
    }

    /**
     * Check if any data source plugin can handle the given URL.
     * Required by IContentExtractorFacade interface.
     *
     * Note: This is a synchronous check. For accurate URL-specific checks,
     * use extractContent() which will try each plugin's canExtract() method.
     *
     * @returns true if any content extractor plugin is enabled
     */
    canHandle(_url: string): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.some((p) => p.state === 'enabled');
    }

    /**
     * Check if content extraction is configured for the given URL type.
     * Required by IContentExtractorFacade interface.
     */
    isConfigured(url: string): boolean {
        return this.canHandle(url);
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
}
