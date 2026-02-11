import type { IPlugin } from '../plugin.interface.js';

/**
 * Custom capability definition
 */
export interface CustomCapabilityDef {
	/** Capability name (unique identifier) */
	readonly name: string;
	/** Version of this capability */
	readonly version: string;
	/** Human-readable description */
	readonly description?: string;
	/** Method signatures this capability provides */
	readonly methods: readonly CustomCapabilityMethod[];
	/** Events this capability can emit */
	readonly events?: readonly string[];
	/** Whether this capability is experimental */
	readonly experimental?: boolean;
}

/**
 * Custom capability method definition
 */
export interface CustomCapabilityMethod {
	/** Method name */
	readonly name: string;
	/** Method description */
	readonly description?: string;
	/** Parameter definitions */
	readonly parameters?: readonly CustomCapabilityParameter[];
	/** Return type description */
	readonly returns?: string;
	/** Whether method is async */
	readonly async?: boolean;
}

/**
 * Custom capability parameter definition
 */
export interface CustomCapabilityParameter {
	/** Parameter name */
	readonly name: string;
	/** Parameter type */
	readonly type: string;
	/** Whether parameter is optional */
	readonly optional?: boolean;
	/** Parameter description */
	readonly description?: string;
}

/**
 * Custom capability plugin interface
 * Capability: 'custom-capability'
 *
 * Plugins implementing this interface can register and provide custom capabilities
 * that other plugins can discover and use
 */
export interface ICustomCapabilityPlugin extends IPlugin {
	/**
	 * Get the custom capability definitions this plugin provides
	 */
	getCustomCapabilities(): readonly CustomCapabilityDef[];

	/**
	 * Get the implementation for a custom capability
	 * @param capabilityName - Name of the capability
	 * @returns Implementation object
	 */
	getCapabilityImplementation<T = unknown>(capabilityName: string): T | undefined;

	/**
	 * Check if this plugin provides a specific capability
	 * @param capabilityName - Name of the capability
	 */
	hasCapability(capabilityName: string): boolean;

	/**
	 * Get capability version
	 * @param capabilityName - Name of the capability
	 */
	getCapabilityVersion(capabilityName: string): string | undefined;

	/**
	 * Check compatibility with a required version
	 * @param capabilityName - Name of the capability
	 * @param requiredVersion - Required version (semver)
	 */
	isCompatible?(capabilityName: string, requiredVersion: string): boolean;
}

/**
 * Type guard for custom capability plugins
 */
export function isCustomCapabilityPlugin(plugin: IPlugin): plugin is ICustomCapabilityPlugin {
	return plugin.capabilities.includes('custom-capability');
}
