import { Injectable, Logger, Optional } from '@nestjs/common';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginLifecycleManagerService } from './plugin-lifecycle-manager.service';
import { PluginContextFactoryService } from './plugin-context-factory.service';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginRepository } from '../repositories/plugin.repository';
// EW-693 — boot-time dynamic plugin warmup (FR-13a). Optional so
// bundled-mode deployments don't structurally depend on it.
import { PluginInstallerService } from './plugin-installer.service';

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

    /**
     * Static flag to prevent multiple initializations across module instances
     * within a single Node.js process.
     *
     * NOTE (cluster deployments): This flag is process-scoped, not cluster-scoped.
     * In a multi-worker deployment (e.g. Node.js cluster, PM2, Kubernetes pods)
     * each worker initialises its own plugin registry independently. This is
     * intentional — plugins are stateless, and independent per-worker init is
     * safe. If a future use-case requires cluster-wide single-init semantics,
     * a distributed lock (e.g. Redis SETNX with TTL) should be introduced via
     * a dedicated PluginBootstrapLockService rather than modifying this flag.
     */
    private static initialized = false;

    constructor(
        private readonly pluginLoader: PluginLoaderService,
        private readonly lifecycleManager: PluginLifecycleManagerService,
        private readonly contextFactory: PluginContextFactoryService,
        private readonly registry: PluginRegistryService,
        private readonly pluginRepository: PluginRepository,
        // EW-693 — optional installer for the dynamic-mode boot warmup.
        // Bundled-mode boots ignore it entirely (FR-22).
        @Optional()
        private readonly installer?: PluginInstallerService,
    ) {}

    /**
     * EW-693 / FR-13a — Pre-install DB-recorded dynamic plugins at boot.
     *
     * Call AFTER {@link bootstrap}, so the install dir already exists
     * and the loader's path-discovery has populated the registry with
     * core plugins. Failures are logged but non-fatal — lazy
     * install-on-use (FR-13) is the correctness mechanism.
     *
     * In `bundled` mode this is a no-op.
     */
    async warmupDynamicPlugins(): Promise<{ attempted: number; succeeded: number; failed: number }> {
        if (!this.installer) {
            return { attempted: 0, succeeded: 0, failed: 0 };
        }
        return this.installer.warmupFromDb();
    }

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

        // Lazy mode is on by default — boot cost is small (manifest reads
        // only) and the Proxy makes the change invisible to existing
        // consumers. `PLUGIN_LAZY_LOAD=false` is a runtime kill switch
        // that reverts to the pre-#1156 eager path without a redeploy:
        // every filesystem plugin's entry module is `await import()`-ed
        // at boot, exactly as it was on develop before this PR. Useful if
        // first-call latency on a cold path causes problems we didn't
        // anticipate in stage observation.
        const lazyLoad = process.env.PLUGIN_LAZY_LOAD !== 'false';

        this.logger.log(`Bootstrapping plugin system... (${lazyLoad ? 'lazy' : 'eager'} mode)`);

        // Connect the context factory to the lifecycle manager
        this.lifecycleManager.setContextFactory(this.contextFactory);

        if (lazyLoad) {
            // Wire lazy-materialization hook: when a filesystem-discovered plugin
            // is touched for the first time, the proxy invokes this callback so
            // the lifecycle manager fires onLoad bookkeeping (event emit, state
            // history) exactly as it would have done at boot.
            this.pluginLoader.setOnFirstMaterialize(async (pluginId) => {
                await this.lifecycleManager.callOnLoad(pluginId);
            });
            // Wire failure hook: when a lazy plugin's loader throws, mark the
            // registry state as 'error' + persist to DB so readiness filters stop
            // returning the broken stub. Without this a permanently-failing
            // plugin would hold a 'loaded' slot forever.
            this.pluginLoader.setOnMaterializeError(async (pluginId, error) => {
                this.registry.updateState(pluginId, 'error', error);
                try {
                    await this.pluginRepository.updateState(pluginId, 'error', error.message);
                } catch (dbErr) {
                    this.logger.warn(
                        `Failed to persist error state for plugin ${pluginId}: ${
                            dbErr instanceof Error ? dbErr.message : String(dbErr)
                        }`,
                    );
                }
            });
        }

        // Discover and register plugins. Built-ins still load eagerly (their
        // modules are bundled); discovered plugins go through the lazy proxy
        // unless PLUGIN_LAZY_LOAD=false flipped us into eager mode.
        const result = await this.pluginLoader.discoverAndLoadAll({ lazy: lazyLoad });
        this.logger.log(
            `Plugin ${lazyLoad ? 'registration' : 'load'} complete: ${result.loaded} ready, ${result.failed} failed`,
        );

        // Lazy mode: only built-ins fire onLoad here — lazy plugins fire
        // theirs on first materialisation via the hook above.
        // Eager mode: every successfully loaded plugin gets onLoad now,
        // matching pre-#1156 behaviour.
        for (const loadResult of result.results) {
            if (!loadResult.success || !loadResult.pluginId) continue;
            const registered = this.registry.get(loadResult.pluginId);
            if (!lazyLoad || registered?.builtIn) {
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
     * Reset the initialization state (for testing purposes only).
     * This method is intentionally a no-op in production to prevent accidental
     * state resets from reaching live plugin registries.
     */
    // Security: guard resetForTesting() so it cannot take effect in production,
    // preventing accidental or malicious calls from resetting plugin state on live workers.
    static resetForTesting(): void {
        if (process.env.NODE_ENV === 'production') {
            return;
        }
        PluginBootstrapService.initialized = false;
    }
}
