import type { IPlugin } from '../contracts/plugin.interface.js';
import type {
	PluginContext,
	PluginLogger,
	PluginCache,
	PluginHttpClient
} from '../contracts/plugin-context.interface.js';
import type { PluginEnvironment } from '../contracts/plugin-environment.interface.js';
import type { PluginCategory } from '../contracts/plugin-manifest.types.js';
import type { PluginHealthCheck, PluginHealthStatus } from '../contracts/lifecycle.types.js';
import type { JsonSchema } from '../settings/json-schema.types.js';
import type { ValidationResult } from '../settings/validation.types.js';
import type { ConfigurationMode, PluginSettings } from '../settings/settings.types.js';

/**
 * Abstract base class for plugins providing sensible defaults
 * Plugins can extend this class to reduce boilerplate
 */
export abstract class BasePlugin implements IPlugin {
	/** Unique plugin identifier - must be implemented */
	abstract readonly id: string;
	/** Display name - must be implemented */
	abstract readonly name: string;
	/** Plugin version (semver) - must be implemented */
	abstract readonly version: string;
	/** Plugin category - must be implemented */
	abstract readonly category: PluginCategory;

	/** Capabilities this plugin provides - defaults to empty */
	readonly capabilities: readonly string[] = [];

	/** JSON Schema for plugin settings - defaults to empty object schema */
	readonly settingsSchema: JsonSchema = { type: 'object', properties: {} };

	/** How settings are managed - defaults to hybrid */
	readonly configurationMode: ConfigurationMode = 'hybrid';

	/** Plugin context - set during onLoad */
	protected context?: PluginContext;

	/**
	 * Called when the plugin is loaded into the system
	 * Override to add custom initialization logic
	 */
	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	/**
	 * Called when the plugin is enabled
	 * Override to add custom enable logic
	 */
	async onEnable(_context: PluginContext): Promise<void> {
		// Default: no-op
	}

	/**
	 * Called when the plugin is disabled
	 * Override to add custom disable logic
	 */
	async onDisable(_context: PluginContext): Promise<void> {
		// Default: no-op
	}

	/**
	 * Called when the plugin is unloaded from the system
	 * Override to add custom cleanup logic
	 */
	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	/**
	 * Validate plugin settings
	 * Override to add custom validation logic
	 */
	async validateSettings(_settings: PluginSettings): Promise<ValidationResult> {
		return { valid: true };
	}

	/**
	 * Perform a health check
	 * Override to add custom health check logic
	 */
	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy' as PluginHealthStatus,
			message: 'Plugin is operational',
			checkedAt: Date.now()
		};
	}

	// Protected getters for common context properties

	/** Get the logger instance */
	protected get logger(): PluginLogger | undefined {
		return this.context?.logger;
	}

	/** Get the cache instance */
	protected get cache(): PluginCache | undefined {
		return this.context?.cache;
	}

	/** Get the HTTP client */
	protected get http(): PluginHttpClient | undefined {
		return this.context?.http;
	}

	/** Get the environment info */
	protected get env(): PluginEnvironment | undefined {
		return this.context?.env;
	}

	/** Check if plugin is loaded and has context */
	protected get isLoaded(): boolean {
		return this.context !== undefined;
	}

	/**
	 * Get settings for this plugin
	 * @throws Error if plugin is not loaded
	 */
	protected async getSettings(): Promise<PluginSettings> {
		if (!this.context) {
			throw new Error('Plugin not loaded - context is undefined');
		}
		return this.context.getSettings();
	}

	/**
	 * Emit an event
	 * @throws Error if plugin is not loaded
	 */
	protected emitEvent<T extends string>(event: T, payload: Record<string, unknown>): void {
		if (!this.context) {
			throw new Error('Plugin not loaded - context is undefined');
		}
		this.context.emitEvent(
			event as any,
			{
				timestamp: new Date().toISOString(),
				...payload
			} as any
		);
	}

	/**
	 * Log an info message
	 */
	protected log(message: string, ...args: unknown[]): void {
		this.logger?.log(message, ...args);
	}

	/**
	 * Log an error message
	 */
	protected logError(message: string, ...args: unknown[]): void {
		this.logger?.error(message, ...args);
	}

	/**
	 * Log a warning message
	 */
	protected logWarn(message: string, ...args: unknown[]): void {
		this.logger?.warn(message, ...args);
	}

	/**
	 * Log a debug message
	 */
	protected logDebug(message: string, ...args: unknown[]): void {
		this.logger?.debug(message, ...args);
	}
}
