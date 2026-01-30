/**
 * API Response types for plugin endpoints.
 * These types define the shape of plugin data returned by the API.
 */

import type { PluginCategory, PluginAuthor, PluginIcon } from '../contracts/plugin-manifest.types.js';
import type { PluginState } from '../contracts/lifecycle.types.js';
import type { ConfigurationMode } from '../settings/settings.types.js';
import type { JsonSchema } from '../settings/json-schema.types.js';

/**
 * Plugin settings schema property for API responses.
 * This is a flattened view of JsonSchema for UI convenience.
 * The API transforms JsonSchema's x-prefixed properties (x-secret, x-masked, x-writeOnly)
 * into flat properties for easier consumption.
 */
export interface PluginSettingsSchemaProperty {
	/** Property type (e.g., 'string', 'number', 'boolean') */
	type: string;
	/** Property title for display */
	title?: string;
	/** Property description */
	description?: string;
	/** Default value */
	default?: unknown;
	/** Whether this is a secret field (from JsonSchema x-secret) */
	secret?: boolean;
	/** Whether this field should be masked in UI (from JsonSchema x-masked) */
	masked?: boolean;
	/** Whether this field is write-only (from JsonSchema x-writeOnly) */
	writeOnly?: boolean;
	/** Enumerated allowed values */
	enum?: readonly unknown[];
}

/**
 * Plugin settings schema for API responses.
 * A simplified JSON Schema for object-type settings.
 */
export interface PluginSettingsSchema {
	/** Always 'object' for settings schemas */
	type: 'object';
	/** Schema title for display */
	title?: string;
	/** Schema description */
	description?: string;
	/** Schema properties mapping field names to their definitions */
	properties: Record<string, PluginSettingsSchemaProperty>;
	/** Required field names */
	required?: string[];
}

/**
 * Transform a JsonSchema into a PluginSettingsSchemaProperty.
 * This flattens x-prefixed properties into flat properties.
 */
export function toPluginSettingsSchemaProperty(schema: JsonSchema): PluginSettingsSchemaProperty {
	return {
		type: typeof schema.type === 'string' ? schema.type : 'string',
		title: schema.title,
		description: schema.description,
		default: schema.default,
		secret: schema['x-secret'],
		masked: schema['x-masked'],
		writeOnly: schema['x-writeOnly'],
		enum: schema.enum
	};
}

/**
 * Transform a JsonSchema into a PluginSettingsSchema.
 */
export function toPluginSettingsSchema(schema: JsonSchema): PluginSettingsSchema | undefined {
	if (schema.type !== 'object' || !schema.properties) {
		return undefined;
	}

	const properties: Record<string, PluginSettingsSchemaProperty> = {};
	for (const [key, propSchema] of Object.entries(schema.properties)) {
		properties[key] = toPluginSettingsSchemaProperty(propSchema);
	}

	return {
		type: 'object',
		title: schema.title,
		description: schema.description,
		properties,
		required: schema.required as string[] | undefined
	};
}

/**
 * Base plugin response from API
 */
export interface PluginResponse {
	/** Plugin entity ID (database) */
	id: string;
	/** Plugin unique identifier */
	pluginId: string;
	/** Plugin display name */
	name: string;
	/** Plugin version */
	version: string;
	/** Plugin description */
	description?: string;
	/** Plugin category */
	category: PluginCategory;
	/** Plugin capabilities */
	capabilities: string[];
	/** Configuration mode */
	configurationMode: ConfigurationMode;
	/** Whether plugin is built-in */
	builtIn: boolean;
	/** Plugin state */
	state: PluginState;
	/** Plugin icon */
	icon?: PluginIcon;
	/** Settings schema for configuration */
	settingsSchema?: PluginSettingsSchema;
	/** Plugin author */
	author?: PluginAuthor;
	/** Plugin homepage URL */
	homepage?: string;
}

/**
 * Plugin response with user-specific data
 */
export interface UserPluginResponse extends PluginResponse {
	/** Whether user has installed this plugin */
	installed: boolean;
	/** Whether user has enabled this plugin */
	enabled: boolean;
	/** User-specific settings (masked) */
	settings?: Record<string, unknown>;
	/** User plugin entity ID */
	userPluginId?: string;
}

/**
 * Plugin response with directory-specific data
 */
export interface DirectoryPluginResponse extends UserPluginResponse {
	/** Whether plugin is enabled for this directory */
	directoryEnabled: boolean;
	/** Active capability for this directory */
	activeCapability?: string;
	/** Directory-specific settings (masked) */
	directorySettings?: Record<string, unknown>;
	/** Directory plugin entity ID */
	directoryPluginId?: string;
	/** Priority order for this plugin */
	priority?: number;
}

/**
 * Response for plugin list endpoint
 */
export interface PluginListResponse {
	/** List of plugins */
	plugins: UserPluginResponse[];
	/** Total count of plugins */
	total: number;
	/** Available categories */
	categories?: PluginCategory[];
	/** Available capabilities */
	capabilities?: string[];
}

/**
 * Response for directory plugin list endpoint
 */
export interface DirectoryPluginListResponse {
	/** List of plugins */
	plugins: DirectoryPluginResponse[];
	/** Total count of plugins */
	total: number;
	/** Capability providers mapping */
	capabilityProviders?: Record<string, string>;
}
