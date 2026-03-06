import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Options for fetching a prompt from a prompt provider.
 */
export interface GetPromptOptions {
	/** Label/environment to fetch (e.g., 'production', 'staging'). */
	readonly label?: string;
	/** Cache TTL in seconds. Provider may use its own default if omitted. */
	readonly cacheTtlSeconds?: number;
	/** Resolved plugin settings (injected by the facade). */
	readonly settings?: PluginSettings;
}

/**
 * Result returned by a prompt provider plugin.
 */
export interface PromptProviderResult {
	/** The prompt template string. May use {{var}} or {var} syntax. */
	readonly template: string;
	/** Provider-specific version identifier (e.g., Langfuse prompt version number). */
	readonly version?: string | number;
}

/**
 * Prompt provider plugin interface.
 * Capability: 'prompt-provider'
 *
 * Plugins implementing this interface can fetch externally managed prompts
 * by key. The facade layer handles fallback to hardcoded defaults when
 * the provider is unavailable or the prompt key is not found.
 */
export interface IPromptProviderPlugin extends IPlugin {
	/**
	 * Fetch a prompt template by key.
	 * Returns null if the prompt key is not found in the provider.
	 */
	getPrompt(key: string, options?: GetPromptOptions): Promise<PromptProviderResult | null>;

	/**
	 * Check whether the provider is available (i.e., credentials are configured).
	 */
	isAvailable(settings?: PluginSettings): boolean;
}

/**
 * Type guard for prompt provider plugins.
 */
export function isPromptProviderPlugin(plugin: IPlugin): plugin is IPromptProviderPlugin {
	return plugin.capabilities.includes('prompt-provider');
}
