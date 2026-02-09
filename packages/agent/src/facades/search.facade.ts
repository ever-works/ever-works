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
import { BaseFacadeService, FacadeError } from './base.facade';

export class SearchFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'SearchFacadeError';
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
        facadeOptions: FacadeOptions,
    ): Promise<SearchFacadeResult[]> {
        const plugin = await this.resolvePlugin<ISearchPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.directoryId,
        );

        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);

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
}
