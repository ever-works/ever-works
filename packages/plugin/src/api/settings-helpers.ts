import type { PluginSettingsSchema, PluginSettingsSchemaProperty, SettingScopeApi } from './api-response.types.js';

/**
 * Split settings into regular and secret buckets based on schema.
 * Populates schema defaults for visible-in-scope fields with no saved value.
 */
export function splitSettingsBySecret(
	settings: Record<string, unknown>,
	schema: PluginSettingsSchema | undefined,
	scopes: SettingScopeApi[]
): { regular: Record<string, unknown>; secret: Record<string, unknown> } {
	const regular: Record<string, unknown> = {};
	const secret: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(settings)) {
		const propSchema = schema?.properties?.[key] as PluginSettingsSchemaProperty | undefined;
		if (propSchema?.secret) {
			secret[key] = value;
		} else {
			regular[key] = value;
		}
	}

	if (schema?.properties) {
		for (const [key, propSchema] of Object.entries(schema.properties)) {
			const prop = propSchema as PluginSettingsSchemaProperty;
			if (prop.hidden || prop.default === undefined) continue;
			const propScope = (prop.scope || 'global') as SettingScopeApi;
			if (!scopes.includes(propScope)) continue;

			const target = prop.secret ? secret : regular;
			if (!(key in target)) {
				target[key] = prop.default;
			}
		}
	}

	return { regular, secret };
}

/**
 * Filter schema properties by scope and exclude hidden fields.
 */
export function getVisibleProperties(
	schema: PluginSettingsSchema | undefined,
	scopes: SettingScopeApi[]
): Record<string, PluginSettingsSchemaProperty> {
	if (!schema?.properties) return {};
	return Object.fromEntries(
		Object.entries(schema.properties).filter(([_, propSchema]) => {
			const prop = propSchema as PluginSettingsSchemaProperty;
			if (prop.hidden) return false;
			const scope = prop.scope || 'global';
			return scopes.includes(scope as SettingScopeApi);
		})
	);
}

/**
 * Filter schema.required by scope — only fields visible in the given scopes.
 */
export function getRequiredFields(schema: PluginSettingsSchema | undefined, scopes: SettingScopeApi[]): string[] {
	if (!schema?.required || !schema.properties) return [];
	return schema.required.filter((field) => {
		const propSchema = schema.properties?.[field] as PluginSettingsSchemaProperty | undefined;
		if (!propSchema) return false;
		const scope = propSchema.scope || 'global';
		return scopes.includes(scope as SettingScopeApi);
	});
}

/**
 * Returns human-readable labels for missing required fields.
 * At directory scope, allows inheritance from fallbackSettings.
 * Also validates requiredGroups.
 */
export function validateRequiredSettings(
	settings: Record<string, unknown>,
	secretSettings: Record<string, unknown>,
	schema: PluginSettingsSchema | undefined,
	scopes: SettingScopeApi[],
	scope: 'user' | 'directory',
	fallbackSettings?: Record<string, unknown>
): string[] {
	const errors: string[] = [];
	const requiredFields = getRequiredFields(schema, scopes);

	for (const field of requiredFields) {
		const value = settings[field] ?? secretSettings[field];
		const isEmpty = value === undefined || value === null || value === '';

		if (isEmpty) {
			if (scope === 'directory' && fallbackSettings) {
				const inheritedValue = fallbackSettings[field];
				if (inheritedValue !== undefined && inheritedValue !== null && inheritedValue !== '') {
					continue;
				}
			}

			const propSchema = schema?.properties?.[field] as PluginSettingsSchemaProperty | undefined;
			errors.push(propSchema?.title || field);
		}
	}

	// Validate requiredGroups
	const requiredGroups = getRequiredGroups(schema, scopes);
	for (const group of requiredGroups) {
		const hasAnyLocal = group.fields.some((field) => {
			const value = settings[field] ?? secretSettings[field];
			return value !== undefined && value !== null && value !== '';
		});

		let hasAnyInherited = false;
		if (scope === 'directory' && fallbackSettings) {
			hasAnyInherited = group.fields.some((field) => {
				const value = fallbackSettings[field];
				return value !== undefined && value !== null && value !== '';
			});
		}

		if (!hasAnyLocal && !hasAnyInherited) {
			const labels = group.fields.map((f) => {
				const ps = schema?.properties?.[f] as PluginSettingsSchemaProperty | undefined;
				return ps?.title || f;
			});
			errors.push(group.message || `At least one of: ${labels.join(', ')}`);
		}
	}

	return errors;
}

/**
 * Sanitize settings for save: undefined → null, empty string → null at directory scope.
 */
export function sanitizeSettingsForSave(
	settings: Record<string, unknown>,
	scope: 'user' | 'directory'
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(settings)) {
		if (value === undefined) {
			result[key] = null;
		} else if (scope === 'directory' && value === '') {
			result[key] = null;
		} else {
			result[key] = value;
		}
	}
	return result;
}

function getRequiredGroups(
	schema: PluginSettingsSchema | undefined,
	scopes: SettingScopeApi[]
): { fields: string[]; message?: string }[] {
	if (!schema?.requiredGroups || !schema.properties) return [];
	return schema.requiredGroups
		.map((group) => ({
			...group,
			fields: group.fields.filter((field) => {
				const propSchema = schema.properties?.[field] as PluginSettingsSchemaProperty | undefined;
				if (!propSchema) return false;
				const scope = propSchema.scope || 'global';
				return scopes.includes(scope as SettingScopeApi);
			})
		}))
		.filter((group) => group.fields.length > 0);
}
