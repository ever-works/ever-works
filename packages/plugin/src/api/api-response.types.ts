/**
 * API Response types for plugin endpoints.
 * These types define the shape of plugin data returned by the API.
 */

import type {
	PluginCategory,
	PluginAuthor,
	PluginIcon,
	PluginVisibility,
	PluginUiHints
} from '../contracts/plugin-manifest.types.js';

export type { PluginUiHints };
import type { PluginState } from '../contracts/lifecycle.types.js';
import type { ConfigurationMode } from '../settings/settings.types.js';
import type { JsonSchema, JsonSchemaType } from '../settings/json-schema.types.js';
import type { ProviderModelSummary } from '../contracts/capabilities/form-schema-provider.interface.js';

/**
 * Setting scope determines where the setting value is stored and who can configure it.
 */
export type SettingScopeApi = 'global' | 'user' | 'work';

/**
 * Plugin settings schema property for API responses.
 * This is a flattened view of JsonSchema for UI convenience.
 * The API transforms JsonSchema's x-prefixed properties into flat properties.
 */
export interface PluginSettingsSchemaProperty {
	/** Property type (e.g., 'string', 'number', 'boolean') */
	type: JsonSchemaType | readonly JsonSchemaType[];
	/** Property title for display */
	title?: string;
	/** Property description */
	description?: string;
	/** Default value */
	default?: unknown;
	/** Example values */
	examples?: readonly unknown[];
	/** Whether this is a secret field: never returned in API responses, rendered as password input (from JsonSchema x-secret) */
	secret?: boolean;
	/** Whether this field is admin-only (from JsonSchema x-adminOnly) */
	adminOnly?: boolean;
	/** Environment variable name if field is env-only (from JsonSchema x-envVar) */
	envVar?: string;
	/** Setting scope: global, user, or work (from JsonSchema x-scope) */
	scope?: SettingScopeApi;
	/** Enumerated allowed values */
	enum?: readonly unknown[];
	/** Constant value */
	const?: unknown;
	/** UI widget type hint (e.g., 'model-select') */
	widget?: string;
	/** Whether field should be hidden from the settings UI (from JsonSchema x-hidden) */
	hidden?: boolean;
	/** Conditional visibility: show only when the referenced field matches the given value (from JsonSchema x-showIf) */
	showIf?: { field: string; value: unknown };
	/** Minimum value for number fields */
	minimum?: number;
	/** Maximum value for number fields */
	maximum?: number;
	/** Minimum string length */
	minLength?: number;
	/** Maximum string length */
	maxLength?: number;
	/** Regular expression pattern for string fields */
	pattern?: string;
	/** String format */
	format?: string;
	/** Array items schema */
	items?: PluginSettingsSchemaProperty;
	/** Minimum number of items */
	minItems?: number;
	/** Maximum number of items */
	maxItems?: number;
	/** All items must be unique */
	uniqueItems?: boolean;
	/** Properties for object-type fields */
	properties?: Record<string, PluginSettingsSchemaProperty>;
	/** Required property names */
	required?: readonly string[];
	/** Groups of fields where at least one must be set. Each group is independent. */
	requiredGroups?: readonly {
		readonly fields: readonly string[];
		readonly message?: string;
	}[];
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
	/** Groups where at least one field must be set */
	requiredGroups?: { fields: string[]; message?: string }[];
}

/**
 * Transform a JsonSchema into a PluginSettingsSchemaProperty.
 * This flattens x-prefixed properties into flat properties.
 */
export function toPluginSettingsSchemaProperty(schema: JsonSchema): PluginSettingsSchemaProperty {
	return {
		type: schema.type ?? 'string',
		title: schema.title,
		description: schema.description,
		default: schema.default,
		examples: schema.examples,
		secret: schema['x-secret'],
		adminOnly: schema['x-adminOnly'],
		envVar: schema['x-envVar'],
		scope: schema['x-scope'] ?? 'global',
		enum: schema.enum,
		const: schema.const,
		widget: schema['x-widget'],
		hidden: schema['x-hidden'],
		showIf: schema['x-showIf'],
		minimum: schema.minimum,
		maximum: schema.maximum,
		minLength: schema.minLength,
		maxLength: schema.maxLength,
		pattern: schema.pattern,
		format: schema.format,
		items: schema.items ? toPluginSettingsSchemaProperty(schema.items as JsonSchema) : undefined,
		minItems: schema.minItems,
		maxItems: schema.maxItems,
		uniqueItems: schema.uniqueItems,
		properties: schema.properties
			? Object.fromEntries(
					Object.entries(schema.properties).map(([key, propSchema]) => [
						key,
						toPluginSettingsSchemaProperty(propSchema)
					])
				)
			: undefined,
		required: schema.required,
		requiredGroups: schema['x-requiredGroups']
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
	/** Plugin readme (markdown) */
	readme?: string;
	/** Plugin category */
	category: PluginCategory;
	/** Plugin capabilities */
	capabilities: string[];
	/** Configuration mode */
	configurationMode: ConfigurationMode;
	/** Whether plugin is built-in */
	builtIn: boolean;
	/** Whether this is a system plugin that cannot be disabled */
	systemPlugin: boolean;
	/** UI visibility: 'public', 'hidden', or 'user-only' */
	visibility: PluginVisibility;
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
	/** Whether plugin is auto-enabled */
	autoEnable?: boolean;
	/** Whether this plugin is supplementary (auto-activated; not user-selectable as active provider) */
	supplementary?: boolean;
	/** UI behavior hints declared by the plugin. Drives plugin-specific UI without hardcoding IDs. */
	uiHints?: PluginUiHints;
}

export interface PluginConnectionStatus {
	/** Whether the plugin currently has enough auth/configuration to be considered connected. */
	connected: boolean;
	/** Whether an interactive auth flow is still in progress. */
	pending?: boolean;
	/** Scope of the active connection, when known. */
	scope?: 'user' | 'work';
	/** Human-readable status message. */
	message?: string;
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
	/** Resolved display settings for the current user.
	 * Non-secret values are returned as-is; secrets are masked for display only. */
	resolvedSettings?: Record<string, unknown>;
	/** User-specific metadata (read-only state) */
	metadata?: Record<string, unknown>;
	/** User plugin entity ID */
	userPluginId?: string;
	/** Whether this plugin is auto-enabled for all works */
	autoEnableForWorks?: boolean;
	/** Generic connection/readiness status used by onboarding and settings UI. */
	connectionStatus?: PluginConnectionStatus;
	/** Effective model settings for AI providers, resolved for the current scope. */
	models?: ProviderModelSummary[];
}

/**
 * Plugin response with work-specific data
 */
export interface WorkPluginResponse extends UserPluginResponse {
	/** Whether plugin is enabled for this work */
	workEnabled: boolean;
	/** Active capabilities for this work */
	activeCapabilities?: string[];
	/** Work-specific settings (masked) */
	workSettings?: Record<string, unknown>;
	/** Work plugin entity ID */
	workPluginId?: string;
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
 * Response for work plugin list endpoint
 */
export interface WorkPluginListResponse {
	/** List of plugins */
	plugins: WorkPluginResponse[];
	/** Total count of plugins */
	total: number;
	/** Capability providers mapping */
	capabilityProviders?: Record<string, string>;
}

/**
 * Plugin information for settings menu
 */
export interface SettingsMenuPlugin {
	/** Plugin unique identifier */
	pluginId: string;
	/** Plugin display name */
	name: string;
	/** Plugin icon */
	icon?: PluginIcon;
	/** Whether plugin is enabled */
	enabled: boolean;
	/** Whether plugin has required settings that are not configured */
	hasRequiredSettings: boolean;
}

/**
 * Category grouping for settings menu
 */
export interface SettingsMenuCategory {
	/** Category identifier */
	category: PluginCategory;
	/** Category display label */
	label: string;
	/** Plugins in this category */
	plugins: SettingsMenuPlugin[];
}

/**
 * Response for settings menu endpoint
 */
export interface SettingsMenuResponse {
	/** Categories with plugins */
	categories: SettingsMenuCategory[];
}
