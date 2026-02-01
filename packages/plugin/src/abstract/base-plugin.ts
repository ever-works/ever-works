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
 * Abstract base class for plugins providing sensible defaults.
 * Extend this class to reduce boilerplate when implementing plugins.
 *
 * Subclasses must implement: id, name, version, category
 */
export abstract class BasePlugin implements IPlugin {
	abstract readonly id: string;
	abstract readonly name: string;
	abstract readonly version: string;
	abstract readonly category: PluginCategory;

	readonly capabilities: readonly string[] = [];
	readonly settingsSchema: JsonSchema = { type: 'object', properties: {} };
	readonly configurationMode: ConfigurationMode = 'hybrid';

	protected context?: PluginContext;

	/** Called when plugin is loaded. Override for custom initialization. */
	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	/** Called when plugin is enabled. Override for custom enable logic. */
	async onEnable(_context: PluginContext): Promise<void> {}

	/** Called when plugin is disabled. Override for custom disable logic. */
	async onDisable(_context: PluginContext): Promise<void> {}

	/** Called when plugin is unloaded. Override for custom cleanup. */
	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	/** Validate settings. Override for custom validation. */
	async validateSettings(_settings: PluginSettings): Promise<ValidationResult> {
		return { valid: true };
	}

	/** Health check. Override for custom health checks. */
	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy' as PluginHealthStatus,
			message: 'Plugin is operational',
			checkedAt: Date.now()
		};
	}

	// Context accessors

	protected get logger(): PluginLogger | undefined {
		return this.context?.logger;
	}

	protected get cache(): PluginCache | undefined {
		return this.context?.cache;
	}

	protected get http(): PluginHttpClient | undefined {
		return this.context?.http;
	}

	protected get env(): PluginEnvironment | undefined {
		return this.context?.env;
	}

	protected get isLoaded(): boolean {
		return this.context !== undefined;
	}

	/** @throws Error if plugin is not loaded */
	protected async getSettings(): Promise<PluginSettings> {
		if (!this.context) {
			throw new Error('Plugin not loaded - context is undefined');
		}
		return this.context.getSettings();
	}

	/** @throws Error if plugin is not loaded */
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

	// Logging helpers

	protected log(message: string, ...args: unknown[]): void {
		this.logger?.log(message, ...args);
	}

	protected logError(message: string, ...args: unknown[]): void {
		this.logger?.error(message, ...args);
	}

	protected logWarn(message: string, ...args: unknown[]): void {
		this.logger?.warn(message, ...args);
	}

	protected logDebug(message: string, ...args: unknown[]): void {
		this.logger?.debug(message, ...args);
	}
}
