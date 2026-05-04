import type {
	PluginSettings,
	ResolvedSetting,
	ResolvedSettings,
	SettingDefinition,
	SettingSource
} from '../settings/settings.types.js';
import type { EnvironmentVariables } from '../contracts/plugin-environment.interface.js';

/**
 * Settings resolution priority (highest to lowest)
 */
export const SETTINGS_PRIORITY: readonly SettingSource[] = ['user', 'work', 'admin', 'env', 'default'] as const;

/**
 * Settings layers for resolution
 */
export interface SettingsLayers {
	readonly default?: PluginSettings;
	readonly env?: PluginSettings;
	readonly admin?: PluginSettings;
	readonly work?: PluginSettings;
	readonly user?: PluginSettings;
}

/**
 * Resolve a single setting value from layers
 */
export function resolveSetting<T = unknown>(
	key: string,
	layers: SettingsLayers,
	definition?: SettingDefinition
): ResolvedSetting<T> {
	// Check each layer in priority order
	for (const scope of ['user', 'work', 'admin'] as const) {
		const layer = layers[scope];
		if (layer && key in layer && layer[key] !== undefined) {
			return {
				key,
				value: layer[key] as T,
				source: scope,
				isFallback: false
			};
		}
	}

	// Check environment variable
	if (layers.env && key in layers.env && layers.env[key] !== undefined) {
		return {
			key,
			value: layers.env[key] as T,
			source: 'env',
			isFallback: false
		};
	}

	// Use default
	const defaultValue = layers.default?.[key] ?? definition?.defaultValue;
	return {
		key,
		value: defaultValue as T,
		source: 'default',
		isFallback: true
	};
}

/**
 * Resolve all settings from layers
 */
export function resolveSettings(definitions: readonly SettingDefinition[], layers: SettingsLayers): ResolvedSettings {
	const result: Record<string, ResolvedSetting> = {};

	for (const definition of definitions) {
		result[definition.key] = resolveSetting(definition.key, layers, definition);
	}

	return result;
}

/**
 * Get flat settings values from resolved settings
 */
export function getFlatSettings(resolved: ResolvedSettings): PluginSettings {
	const result: PluginSettings = {};

	for (const [key, setting] of Object.entries(resolved)) {
		result[key] = setting.value;
	}

	return result;
}

/**
 * Load settings from environment variables
 */
export function loadSettingsFromEnv(
	definitions: readonly SettingDefinition[],
	envVars: EnvironmentVariables
): PluginSettings {
	const result: PluginSettings = {};

	for (const definition of definitions) {
		if (definition.envVar && envVars.has(definition.envVar)) {
			const value = envVars.get(definition.envVar);
			if (value !== undefined) {
				result[definition.key] = parseEnvValue(value, definition);
			}
		}
	}

	return result;
}

/**
 * Parse environment variable value based on setting schema
 */
function parseEnvValue(value: string, definition: SettingDefinition): unknown {
	const schemaType = definition.schema.type;

	if (Array.isArray(schemaType)) {
		// Try each type in order
		for (const type of schemaType) {
			try {
				return parseValueAsType(value, type);
			} catch {
				continue;
			}
		}
		return value;
	}

	return parseValueAsType(value, schemaType as string);
}

/**
 * Parse value as a specific type
 */
function parseValueAsType(value: string, type: string | undefined): unknown {
	switch (type) {
		case 'boolean':
			return value.toLowerCase() === 'true' || value === '1';
		case 'number':
		case 'integer':
			const num = Number(value);
			if (isNaN(num)) throw new Error('Invalid number');
			return num;
		case 'array':
		case 'object':
			try {
				return JSON.parse(value);
			} catch {
				return value;
			}
		case 'null':
			return null;
		default:
			return value;
	}
}

/**
 * Merge settings layers
 */
export function mergeSettings(...layers: (PluginSettings | undefined)[]): PluginSettings {
	const result: PluginSettings = {};

	for (const layer of layers) {
		if (layer) {
			Object.assign(result, layer);
		}
	}

	return result;
}

/**
 * Get settings that differ from defaults
 */
export function getChangedSettings(current: PluginSettings, defaults: PluginSettings): PluginSettings {
	const changed: PluginSettings = {};

	for (const [key, value] of Object.entries(current)) {
		if (!deepEqual(value, defaults[key])) {
			changed[key] = value;
		}
	}

	return changed;
}

/**
 * Deep equality check
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;

	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((item, index) => deepEqual(item, b[index]));
	}

	if (typeof a === 'object' && typeof b === 'object') {
		const keysA = Object.keys(a as object);
		const keysB = Object.keys(b as object);
		if (keysA.length !== keysB.length) return false;
		return keysA.every((key) =>
			deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
		);
	}

	return false;
}
