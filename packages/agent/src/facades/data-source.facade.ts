import { Injectable, Logger, Optional } from '@nestjs/common';
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
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';

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
 * Checks DirectoryPlugin.enabled (Level 2) to determine which plugins to query.
 */
@Injectable()
export class DataSourceFacadeService implements IDataSourceFacade {
    private readonly logger = new Logger(DataSourceFacadeService.name);
    private readonly CAPABILITY = 'data-source';

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
        @Optional() private readonly directoryPluginRepository?: DirectoryPluginRepository,
    ) {}

    /**
     * Query all enabled data sources and aggregate their items.
     *
     * Checks both Level 2 (DirectoryPlugin.enabled) and Level 3 (pluginConfig.enabled).
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

            // Check if plugin is enabled (Level 2 → Level 3 → autoEnable)
            const isEnabled = await this.isPluginEnabledForDirectory(
                pluginId,
                options?.directoryId,
                options?.pluginConfig,
            );

            if (!isEnabled) {
                this.logger.debug(`Data source plugin ${pluginId} not enabled, skipping`);
                continue;
            }

            // Get Level 3 settings from pluginConfig
            const pluginSettings = options?.pluginConfig?.[pluginId] as
                | Record<string, unknown>
                | undefined;

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
     * Get a list of all enabled data sources for a directory.
     * Checks DirectoryPlugin.enabled, then autoEnable in manifest.
     */
    async getEnabledSources(directoryId: string): Promise<EnabledDataSource[]> {
        if (!directoryId) {
            return [];
        }

        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabledPlugins = plugins.filter((p) => p.state === 'enabled');
        const result: EnabledDataSource[] = [];

        for (const registered of enabledPlugins) {
            const plugin = registered.plugin as IDataSourcePlugin;
            const isEnabled = await this.isPluginEnabledForDirectory(plugin.id, directoryId);

            if (isEnabled) {
                result.push({
                    id: plugin.id,
                    name: plugin.name,
                    sourceName: plugin.sourceName,
                });
            }
        }

        return result;
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

    /**
     * Check if a plugin is enabled for a specific directory.
     *
     * Resolution order:
     * 1. DirectoryPlugin.enabled (Level 2) - if record exists
     * 2. pluginConfig.enabled (Level 3) - if no Level 2 record
     * 3. autoEnable in manifest - if neither Level 2 nor Level 3
     */
    private async isPluginEnabledForDirectory(
        pluginId: string,
        directoryId?: string,
        pluginConfig?: Record<string, Record<string, unknown>>,
    ): Promise<boolean> {
        // Level 2: Check DirectoryPlugin record
        if (directoryId && this.directoryPluginRepository) {
            try {
                const directoryPlugin =
                    await this.directoryPluginRepository.findByDirectoryAndPlugin(
                        directoryId,
                        pluginId,
                    );

                if (directoryPlugin !== null) {
                    return directoryPlugin.enabled;
                }
            } catch {
                // Continue to Level 3
            }
        }

        // Level 3: Check pluginConfig
        if (pluginConfig?.[pluginId]?.enabled === true) {
            return true;
        }

        // Check autoEnable in manifest
        const registered = this.registry.get(pluginId);
        if (registered?.manifest?.autoEnable) {
            return true;
        }

        return false;
    }
}
