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

/**
 * Setting category for organization in UI
 */
export interface SettingCategory {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly order?: number;
	readonly icon?: string;
}

/**
 * Individual setting definition
 */
export interface SettingDefinition {
	/** Unique key for this setting */
	readonly key: string;
	/** JSON Schema for validation */
	readonly schema: JsonSchema;
	/** Setting scope */
	readonly scope: SettingScope;
	/** Category ID for grouping */
	readonly category?: string;
	/** Environment variable to use as default */
	readonly envVar?: string;
	/** Whether this is a secret value (should be masked in UI) */
	readonly secret?: boolean;
	/** Whether changes require restart */
	readonly requiresRestart?: boolean;
	/** Default value */
	readonly defaultValue?: unknown;
}

/**
 * Plugin settings schema definition
 */
export interface PluginSettingsSchema {
	/** Schema version */
	readonly version: number;
	/** Setting categories */
	readonly categories?: readonly SettingCategory[];
	/** Setting definitions */
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

/**
 * Settings with their source information
 */
export interface ResolvedSetting<T = unknown> {
	/** Setting key */
	readonly key: string;
	/** Resolved value */
	readonly value: T;
	/** Source of the value */
	readonly source: SettingSource;
	/** Whether the setting is using a fallback */
	readonly isFallback: boolean;
}

/**
 * Full resolved settings for a plugin
 */
export type ResolvedSettings = Record<string, ResolvedSetting>;

/**
 * Settings update request
 */
export interface SettingsUpdate {
	/** Settings to update */
	readonly settings: Record<string, unknown>;
	/** Scope for the update */
	readonly scope: SettingScope;
	/** Directory ID if scope is 'directory' */
	readonly directoryId?: string;
	/** User ID if scope is 'user' */
	readonly userId?: string;
}

/**
 * Settings migration definition
 */
export interface SettingsMigration {
	/** Migration version */
	readonly fromVersion: number;
	/** Target version */
	readonly toVersion: number;
	/** Migration function */
	readonly migrate: (settings: PluginSettings) => PluginSettings;
}
