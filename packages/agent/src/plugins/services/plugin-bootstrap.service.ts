import { Injectable, Logger } from '@nestjs/common';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginLifecycleManagerService } from './plugin-lifecycle-manager.service';
import { PluginContextFactoryService } from './plugin-context-factory.service';
import { PluginRegistryService } from './plugin-registry.service';

/**
 * Result of the bootstrap operation
 */
export interface PluginBootstrapResult {
    /** Whether the bootstrap was executed (false if already initialized) */
    executed: boolean;
    /** Number of plugins loaded */
    loaded: number;
    /** Number of plugins that failed to load */
    failed: number;
}

/**
 * Service responsible for bootstrapping the plugin system.
 *
 * This service provides explicit control over when plugins are discovered and loaded.
 * It should only be called once from the application root (e.g., ApiModule).
 *
 * Usage in api.module.ts:
 * ```typescript
 * @Module({ ... })
 * export class ApiModule implements OnApplicationBootstrap {
 *     constructor(private readonly pluginBootstrap: PluginBootstrapService) {}
 *
 *     async onApplicationBootstrap() {
 *         await this.pluginBootstrap.bootstrap();
 *     }
 * }
 * ```
 */
@Injectable()
export class PluginBootstrapService {
    private readonly logger = new Logger(PluginBootstrapService.name);

    /** Static flag to prevent multiple initializations across module instances */
    private static initialized = false;

    constructor(
        private readonly pluginLoader: PluginLoaderService,
        private readonly lifecycleManager: PluginLifecycleManagerService,
        private readonly contextFactory: PluginContextFactoryService,
        private readonly registry: PluginRegistryService,
    ) {}

    /**
     * Check if the plugin system has been initialized
     */
    isInitialized(): boolean {
        return PluginBootstrapService.initialized;
    }

    /**
     * Bootstrap the plugin system.
     *
     * This method:
     * 1. Discovers plugins from configured paths
     * 2. Loads and validates all discovered plugins
     * 3. Calls onLoad lifecycle hook for each plugin
     *
     * Once loaded, plugins are ready. Per-user/per-work enable/disable
     * is handled by the DB scope system (isPluginEnabledForScope).
     *
     * Safe to call multiple times - subsequent calls are no-ops.
     *
     * @param options - Optional bootstrap options
     * @returns Bootstrap result with statistics
     */
    async bootstrap(options?: { force?: boolean }): Promise<PluginBootstrapResult> {
        // Prevent double initialization unless forced
        if (PluginBootstrapService.initialized && !options?.force) {
            this.logger.debug('Plugin system already initialized, skipping bootstrap');
            return {
                executed: false,
                loaded: 0,
                failed: 0,
            };
        }

        // Lazy-load mode (opt-in via `PLUGIN_LAZY_LOAD=true`): only
        // discover manifests at boot, defer each plugin's `await
        // import()` + `onLoad` until the first `registry.ensureLoaded`
        // call (typically from a facade's `resolvePlugin`). Reduces
        // API process RSS by the sum of every plugin's SDK weight —
        // material when many notification-channel + email-provider +
        // pipeline plugins ship but the API process only ever invokes
        // a handful of them at runtime (most channel/email delivery
        // happens inside the Trigger.dev hosted sandbox, not the API).
        //
        // Default stays eager so existing behaviour is unchanged for
        // any environment that doesn't flip the flag.
        const lazyLoad = process.env.PLUGIN_LAZY_LOAD === 'true';

        this.logger.log(
            `Bootstrapping plugin system... (${lazyLoad ? 'lazy' : 'eager'} mode)`,
        );

        // Connect the context factory to the lifecycle manager
        this.lifecycleManager.setContextFactory(this.contextFactory);

        if (lazyLoad) {
            // Wire the post-load hook so the registry fires `onLoad`
            // after `ensureLoaded` constructs each plugin. Without
            // this, lazy-loaded plugins would never get their lifecycle
            // hook called.
            this.registry.setPostLoadHook(async (pluginId: string) => {
                const result = await this.lifecycleManager.callOnLoad(pluginId);
                if (!result.success) {
                    // Don't throw — the plugin instance is already
                    // attached and `state=loaded`. Surface as a log;
                    // the caller still gets the plugin.
                    this.logger.error(
                        `Post-load onLoad failed for "${pluginId}": ${result.error}`,
                    );
                }
            });

            const result = await this.pluginLoader.discoverAndRegisterAll();
            this.logger.log(
                `Plugin lazy-discovery complete: ${result.loaded} registered (${result.discovered} lazy), ${result.failed} failed. ` +
                    `Heavy import() deferred until first use.`,
            );

            // Built-in plugins (small, pre-constructed instances) ARE
            // already loaded by discoverAndRegisterAll(). Fire their
            // onLoad now to preserve existing eager semantics for the
            // built-in subset — only the lazy-registered filesystem
            // plugins defer.
            for (const loadResult of result.results) {
                if (
                    loadResult.success &&
                    loadResult.pluginId &&
                    !this.registry.isLazy(loadResult.pluginId)
                ) {
                    await this.lifecycleManager.callOnLoad(loadResult.pluginId);
                }
            }

            PluginBootstrapService.initialized = true;
            this.logger.log('Plugin system bootstrapped successfully (lazy mode)');
            return {
                executed: true,
                loaded: result.loaded,
                failed: result.failed,
            };
        }

        // Eager (default) path — unchanged.
        const result = await this.pluginLoader.discoverAndLoadAll();
        this.logger.log(
            `Plugin discovery complete: ${result.loaded} loaded, ${result.failed} failed`,
        );

        // Call onLoad for all loaded plugins
        for (const loadResult of result.results) {
            if (loadResult.success && loadResult.pluginId) {
                await this.lifecycleManager.callOnLoad(loadResult.pluginId);
            }
        }

        // Mark as initialized
        PluginBootstrapService.initialized = true;
        this.logger.log('Plugin system bootstrapped successfully');

        return {
            executed: true,
            loaded: result.loaded,
            failed: result.failed,
        };
    }

    /**
     * Shutdown the plugin system.
     * Called during application shutdown.
     */
    async shutdown(): Promise<void> {
        if (!PluginBootstrapService.initialized) {
            return;
        }

        this.logger.log('Shutting down plugin system...');
        await this.lifecycleManager.shutdownAll();
        PluginBootstrapService.initialized = false;
        this.logger.log('Plugin system shutdown complete');
    }

    /**
     * Reset the initialization state (for testing purposes only)
     */
    static resetForTesting(): void {
        PluginBootstrapService.initialized = false;
    }
}
