import { Injectable, Logger } from '@nestjs/common';
import type {
    IDataSourceFacade,
    DataSourceFacadeOptions,
    DataSourceFacadeResult,
    EnabledDataSource,
    IDataSourcePlugin,
    MutableItemData,
    Category,
    Tag,
    Brand,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';

/**
 * Data Source Facade Error Base
 */
export class DataSourceFacadeError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly sourceId?: string,
        public readonly cause?: Error,
    ) {
        super(message);
        this.name = 'DataSourceFacadeError';
    }
}

/**
 * Data Source Facade service for pipeline steps.
 *
 * Provides unified access to external data sources (Apify, etc.).
 * Only queries plugins that have been explicitly enabled in pluginConfig.
 *
 * Flow:
 * 1. User enables data source plugin in GeneratorForm (checkbox)
 * 2. pluginConfig passed to facade via queryAll options
 * 3. Facade checks each plugin's enabled flag in pluginConfig
 * 4. Enabled plugins are queried with filterContext
 * 5. Each plugin filters its items based on filterContext
 * 6. Facade aggregates filtered items from all enabled sources
 *
 * @example
 * ```typescript
 * // In pipeline step
 * const result = await dataSourceFacade.queryAll({
 *     pluginConfig: {
 *         'apify-data-source': { enabled: true, datasetId: '5uxB4x3zYjV5S7nFd' }
 *     },
 *     filterContext: {
 *         prompt: 'Top AI tools for developers',
 *         subject: 'AI tools',
 *         keywords: ['AI', 'tools', 'developers']
 *     }
 * });
 *
 * // Items are already filtered by each plugin
 * const dataSourceItems = result.items;
 * ```
 */
@Injectable()
export class DataSourceFacadeService implements IDataSourceFacade {
    private readonly logger = new Logger(DataSourceFacadeService.name);
    private readonly CAPABILITY = 'data-source';

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    /**
     * Query all enabled data sources and aggregate their items.
     *
     * Only plugins that have `enabled: true` in pluginConfig will be queried.
     * Each plugin is responsible for filtering its items based on filterContext.
     */
    async queryAll(options?: DataSourceFacadeOptions): Promise<DataSourceFacadeResult> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabledPlugins = plugins.filter((p) => p.state === 'enabled');

        const allItems: MutableItemData[] = [];
        const sourceMap = new Map<string, string>();
        const errors: Array<{ sourceId: string; error: string }> = [];
        const allCategories: Category[] = [];
        const allTags: Tag[] = [];
        const allBrands: Brand[] = [];

        for (const registered of enabledPlugins) {
            const pluginId = registered.plugin.id;

            // ==========================================
            // KEY CHECK: Read enabled flag from pluginConfig
            // ==========================================
            // pluginConfig comes from GeneratorForm's DynamicPluginFields
            // Each plugin adds its own 'enabled' checkbox via IFormSchemaProvider
            const pluginSettings = options?.pluginConfig?.[pluginId] as
                | Record<string, unknown>
                | undefined;

            // If plugin wasn't enabled in the GeneratorForm, skip it
            if (!pluginSettings?.enabled) {
                this.logger.debug(
                    `Data source plugin ${pluginId} not enabled in pluginConfig, skipping`,
                );
                continue;
            }

            try {
                const plugin = registered.plugin as IDataSourcePlugin;

                // Check if plugin is available
                const isAvailable = await plugin.isAvailable();
                if (!isAvailable) {
                    this.logger.warn(`Data source plugin ${pluginId} is not available, skipping`);
                    continue;
                }

                // Get resolved settings (combines admin, user, directory settings)
                const resolvedSettings = await this.settingsService.getSettings(pluginId, {
                    userId: options?.userId,
                    directoryId: options?.directoryId,
                    includeSecrets: true,
                });

                // Merge resolved settings with per-request pluginConfig settings
                const mergedSettings = {
                    ...resolvedSettings,
                    ...pluginSettings,
                };

                // Query the data source with settings and filter context
                const result = await plugin.query({
                    limit: options?.limit,
                    settings: mergedSettings,
                    filterContext: options?.filterContext,
                });

                // Collect items and track their source
                for (const item of result.items) {
                    // Cast to MutableItemData (items from data sources are mutable)
                    const mutableItem = item as MutableItemData;
                    allItems.push(mutableItem);
                    sourceMap.set(mutableItem.slug || mutableItem.name, pluginId);
                }

                // Collect categories, tags, brands
                if (result.categories) {
                    allCategories.push(...result.categories);
                }
                if (result.tags) {
                    allTags.push(...result.tags);
                }
                if (result.brands) {
                    allBrands.push(...result.brands);
                }

                this.logger.log(
                    `Data source ${pluginId} returned ${result.items.length} items ` +
                        `(filtered from source)`,
                );
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.logger.error(`Data source ${pluginId} failed: ${errorMessage}`);
                errors.push({ sourceId: pluginId, error: errorMessage });
            }
        }

        this.logger.log(
            `DataSourceFacade: collected ${allItems.length} total items from ` +
                `${enabledPlugins.length - errors.length} sources`,
        );

        return {
            items: allItems,
            sourceMap,
            errors,
            categories: allCategories.length > 0 ? allCategories : undefined,
            tags: allTags.length > 0 ? allTags : undefined,
            brands: allBrands.length > 0 ? allBrands : undefined,
        };
    }

    /**
     * Get a list of all enabled data sources for the current context.
     */
    getEnabledSources(options?: DataSourceFacadeOptions): EnabledDataSource[] {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabledPlugins = plugins.filter((p) => p.state === 'enabled');

        return enabledPlugins
            .filter((registered) => {
                const pluginId = registered.plugin.id;
                const pluginSettings = options?.pluginConfig?.[pluginId] as
                    | Record<string, unknown>
                    | undefined;
                return pluginSettings?.enabled === true;
            })
            .map((registered) => {
                const plugin = registered.plugin as IDataSourcePlugin;
                return {
                    id: plugin.id,
                    name: plugin.name,
                    sourceName: plugin.sourceName,
                };
            });
    }

    /**
     * Check if any data source plugin is configured and available.
     */
    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    /**
     * Get all available data source plugins (for UI listing).
     */
    getAvailableProviders(): Array<{
        id: string;
        name: string;
        sourceName: string;
        enabled: boolean;
    }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => {
            const plugin = p.plugin as IDataSourcePlugin;
            return {
                id: plugin.id,
                name: plugin.name,
                sourceName: plugin.sourceName,
                enabled: p.state === 'enabled',
            };
        });
    }
}
