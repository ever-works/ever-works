import type { ModuleMetadata, Type } from '@nestjs/common';
import type { IPlugin } from '@ever-works/plugin';

/**
 * Module definition for a plugin that can be loaded as a built-in
 */
export interface PluginModule {
    /**
     * The plugin class or instance
     */
    plugin: Type<IPlugin> | IPlugin;

    /**
     * Optional manifest override (normally read from package.json)
     */
    manifest?: Record<string, unknown>;

    /**
     * Whether to auto-enable on load
     */
    autoEnable?: boolean;
}

/**
 * Options for configuring the PluginsModule
 */
export interface PluginsModuleOptions {
    /**
     * Paths to scan for plugins (relative to cwd or absolute)
     */
    pluginPaths?: string[];

    /**
     * Built-in plugins to load directly (classes or instances)
     */
    builtInPlugins?: PluginModule[];

    /**
     * Current platform version for compatibility checking
     */
    platformVersion?: string;

    /**
     * Whether to automatically load built-in plugins on startup
     * @default true
     */
    autoLoadBuiltIn?: boolean;

    /**
     * Whether to automatically enable plugins after loading
     * @default false
     */
    autoEnableOnLoad?: boolean;

    /**
     * Current environment
     */
    environment?: 'development' | 'production' | 'test';

    /**
     * Temporary work for plugin operations
     */
    tempDir?: string;

    /**
     * Data work for plugin storage
     */
    dataDir?: string;

    /**
     * Base URL of the platform (for plugins that need to generate URLs)
     */
    baseUrl?: string;

    /**
     * API base URL (for plugins that need to call the API)
     */
    apiBaseUrl?: string;

    /**
     * Platform feature flags
     */
    features?: string[];

    /**
     * Whether to encrypt secret settings at rest
     * @default true
     */
    encryptSecrets?: boolean;

    /**
     * Secret key for encrypting settings (required if encryptSecrets is true)
     */
    secretKey?: string;

    /**
     * Maximum number of concurrent plugin loads
     * @default 5
     */
    maxConcurrentLoads?: number;

    /**
     * Plugin load timeout in milliseconds
     * @default 30000
     */
    loadTimeout?: number;

    /**
     * EW-693 — Dynamic plugin distribution mode.
     *
     * - `bundled` (default): existing behaviour. All plugins in the
     *   image; loader discovers from `pluginPaths`; no registry calls
     *   on enable. **Bundled-mode deployments behave byte-for-byte the
     *   same as before this option was introduced (FR-22).**
     * - `dynamic`: only core plugins (`distribution: 'core'`) are
     *   bundled. Distributable plugins (`distribution: 'registry'`)
     *   are pulled from `registryUrl` / `registryGithubUrl` on first
     *   enable and placed in `installDir` for `import()`. Boot
     *   reconcile warms the per-replica store from the DB-recorded
     *   installed set.
     *
     * Omit (or `undefined`) to use `bundled`. Wired by
     * `apps/api/src/api.module.ts` from
     * `config.plugins.distributionMode()`.
     */
    distributionMode?: 'bundled' | 'dynamic';

    /**
     * EW-693 — Primary npm-compatible registry the installer resolves
     * packages from. Used in `dynamic` mode only. Defaults to
     * `https://registry.npmjs.org` when wired from the api config.
     */
    registryUrl?: string;

    /**
     * EW-693 — Secondary registry (GitHub Packages, `@ever-works`
     * scope). Installer falls back here when the allowlist entry's
     * `source` is `github-packages` or the primary returns 404 for a
     * first-party package.
     */
    registryGithubUrl?: string;

    /**
     * EW-693 — Bearer token for the registry. SECRET. Read lazily by
     * the installer so a missing token only surfaces on first install,
     * not at boot.
     */
    registryToken?: string;

    /**
     * EW-693 — Writable directory where dynamically-installed plugins
     * land. Defaults to `/app/plugins`. The boot reconciler (Phase 5)
     * refuses to start in `dynamic` mode if this directory is read-only.
     */
    installDir?: string;
}

/**
 * Factory for creating PluginsModuleOptions
 */
export interface PluginsModuleOptionsFactory {
    createPluginsModuleOptions(): Promise<PluginsModuleOptions> | PluginsModuleOptions;
}

/**
 * Async options for configuring the PluginsModule
 */
export interface PluginsModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
    /**
     * Use existing provider
     */
    useExisting?: Type<PluginsModuleOptionsFactory>;

    /**
     * Use class to create options
     */
    useClass?: Type<PluginsModuleOptionsFactory>;

    /**
     * Use factory function
     */
    useFactory?: (...args: unknown[]) => Promise<PluginsModuleOptions> | PluginsModuleOptions;

    /**
     * Inject dependencies for factory
     */
    inject?: unknown[];
}
