import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings, ResolvedSettings, SettingScope } from '../../settings/settings.types.js';

/**
 * Configuration change event
 */
export interface ConfigurationChangeEvent {
	/** Changed keys */
	readonly changedKeys: readonly string[];
	/** Previous values */
	readonly previousValues: Record<string, unknown>;
	/** New values */
	readonly newValues: Record<string, unknown>;
	/** Scope of the change */
	readonly scope: SettingScope;
	/** Directory ID if scope is 'directory' */
	readonly directoryId?: string;
	/** User ID if scope is 'user' */
	readonly userId?: string;
}

/**
 * Configuration-aware plugin interface
 * Capability: 'config-aware'
 *
 * Plugins implementing this interface receive notifications when their configuration changes
 */
export interface IConfigAwarePlugin extends IPlugin {
	/**
	 * Called when configuration changes
	 * @param event - Configuration change event
	 */
	onConfigurationChange(event: ConfigurationChangeEvent): Promise<void>;

	/**
	 * Get current effective configuration
	 * @param scope - Optional scope
	 * @param scopeId - Directory or user ID
	 */
	getEffectiveConfig(scope?: SettingScope, scopeId?: string): Promise<PluginSettings>;

	/**
	 * Validate configuration before it's applied
	 * @param config - Configuration to validate
	 * @param scope - Configuration scope
	 */
	validateConfig?(
		config: PluginSettings,
		scope: SettingScope
	): Promise<{ valid: boolean; errors?: readonly string[] }>;

	/**
	 * Migrate configuration from a previous version
	 * @param config - Old configuration
	 * @param fromVersion - Previous version
	 * @param toVersion - Target version
	 */
	migrateConfig?(config: PluginSettings, fromVersion: string, toVersion: string): Promise<PluginSettings>;

	/**
	 * Export configuration for backup
	 */
	exportConfig?(): Promise<Record<string, unknown>>;

	/**
	 * Import configuration from backup
	 * @param config - Configuration to import
	 * @param merge - Whether to merge with existing config
	 */
	importConfig?(config: Record<string, unknown>, merge?: boolean): Promise<void>;
}

/**
 * Type guard for config-aware plugins
 */
export function isConfigAwarePlugin(plugin: IPlugin): plugin is IConfigAwarePlugin {
	return plugin.capabilities.includes('config-aware');
}
