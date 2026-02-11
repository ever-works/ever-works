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
        options: FacadeExtractionOptions | undefined,
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

    // Resolution: override > directory default > non-system > system default > any enabled
    private async resolveExtractorPlugin(
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
                registered.state === 'loaded'
            ) {
                const isEnabled = await this.isPluginEnabled(providerOverride, directoryId, userId);
                if (!isEnabled) throw new ContentExtractorProviderNotFoundError(providerOverride);

                const plugin = registered.plugin as IContentExtractorPlugin;
                if (typeof plugin.canExtract === 'function') {
                    try {
                        if (!(await plugin.canExtract(url))) {
                            this.logger.warn(
                                `Override plugin ${providerOverride} cannot extract: ${url}`,
                            );
                            throw new ContentExtractorProviderNotFoundError(providerOverride);
                        }
                    } catch (err) {
                        if (err instanceof ContentExtractorProviderNotFoundError) throw err;
                        this.logger.warn(
                            `canExtract failed for ${providerOverride}: ${(err as Error).message}`,
                        );
                    }
                }
                return plugin;
            }
            throw new ContentExtractorProviderNotFoundError(providerOverride);
        }

        // 2. Directory default via activeCapability
        if (directoryId) {
            const activePlugin = await this.findActivePluginForDirectory(directoryId);
            if (activePlugin) {
                const plugin = activePlugin.plugin as IContentExtractorPlugin;
                if (typeof plugin.canExtract !== 'function') return plugin;
                try {
                    if (await plugin.canExtract(url)) return plugin;
                } catch (err) {
                    this.logger.warn(
                        `canExtract failed for ${activePlugin.plugin.id}: ${(err as Error).message}`,
                    );
                }
            }
        }

        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabledPlugins = plugins.filter((p) => p.state === 'loaded');

        // 3. Non-system extractors first (API-based)
        const nonSystemExtractors = enabledPlugins.filter(
            (p) =>
                !p.manifest.systemPlugin &&
                !p.manifest.defaultForCapabilities?.includes(this.CAPABILITY),
        );

        for (const registered of nonSystemExtractors) {
            const isEnabled = await this.isPluginEnabled(registered.plugin.id, directoryId, userId);
            if (!isEnabled) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (typeof plugin.canExtract === 'function') {
                try {
                    if (!(await plugin.canExtract(url))) continue;
                } catch (err) {
                    this.logger.warn(
                        `canExtract failed for ${registered.plugin.id}: ${(err as Error).message}`,
                    );
                    continue;
                }
            }
            return plugin;
        }

        // 4. System/default extractor
        const defaultExtractor = this.registry.getDefaultForCapability(this.CAPABILITY);
        if (defaultExtractor) {
            const plugin = defaultExtractor.plugin as IContentExtractorPlugin;
            if (typeof plugin.canExtract === 'function') {
                try {
                    if (!(await plugin.canExtract(url)))
                        throw new NoContentExtractorProviderError();
                } catch (err) {
                    if (err instanceof NoContentExtractorProviderError) throw err;
                    this.logger.warn(`canExtract failed for default: ${(err as Error).message}`);
                }
            }
            return plugin;
        }

        // 5. Last resort - any enabled extractor
        for (const registered of enabledPlugins) {
            const isEnabled = await this.isPluginEnabled(registered.plugin.id, directoryId, userId);
            if (!isEnabled) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (typeof plugin.canExtract === 'function') {
                try {
                    if (!(await plugin.canExtract(url))) continue;
                } catch (err) {
                    this.logger.warn(
                        `canExtract failed for ${registered.plugin.id}: ${(err as Error).message}`,
                    );
                    continue;
                }
            }
            return plugin;
        }

        throw new NoContentExtractorProviderError();
    }
}
