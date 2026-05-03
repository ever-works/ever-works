/**
 * Plugin system constants
 */

/**
 * Injection token for PluginsModuleOptions
 */
export const PLUGINS_MODULE_OPTIONS = Symbol('PLUGINS_MODULE_OPTIONS');

/**
 * Default plugin paths to scan for plugins.
 * These paths are scanned for works containing package.json with everworks.plugin manifest.
 */
export const DEFAULT_PLUGIN_PATHS = [
    './plugins',
    './node_modules/@ever-works',
    // Monorepo paths for built-in plugins (relative to apps/api)
    './packages/plugins',
    '../plugins',
    '../../packages/plugins',
];

/**
 * Default platform version when not specified
 */
export const DEFAULT_PLATFORM_VERSION = '0.1.0';

/**
 * Plugin state constants matching PluginState type from @ever-works/plugin
 */
export const PluginStates = {
    UNLOADED: 'unloaded',
    LOADING: 'loading',
    LOADED: 'loaded',
    UNLOADING: 'unloading',
    ERROR: 'error',
} as const;

/**
 * Valid state transitions for plugin lifecycle
 */
export const VALID_STATE_TRANSITIONS: Record<string, readonly string[]> = {
    unloaded: ['loading'],
    loading: ['loaded', 'error'],
    loaded: ['unloading'],
    unloading: ['unloaded', 'error'],
    error: ['loading', 'unloading'],
} as const;

/**
 * Event names for plugin lifecycle events
 */
export const PluginEvents = {
    LOADED: 'plugin:loaded',
    UNLOADED: 'plugin:unloaded',
    ERROR: 'plugin:error',
    SETTINGS_CHANGED: 'plugin:settings-changed',
    STATE_CHANGED: 'plugin:state-changed',
    REGISTERED: 'plugin:registered',
    UNREGISTERED: 'plugin:unregistered',
} as const;

/**
 * Setting sources in priority order (highest to lowest)
 */
export const SETTING_SOURCE_PRIORITY = ['work', 'user', 'admin', 'env', 'default'] as const;
