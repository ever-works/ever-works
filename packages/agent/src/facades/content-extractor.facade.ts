import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IContentExtractorFacade,
    IContentExtractorPlugin,
    FacadeExtractedContent,
    FacadeExtractionOptions,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';

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

export class NoContentExtractorProviderError extends ContentExtractorFacadeError {
    constructor() {
        super('No content extractor provider configured or available', 'getPlugin');
        this.name = 'NoContentExtractorProviderError';
    }
}

export class ContentExtractorProviderNotFoundError extends ContentExtractorFacadeError {
    constructor(providerId: string) {
        super(`Content extractor provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'ContentExtractorProviderNotFoundError';
    }
}

export interface ExtendedFacadeExtractionOptions extends FacadeExtractionOptions {
    userId?: string;
    directoryId?: string;
}

/**
 * Content Extractor Facade - unified content extraction from URLs.
 * Resolution: override > directory default > non-system extractors > system default.
 * Uses three-level enable resolution: Directory > User > autoEnable.
 */
@Injectable()
export class ContentExtractorFacadeService implements IContentExtractorFacade {
    private readonly logger = new Logger(ContentExtractorFacadeService.name);
    private readonly CAPABILITY = 'content-extractor';

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
        @Optional() private readonly directoryPluginRepository?: DirectoryPluginRepository,
        @Optional() private readonly userPluginRepository?: UserPluginRepository,
    ) {}

    async extractContent(
        url: string,
        options?: FacadeExtractionOptions,
    ): Promise<FacadeExtractedContent | null> {
        try {
            const extendedOptions = options as ExtendedFacadeExtractionOptions | undefined;

            const plugin = await this.resolvePlugin(
                url,
                extendedOptions?.providerOverride,
                extendedOptions?.userId,
                extendedOptions?.directoryId,
            );

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
                this.logger.debug(`No content extractor available for URL: ${url}`);
                return null;
            }
            this.logger.warn(
                `Content extraction failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        }
    }

    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IContentExtractorPlugin).providerName,
            enabled: p.state === 'enabled',
        }));
    }

    /**
     * Resolution: override > directory default > non-system > system default
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
                const isEnabled = await this.isPluginEnabled(providerOverride, directoryId, userId);
                if (!isEnabled) throw new ContentExtractorProviderNotFoundError(providerOverride);

                const plugin = registered.plugin as IContentExtractorPlugin;
                if (plugin.canExtract) {
                    const canHandle = await plugin.canExtract(url);
                    if (!canHandle) {
                        this.logger.warn(
                            `Override plugin ${providerOverride} cannot extract: ${url}`,
                        );
                        throw new ContentExtractorProviderNotFoundError(providerOverride);
                    }
                }
                return plugin;
            }
            throw new ContentExtractorProviderNotFoundError(providerOverride);
        }

        // 2. Directory default via activeCapability
        if (directoryId && this.directoryPluginRepository) {
            try {
                const activePlugin = await this.directoryPluginRepository.findActiveByCapability(
                    directoryId,
                    this.CAPABILITY,
                );
                if (activePlugin) {
                    const registered = this.registry.get(activePlugin.pluginId);
                    if (registered && registered.state === 'enabled') {
                        const plugin = registered.plugin as IContentExtractorPlugin;
                        if (!plugin.canExtract || (await plugin.canExtract(url))) {
                            return plugin;
                        }
                    }
                }
            } catch {
                // Fall through
            }
        }

        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabledPlugins = plugins.filter((p) => p.state === 'enabled');

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
            if (plugin.canExtract) {
                const canHandle = await plugin.canExtract(url);
                if (!canHandle) continue;
            }
            return plugin;
        }

        // 4. System/default extractor (uses registry's default resolution)
        const defaultExtractor = this.registry.getDefaultForCapability(this.CAPABILITY);

        if (defaultExtractor) {
            const plugin = defaultExtractor.plugin as IContentExtractorPlugin;
            if (plugin.canExtract) {
                const canHandle = await plugin.canExtract(url);
                if (!canHandle) throw new NoContentExtractorProviderError();
            }
            return plugin;
        }

        // 5. Last resort - any enabled extractor
        for (const registered of enabledPlugins) {
            const isEnabled = await this.isPluginEnabled(registered.plugin.id, directoryId, userId);
            if (!isEnabled) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (plugin.canExtract) {
                const canHandle = await plugin.canExtract(url);
                if (!canHandle) continue;
            }
            return plugin;
        }

        throw new NoContentExtractorProviderError();
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
                            name: (registered.plugin as IContentExtractorPlugin).providerName,
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
                name: (enabled.plugin as IContentExtractorPlugin).providerName,
            };
        }

        return null;
    }
}
