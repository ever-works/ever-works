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
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { PluginUsageService } from '../usage/plugin-usage.service';
import { BudgetGuardService } from '../budgets/budget-guard.service';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
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
        @Optional() workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly pluginUsageService?: PluginUsageService,
        @Optional() private readonly budgetGuard?: BudgetGuardService,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    async search(
        query: string,
        options: SearchFacadeOptions | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<SearchFacadeResult[]> {
        const plugin = await this.resolvePlugin<ISearchPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );

        if (this.budgetGuard && facadeOptions.workId && facadeOptions.userId) {
            await this.budgetGuard.checkBudget(
                facadeOptions.workId,
                facadeOptions.userId,
                PluginUsageCapability.SEARCH,
                plugin.id,
            );
        }

        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);

        const response = await plugin.search({
            query,
            limit: options?.maxResults,
            includeDomains: options?.includeDomains as string[],
            excludeDomains: options?.excludeDomains as string[],
            settings,
        });

        const pricing = (await plugin.getPricing?.()) ?? null;
        await this.pluginUsageService?.record({
            workId: facadeOptions.workId,
            userId: facadeOptions.userId,
            pluginId: plugin.id,
            capability: PluginUsageCapability.SEARCH,
            units: 1,
            costCents: pricing?.costPerCallCents ?? 0,
            currency: pricing?.currency,
            metadata: {
                operation: 'search',
                resultCount: response.results.length,
            },
        });

        return response.results.map((r, index) => ({
            title: r.title,
            url: r.url,
            score: 1 - index * 0.05,
            publishedDate: r.publishedDate,
        }));
    }
}
