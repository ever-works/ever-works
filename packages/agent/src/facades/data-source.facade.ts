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
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';

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
 * Data Source Facade - unified access to external data sources (Apify, etc.).
 * Uses three-level enable resolution: Directory > User > autoEnable.
 */
@Injectable()
export class DataSourceFacadeService implements IDataSourceFacade {
    private readonly logger = new Logger(DataSourceFacadeService.name);
    private readonly CAPABILITY = 'data-source';

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
        @Optional() private readonly directoryPluginRepository?: DirectoryPluginRepository,
        @Optional() private readonly userPluginRepository?: UserPluginRepository,
    ) {}

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

            const isEnabled = await this.isPluginEnabledForDirectory(
                pluginId,
                options?.directoryId,
                options?.userId,
                options?.pluginConfig,
            );

            if (!isEnabled) {
                this.logger.debug(`Data source plugin ${pluginId} not enabled, skipping`);
                continue;
            }

            const pluginSettings = options?.pluginConfig?.[pluginId] as
                | Record<string, unknown>
                | undefined;

            try {
                const plugin = registered.plugin as IDataSourcePlugin;

                const isAvailable = await plugin.isAvailable();
                if (!isAvailable) {
                    this.logger.warn(`Data source plugin ${pluginId} is not available, skipping`);
                    continue;
                }

                const resolvedSettings = await this.settingsService.getSettings(pluginId, {
                    userId: options?.userId,
                    directoryId: options?.directoryId,
                    includeSecrets: true,
                });

                const mergedSettings = { ...resolvedSettings, ...pluginSettings };

                const result = await plugin.query({
                    limit: options?.limit,
                    settings: mergedSettings,
                    filterContext: options?.filterContext,
                });

                for (const item of result.items) {
                    const mutableItem = item as MutableItemData;
                    allItems.push(mutableItem);
                    sourceMap.set(mutableItem.slug || mutableItem.name, pluginId);
                }

                if (result.categories) allCategories.push(...result.categories);
                if (result.tags) allTags.push(...result.tags);
                if (result.brands) allBrands.push(...result.brands);

                this.logger.log(`Data source ${pluginId} returned ${result.items.length} items`);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.logger.error(`Data source ${pluginId} failed: ${errorMessage}`);
                errors.push({ sourceId: pluginId, error: errorMessage });
            }
        }

        this.logger.log(
            `DataSourceFacade: collected ${allItems.length} items from ${enabledPlugins.length - errors.length} sources`,
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

    async getEnabledSources(directoryId: string, userId?: string): Promise<EnabledDataSource[]> {
        if (!directoryId) return [];

        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabledPlugins = plugins.filter((p) => p.state === 'enabled');
        const result: EnabledDataSource[] = [];

        for (const registered of enabledPlugins) {
            const plugin = registered.plugin as IDataSourcePlugin;
            const isEnabled = await this.isPluginEnabledForDirectory(
                plugin.id,
                directoryId,
                userId,
            );

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

    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

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
     * Enable resolution order: Directory (L2) > User (L1) > pluginConfig (L3) > autoEnable
     */
    private async isPluginEnabledForDirectory(
        pluginId: string,
        directoryId?: string,
        userId?: string,
        pluginConfig?: Record<string, Record<string, unknown>>,
    ): Promise<boolean> {
        // Level 2: DirectoryPlugin
        if (directoryId && this.directoryPluginRepository) {
            try {
                const directoryPlugin =
                    await this.directoryPluginRepository.findByDirectoryAndPlugin(
                        directoryId,
                        pluginId,
                    );
                if (directoryPlugin !== null) return directoryPlugin.enabled;
            } catch {
                // Continue
            }
        }

        // Level 1: UserPlugin
        if (userId && this.userPluginRepository) {
            try {
                const userPlugin = await this.userPluginRepository.findByUserAndPlugin(
                    userId,
                    pluginId,
                );
                if (userPlugin !== null) return userPlugin.enabled;
            } catch {
                // Continue
            }
        }

        // Level 3: pluginConfig
        if (pluginConfig?.[pluginId]?.enabled === true) return true;

        // Fallback: autoEnable
        const registered = this.registry.get(pluginId);
        return registered?.manifest?.autoEnable ?? false;
    }

    async getDefaultProvider(
        capability: string,
        directoryId?: string,
        userId?: string,
    ): Promise<{ id: string; name: string } | null> {
        if (directoryId && this.directoryPluginRepository) {
            try {
                const activePlugin = await this.directoryPluginRepository.findActiveByCapability(
                    directoryId,
                    capability,
                );
                if (activePlugin) {
                    const registered = this.registry.get(activePlugin.pluginId);
                    if (registered && registered.state === 'enabled') {
                        return { id: registered.plugin.id, name: registered.plugin.name };
                    }
                }
            } catch {
                // Fall through
            }
        }

        const plugins = this.registry.getByCapability(capability);
        const enabledPlugin = plugins.find((p) => p.state === 'enabled');
        if (enabledPlugin) {
            return { id: enabledPlugin.plugin.id, name: enabledPlugin.plugin.name };
        }

        return null;
    }
}
