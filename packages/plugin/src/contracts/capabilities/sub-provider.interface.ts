import type { IPlugin } from '../plugin.interface.js';
import type { PluginIcon } from '../plugin-manifest.types.js';

/**
 * Sub-provider registration information
 */
export interface SubProviderRegistration {
	/** Sub-provider identifier */
	readonly id: string;
	/** Display name */
	readonly name: string;
	/** Description */
	readonly description?: string;
	/** Icon (supports multiple formats: SVG, URL, base64, Lucide) */
	readonly icon?: PluginIcon;
	/** Parent capability type */
	readonly parentCapability: string;
	/** Whether this is the default sub-provider */
	readonly isDefault?: boolean;
	/** Priority (lower = higher priority) */
	readonly priority?: number;
}

/**
 * Sub-provider selector context
 */
export interface SubProviderSelectorContext {
	/** Directory ID */
	readonly directoryId?: string;
	/** User ID */
	readonly userId?: string;
	/** Operation being performed */
	readonly operation?: string;
	/** Additional context data */
	readonly data?: Record<string, unknown>;
}

/**
 * Sub-provider plugin interface
 * Capability: 'sub-provider'
 *
 * Sub-providers extend a parent capability (e.g., multiple AI models under ai-provider)
 */
export interface ISubProviderPlugin extends IPlugin {
	/** Parent capability this provides a sub-implementation for */
	readonly parentCapability: string;
	/** Sub-provider identifier */
	readonly subProviderId: string;

	/**
	 * Get registration information
	 */
	getRegistration(): SubProviderRegistration;

	/**
	 * Check if this sub-provider can handle the given context
	 */
	canHandle(context: SubProviderSelectorContext): Promise<boolean>;

	/**
	 * Get priority for this sub-provider
	 * Lower values = higher priority
	 */
	getPriority(context: SubProviderSelectorContext): number;

	/**
	 * Check if this sub-provider is available
	 */
	isAvailable(): Promise<boolean>;
}

/**
 * Type guard for sub-provider plugins
 */
export function isSubProviderPlugin(plugin: IPlugin): plugin is ISubProviderPlugin {
	return plugin.capabilities.includes('sub-provider');
}
