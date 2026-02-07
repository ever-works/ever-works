import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    SearchFacadeResult,
    SearchFacadeOptions,
    ISearchPlugin,
    ISearchFacade,
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

export class SearchFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'SearchFacadeError';
    }
}

export class NoSearchProviderError extends NoProviderError {
    constructor() {
        super('search');
        this.name = 'NoSearchProviderError';
    }
}

export class SearchProviderNotFoundError extends ProviderNotFoundError {
    constructor(providerId: string) {
        super(providerId, 'Search');
        this.name = 'SearchProviderNotFoundError';
    }
}

@Injectable()
export class SearchFacadeService extends BaseFacadeService implements ISearchFacade {
    protected readonly logger = new Logger(SearchFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.SEARCH;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() directoryPluginRepository?: DirectoryPluginRepository,
    ) {
        super(registry, settingsService, directoryPluginRepository);
    }

    async search(
        query: string,
        options: SearchFacadeOptions | undefined,
        facadeOptions?: FacadeOptions,
    ): Promise<SearchFacadeResult[]> {
        const plugin = await this.resolveSearchPlugin(
            facadeOptions?.providerOverride,
            facadeOptions?.userId,
            facadeOptions?.directoryId,
        );

        const settings = await this.getResolvedSettings(plugin.id, {
            userId: facadeOptions?.userId,
            directoryId: facadeOptions?.directoryId,
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

    override getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as ISearchPlugin).providerName,
            enabled: p.state === 'loaded',
        }));
    }

    // Resolution: override > directory default (activeCapability) > first enabled
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
                registered.state === 'loaded'
            ) {
                const isEnabled = await this.isPluginEnabled(providerOverride, directoryId, userId);
                if (isEnabled) return registered.plugin as ISearchPlugin;
            }
            throw new SearchProviderNotFoundError(providerOverride);
        }

        if (directoryId) {
            const activePlugin = await this.findActivePluginForDirectory(directoryId);
            if (activePlugin) {
                return activePlugin.plugin as ISearchPlugin;
            }
        }

        const enabledPlugins = await this.getEnabledPlugins(directoryId, userId);
        if (enabledPlugins.length > 0) {
            return enabledPlugins[0].plugin as ISearchPlugin;
        }

        throw new NoSearchProviderError();
    }
}
