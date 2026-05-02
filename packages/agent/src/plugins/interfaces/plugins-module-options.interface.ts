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
