import type { PluginContext } from './plugin-context.interface.js';
import type { PluginManifest, PluginCategory } from './plugin-manifest.types.js';
import type { PluginHealthCheck } from './lifecycle.types.js';
import type { JsonSchema } from '../settings/json-schema.types.js';
import type { ValidationResult } from '../settings/validation.types.js';
import type { ConfigurationMode, PluginSettings } from '../settings/settings.types.js';

/**
 * Base plugin interface that all plugins must implement
 */
export interface IPlugin {
	/** Unique plugin identifier */
	readonly id: string;
	/** Display name */
	readonly name: string;
	/** Plugin version (semver) */
	readonly version: string;
	/** Plugin category */
	readonly category: PluginCategory;
	/** Capabilities this plugin provides */
	readonly capabilities: readonly string[];
	/** JSON Schema for plugin settings */
	readonly settingsSchema: JsonSchema;
	/** How settings are managed (admin, user, or hybrid) */
	readonly configurationMode?: ConfigurationMode;

	/**
	 * Called when the plugin is loaded into the system
	 * Initialize resources that don't require settings here
	 */
	onLoad(context: PluginContext): Promise<void>;

	/**
	 * Called when the plugin is enabled
	 * Initialize resources that require settings here
	 */
	onEnable(context: PluginContext): Promise<void>;

	/**
	 * Called when the plugin is disabled
	 * Clean up resources that were initialized in onEnable
	 */
	onDisable(context: PluginContext): Promise<void>;

	/**
	 * Called when the plugin is unloaded from the system
	 * Clean up all resources
	 */
	onUnload(): Promise<void>;

	/**
	 * Validate plugin settings
	 * @param settings - Settings to validate
	 * @returns Validation result
	 */
	validateSettings(settings: PluginSettings): Promise<ValidationResult>;

	/**
	 * Optional: Perform a health check
	 * @returns Health check result
	 */
	healthCheck?(): Promise<PluginHealthCheck>;

	/**
	 * Optional: Get the full manifest for this plugin
	 * @returns Plugin manifest
	 */
	getManifest?(): PluginManifest;
}

/**
 * Plugin constructor type
 */
export type PluginConstructor = new () => IPlugin;

/**
 * Plugin factory function type
 */
export type PluginFactory = () => IPlugin | Promise<IPlugin>;

/**
 * Plugin module export format
 */
export interface PluginModule {
	/** Default export should be the plugin class or factory */
	default: PluginConstructor | PluginFactory;
	/** Optional: Plugin manifest for discovery */
	manifest?: PluginManifest;
}

/**
 * Registered plugin entry in the system
 */
export interface RegisteredPlugin {
	/** Plugin instance */
	readonly plugin: IPlugin;
	/** Plugin manifest */
	readonly manifest: PluginManifest;
	/** Whether the plugin is currently enabled */
	readonly enabled: boolean;
	/** Load timestamp */
	readonly loadedAt: number;
	/** Enable timestamp */
	readonly enabledAt?: number;
}
