import type { PluginSettingsSchemaProperty } from './api-response.types.js';

/**
 * A constraint validation error with the field key and human-readable message.
 */
export interface ConstraintError {
	readonly field: string;
	readonly message: string;
}

/**
 * Validate settings values against their schema constraints (min/max, minLength/maxLength, pattern, enum).
 * Skips empty/null/undefined values — required-field checks are handled separately.
 *
 * @param values - Flat key→value map of all settings (regular + secret merged)
 * @param properties - Visible schema properties to validate against
 * @returns Array of constraint errors (empty if all valid)
 */
export function validateSettingsConstraints(
	values: Record<string, unknown>,
	properties: Record<string, PluginSettingsSchemaProperty>
): ConstraintError[] {
	const errors: ConstraintError[] = [];

	for (const [key, propSchema] of Object.entries(properties)) {
		const val = values[key];
		if (val === undefined || val === null || val === '') continue;

		const label = propSchema.title || key;

		if (propSchema.type === 'number' && typeof val === 'number') {
			if (propSchema.minimum !== undefined && val < propSchema.minimum) {
				errors.push({ field: key, message: `${label} must be at least ${propSchema.minimum}` });
			}
			if (propSchema.maximum !== undefined && val > propSchema.maximum) {
				errors.push({ field: key, message: `${label} must be at most ${propSchema.maximum}` });
			}
		}

		if (propSchema.type === 'string' && typeof val === 'string') {
			if (propSchema.minLength !== undefined && val.length < propSchema.minLength) {
				errors.push({
					field: key,
					message: `${label} must be at least ${propSchema.minLength} characters`
				});
			}
			if (propSchema.maxLength !== undefined && val.length > propSchema.maxLength) {
				errors.push({
					field: key,
					message: `${label} must be at most ${propSchema.maxLength} characters`
				});
			}
			if (propSchema.pattern) {
				try {
					if (!new RegExp(propSchema.pattern).test(val)) {
						errors.push({ field: key, message: `${label} has an invalid format` });
					}
				} catch {
					// ignore invalid regex from schema
				}
			}
		}

		if (propSchema.enum && propSchema.enum.length > 0) {
			if (!propSchema.enum.includes(val)) {
				errors.push({
					field: key,
					message: `${label} must be one of: ${propSchema.enum.join(', ')}`
				});
			}
		}
	}

	return errors;
}
