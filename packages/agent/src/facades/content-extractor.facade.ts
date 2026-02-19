import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IContentExtractorPlugin,
    FacadeExtractedContent,
    FacadeExtractionOptions,
    IContentExtractorFacade,
    FacadeOptions,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import {
    BaseFacadeService,
    FacadeError,
    NoProviderError,
    ProviderNotFoundError,
} from './base.facade';

export class ContentExtractorFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'ContentExtractorFacadeError';
    }
}

export class NoContentExtractorProviderError extends NoProviderError {
    constructor() {
        super('content extractor');
        this.name = 'NoContentExtractorProviderError';
    }
}

export class ContentExtractorProviderNotFoundError extends ProviderNotFoundError {
    constructor(providerId: string) {
        super(providerId, 'Content extractor');
        this.name = 'ContentExtractorProviderNotFoundError';
    }
}

@Injectable()
export class ContentExtractorFacadeService
    extends BaseFacadeService
    implements IContentExtractorFacade
{
    protected readonly logger = new Logger(ContentExtractorFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.CONTENT_EXTRACTOR;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() directoryPluginRepository?: DirectoryPluginRepository,
    ) {
        super(registry, settingsService, directoryPluginRepository);
    }

    async extractContent(
        url: string,
        _options: FacadeExtractionOptions | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<FacadeExtractedContent | null> {
        try {
            const plugin = await this.resolveExtractorPlugin(
                url,
                facadeOptions.providerOverride,
                facadeOptions.userId,
                facadeOptions.directoryId,
            );

            const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
            const result = await plugin.extract({ url, settings });

            return {
                url: result.url,
                rawContent: result.content || result.markdown || '',
                images: result.images?.map((img) => img.src),
                metadata: result.metadata as Record<string, unknown> | undefined,
            };
        } catch (error) {
            if (error instanceof NoContentExtractorProviderError) {
                this.logger.debug(`No content extractor available for URL: ${url}`);
                return null;
            }
            this.logger.warn(
                `Content extraction failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        }
    }

    override getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IContentExtractorPlugin).providerName,
            enabled: p.state === 'loaded',
        }));
    }

    /**
     * Resolution order:
     *   0. Supplementary (pdf-extractor, notion-extractor) — intercept by URL pattern first,
     *      regardless of any explicit override. Only active when enabled for the scope.
     *   1. Explicit providerOverride (user's selected provider)
     *   2. Directory's configured default (activeCapability)
     *   3. General non-system extractors (Jina, Firecrawl, Tavily, …)
     *   4. System/default extractor (local-content-extractor)
     *   5. Last resort: any enabled extractor that accepts the URL
     */
    private async resolveExtractorPlugin(
        url: string,
        providerOverride?: string,
        userId?: string,
        directoryId?: string,
    ): Promise<IContentExtractorPlugin> {
        const loadedPlugins = this.registry
            .getByCapability(this.CAPABILITY)
            .filter((p) => p.state === 'loaded');

        // 0. Supplementary plugins: URL-pattern specialists (pdf, notion, …).
        //    Checked before the user's chosen provider so they can intercept their URL types.
        for (const registered of loadedPlugins) {
            if (!registered.manifest.supplementary) continue;
            if (!(await this.isPluginEnabled(registered.plugin.id, directoryId, userId))) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (await this.canExtractSafe(plugin, url, registered.plugin.id)) return plugin;
        }

        // 1. Explicit provider override
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                !registered ||
                !registered.manifest.capabilities.includes(this.CAPABILITY) ||
                registered.state !== 'loaded'
            ) {
                throw new ContentExtractorProviderNotFoundError(providerOverride);
            }

            if (!(await this.isPluginEnabled(providerOverride, directoryId, userId))) {
                throw new ContentExtractorProviderNotFoundError(providerOverride);
            }

            const plugin = registered.plugin as IContentExtractorPlugin;
            await this.assertCanExtractForOverride(plugin, url, providerOverride);
            return plugin;
        }

        // 2. Directory's configured default
        if (directoryId) {
            const active = await this.findActivePluginForDirectory(directoryId);
            if (active) {
                const plugin = active.plugin as IContentExtractorPlugin;
                if (await this.canExtractSafe(plugin, url, active.plugin.id)) return plugin;
            }
        }

        // 3. General extractors (non-system, non-supplementary, non-default)
        const general = loadedPlugins.filter(
            (p) =>
                !p.manifest.systemPlugin &&
                !p.manifest.supplementary &&
                !p.manifest.defaultForCapabilities?.includes(this.CAPABILITY),
        );
        for (const registered of general) {
            if (!(await this.isPluginEnabled(registered.plugin.id, directoryId, userId))) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (await this.canExtractSafe(plugin, url, registered.plugin.id)) return plugin;
        }

        // 4. System/default extractor (e.g., local-content-extractor)
        const defaultExtractor = this.registry.getDefaultForCapability(this.CAPABILITY);
        if (defaultExtractor) {
            const plugin = defaultExtractor.plugin as IContentExtractorPlugin;
            if (typeof plugin.canExtract === 'function') {
                try {
                    if (!(await plugin.canExtract(url))) throw new NoContentExtractorProviderError();
                } catch (err) {
                    if (err instanceof NoContentExtractorProviderError) throw err;
                    // canExtract itself threw — log and still attempt extraction
                    this.logger.warn(
                        `canExtract error on default extractor: ${(err as Error).message}`,
                    );
                }
            }
            return plugin;
        }

        // 5. Last resort
        for (const registered of loadedPlugins) {
            if (!(await this.isPluginEnabled(registered.plugin.id, directoryId, userId))) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (await this.canExtractSafe(plugin, url, registered.plugin.id)) return plugin;
        }

        throw new NoContentExtractorProviderError();
    }

    /**
     * Calls canExtract and returns false on any failure.
     * Used for all tiers where a failed check means "try the next plugin".
     */
    private async canExtractSafe(
        plugin: IContentExtractorPlugin,
        url: string,
        pluginId: string,
    ): Promise<boolean> {
        if (typeof plugin.canExtract !== 'function') return true;
        try {
            return await plugin.canExtract(url);
        } catch (err) {
            this.logger.warn(`canExtract failed for ${pluginId}: ${(err as Error).message}`);
            return false;
        }
    }

    /**
     * Validates the override plugin can extract the URL.
     * - canExtract() → false: throws ContentExtractorProviderNotFoundError
     * - canExtract() → throws: logs warning, allows the plugin (may still succeed)
     */
    private async assertCanExtractForOverride(
        plugin: IContentExtractorPlugin,
        url: string,
        pluginId: string,
    ): Promise<void> {
        if (typeof plugin.canExtract !== 'function') return;
        try {
            if (!(await plugin.canExtract(url))) {
                this.logger.warn(`Override plugin ${pluginId} cannot extract: ${url}`);
                throw new ContentExtractorProviderNotFoundError(pluginId);
            }
        } catch (err) {
            if (err instanceof ContentExtractorProviderNotFoundError) throw err;
            this.logger.warn(`canExtract error for override ${pluginId}: ${(err as Error).message}`);
        }
    }
}
