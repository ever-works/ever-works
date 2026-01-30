import type { JsonSchema } from './json-schema.types.js';

/**
 * Plugin configuration mode determining where settings are managed
 */
export type ConfigurationMode =
	| 'admin-only' // Settings only configured by admin, not exposed to users
	| 'user-required' // Users must provide their own settings (e.g., API keys)
	| 'hybrid'; // Admin provides defaults, users can optionally override

/**
 * Setting scope for access control
 */
export type SettingScope =
	| 'global' // Platform-wide settings
	| 'directory' // Per-directory settings
	| 'user'; // Per-user settings

export interface SettingCategory {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly order?: number;
	readonly icon?: string;
}

export interface SettingDefinition {
	readonly key: string;
	readonly schema: JsonSchema;
	readonly scope: SettingScope;
	readonly category?: string;
	readonly envVar?: string;
	/** Whether this is a secret field (stored separately, encrypted) */
	readonly secret?: boolean;
	/** Whether this field should be masked in UI display */
	readonly masked?: boolean;
	/** Whether this field is write-only (not returned in API responses) */
	readonly writeOnly?: boolean;
	/** Placeholder text for UI input fields */
	readonly placeholder?: string;
	readonly requiresRestart?: boolean;
	readonly defaultValue?: unknown;
}

export interface PluginSettingsSchema {
	readonly version: number;
	readonly categories?: readonly SettingCategory[];
	readonly settings: readonly SettingDefinition[];
}

/**
 * Resolved settings values for a plugin
 */
export type PluginSettings = Record<string, unknown>;

/**
 * Setting source indicating where a value came from
 */
export type SettingSource = 'default' | 'env' | 'admin' | 'directory' | 'user';

export interface ResolvedSetting<T = unknown> {
	readonly key: string;
	readonly value: T;
	readonly source: SettingSource;
	readonly isFallback: boolean;
}

/**
 * Full resolved settings for a plugin
 */
export type ResolvedSettings = Record<string, ResolvedSetting>;

export interface SettingsUpdate {
	readonly settings: Record<string, unknown>;
	readonly scope: SettingScope;
	readonly directoryId?: string;
	readonly userId?: string;
}

export interface SettingsMigration {
	readonly fromVersion: number;
	readonly toVersion: number;
	readonly migrate: (settings: PluginSettings) => PluginSettings;
}
