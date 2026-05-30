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
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { FacadeError } from './base.facade';

export class DataSourceFacadeError extends FacadeError {
    constructor(message: string, operation: string, sourceId?: string, cause?: Error) {
        super(message, operation, sourceId, cause);
        this.name = 'DataSourceFacadeError';
    }
}

@Injectable()
export class DataSourceFacadeService implements IDataSourceFacade {
    private readonly logger = new Logger(DataSourceFacadeService.name);
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.DATA_SOURCE;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    async queryAll(options: DataSourceFacadeOptions): Promise<DataSourceFacadeResult> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        // Lazy-aware: include parked-but-unloaded plugins (they
        // materialise on demand below). Eager `unloaded` entries
        // (no parked loader) stay excluded.
        const enabledPlugins = plugins.filter(
            (p) =>
                p.state === 'loaded' || (this.registry.isLazy?.(p.manifest.id) ?? false),
        );

        const allItems: MutableItemData[] = [];
        const sourceMap = new Map<string, string>();
        const errors: Array<{ sourceId: string; error: string }> = [];
        const allCategories: Category[] = [];
        const allTags: Tag[] = [];
        const allBrands: Brand[] = [];

        for (const registered of enabledPlugins) {
            const pluginId = registered.manifest.id;

            const isEnabled = await this.isPluginEnabledForWork(
                pluginId,
                options.workId,
                options.userId,
                options.pluginConfig,
            );

            if (!isEnabled) {
                this.logger.debug(`Data source plugin ${pluginId} not enabled, skipping`);
                continue;
            }

            const pluginSettings = options.pluginConfig?.[pluginId] as
                | Record<string, unknown>
                | undefined;

            try {
                // Materialise via the registry — eager mode returns
                // the cached instance instantly; lazy mode fires the
                // deferred import + onLoad exactly once.
                const plugin = (await this.registry.ensureLoaded(
                    pluginId,
                )) as IDataSourcePlugin;

                const isAvailable = await plugin.isAvailable();
                if (!isAvailable) {
                    this.logger.warn(`Data source plugin ${pluginId} is not available, skipping`);
                    continue;
                }

                const resolvedSettings = await this.settingsService.getSettings(pluginId, {
                    userId: options.userId,
                    workId: options.workId,
                    includeSecrets: true,
                });

                const mergedSettings = { ...resolvedSettings, ...pluginSettings };

                const result = await plugin.query({
                    limit: options.limit,
                    settings: mergedSettings,
                    filterContext: options.filterContext,
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

    async getEnabledSources(workId: string, userId: string): Promise<EnabledDataSource[]> {
        if (!workId) return [];

        const plugins = this.registry.getByCapability(this.CAPABILITY);
        // Lazy-aware filter — see queryAll().
        const enabledPlugins = plugins.filter(
            (p) =>
                p.state === 'loaded' || (this.registry.isLazy?.(p.manifest.id) ?? false),
        );
        const result: EnabledDataSource[] = [];

        for (const registered of enabledPlugins) {
            const pluginId = registered.manifest.id;
            const isEnabled = await this.isPluginEnabledForWork(pluginId, workId, userId);

            if (isEnabled) {
                // `sourceName` is an instance-only override (set on
                // the plugin class, not the manifest), so we need to
                // materialise here. `id` and `name` would otherwise
                // be manifest-only reads.
                const plugin = (await this.registry.ensureLoaded(
                    pluginId,
                )) as IDataSourcePlugin;
                result.push({
                    id: pluginId,
                    name: plugin.name,
                    sourceName: plugin.sourceName,
                });
            }
        }

        return result;
    }

    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        // Lazy-aware: parked-but-unloaded plugins ARE configured.
        return (
            plugins.length > 0 &&
            plugins.some(
                (p) =>
                    p.state === 'loaded' || (this.registry.isLazy?.(p.manifest.id) ?? false),
            )
        );
    }

    getAvailableProviders(): Array<{
        id: string;
        name: string;
        sourceName: string;
        enabled: boolean;
    }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => {
            // Fall back to manifest fields when the plugin instance
            // hasn't been materialised yet (lazy mode). `sourceName`
            // is an instance-only override — there's no manifest
            // equivalent, so we return the manifest id as a stable
            // placeholder until first use.
            const plugin = p.plugin as IDataSourcePlugin | undefined;
            return {
                id: p.manifest.id,
                name: plugin?.name ?? p.manifest.name ?? p.manifest.id,
                sourceName: plugin?.sourceName ?? p.manifest.name ?? p.manifest.id,
                enabled:
                    p.state === 'loaded' || (this.registry.isLazy?.(p.manifest.id) ?? false),
            };
        });
    }

    private async isPluginEnabledForWork(
        pluginId: string,
        workId?: string,
        userId?: string,
        pluginConfig?: Record<string, Record<string, unknown>>,
    ): Promise<boolean> {
        // Check pluginConfig override first (request-level enable)
        if (pluginConfig?.[pluginId]?.enabled === true) return true;

        // Delegate to registry's scope resolution
        return this.registry.isPluginEnabledForScope(pluginId, workId, userId);
    }

    async getDefaultProvider(
        capability: string,
        workId?: string,
        userId?: string,
    ): Promise<{ id: string; name: string } | null> {
        const registered = await this.registry.getDefaultForCapabilityScoped(
            capability,
            workId,
            userId,
        );
        if (registered) {
            // id/name are manifest-equivalent (class-validated on
            // load) — no need to materialise the plugin instance
            // just to read them.
            return {
                id: registered.manifest.id,
                name: registered.plugin?.name ?? registered.manifest.name ?? registered.manifest.id,
            };
        }
        return null;
    }
}
