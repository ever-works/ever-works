import { Injectable, Logger } from '@nestjs/common';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginLifecycleManagerService } from './plugin-lifecycle-manager.service';
import { PluginContextFactoryService } from './plugin-context-factory.service';

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
    /** Number of system plugins auto-enabled */
    systemEnabled: number;
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
     * 4. Auto-enables system plugins
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
                systemEnabled: 0,
            };
        }

        this.logger.log('Bootstrapping plugin system...');

        // Connect the context factory to the lifecycle manager
        this.lifecycleManager.setContextFactory(this.contextFactory);

        // Discover and load plugins
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

        // Enable all loaded plugins.
        // Per-user/per-directory access control is handled by isPluginEnabledForScope(),
        // so the registry state just means "plugin is initialized and ready to serve".
        const enableResults = await this.lifecycleManager.enableAll();
        const enabled = enableResults.filter((r) => r.success).length;
        const enableFailed = enableResults.filter((r) => !r.success).length;
        if (enabled > 0) {
            this.logger.log(`Enabled ${enabled} plugins`);
        }
        if (enableFailed > 0) {
            this.logger.warn(`Failed to enable ${enableFailed} plugins`);
        }

        // Mark as initialized
        PluginBootstrapService.initialized = true;
        this.logger.log('Plugin system bootstrapped successfully');

        return {
            executed: true,
            loaded: result.loaded,
            failed: result.failed,
            systemEnabled: enabled,
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
