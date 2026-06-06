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
				// Security (ReDoS): `pattern` comes from a (possibly third-party) plugin's
				// JSON schema and `val` is user-supplied, so a pathological pattern such as
				// `(a+)+$` against a long value can trigger catastrophic (exponential)
				// backtracking and stall the event loop. The built-in RegExp engine has no
				// timeout, so bound both inputs before evaluating. Exponential blow-up scales
				// with the tested string length, so capping the value short enough keeps even
				// worst-case patterns to a few milliseconds; every legitimate pattern-checked
				// setting (slugs, keys, hostnames, semver, etc.) is far shorter than this.
				// Over-length inputs are reported as a format failure (additive — never
				// silently passed). Patterns are also length-capped as defense-in-depth.
				const MAX_PATTERN_LENGTH = 1000;
				const MAX_PATTERN_TEST_LENGTH = 512;
				if (propSchema.pattern.length > MAX_PATTERN_LENGTH || val.length > MAX_PATTERN_TEST_LENGTH) {
					errors.push({ field: key, message: `${label} has an invalid format` });
				} else {
					try {
						if (!new RegExp(propSchema.pattern).test(val)) {
							errors.push({ field: key, message: `${label} has an invalid format` });
						}
					} catch {
						// ignore invalid regex from schema
					}
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
