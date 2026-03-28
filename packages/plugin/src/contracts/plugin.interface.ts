import type { PluginContext } from './plugin-context.interface.js';
import type { PluginManifest, PluginCategory } from './plugin-manifest.types.js';
import type { PluginHealthCheck } from './lifecycle.types.js';
import type { JsonSchema } from '../settings/json-schema.types.js';
import type { ConfigurationMode } from '../settings/settings.types.js';
import type { ValidationResult } from '../settings/validation.types.js';

export interface ConnectionValidationResult {
	success: boolean;
	message: string;
	details?: Record<string, unknown>;
}

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
	 * Called when the plugin is unloaded from the system
	 * Clean up all resources
	 */
	onUnload(): Promise<void>;

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

	/**
	 * Optional: Run custom validation logic on settings.
	 * Called after JSON Schema validation passes.
	 * Use for cross-field checks, async API key verification, or business rules
	 * that JSON Schema cannot express.
	 * @param settings - The settings to validate
	 * @returns Validation result (sync or async)
	 */
	validateSettings?(settings: Record<string, unknown>): ValidationResult | Promise<ValidationResult>;

	/**
	 * Optional: Validate a live connection using the provided settings.
	 * Called by the backend when the user requests connection verification.
	 * Implement this in plugins that support connection testing (e.g. verifying an API token).
	 * @param settings - Fully resolved settings (including secrets) for this user.
	 * @returns Validation result
	 */
	validateConnection?(settings: Record<string, unknown>): Promise<ConnectionValidationResult>;
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
	/** Load timestamp */
	readonly loadedAt: number;
}
