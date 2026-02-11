import type { ValidationResult, ValidationError } from '../settings/validation.types.js';
import type { JsonSchema } from '../settings/json-schema.types.js';

/**
 * Create a successful validation result
 */
export function validResult(): ValidationResult {
	return { valid: true };
}

/**
 * Create a failed validation result with errors
 */
export function invalidResult(errors: ValidationError[]): ValidationResult {
	return { valid: false, errors };
}

/**
 * Create a validation error
 */
export function createError(
	path: string,
	message: string,
	code?: string,
	expected?: string,
	actual?: unknown
): ValidationError {
	return { path, message, code, expected, actual };
}

/**
 * Combine multiple validation results
 */
export function combineResults(...results: ValidationResult[]): ValidationResult {
	const errors: ValidationError[] = [];
	const warnings: ValidationError[] = [];

	for (const result of results) {
		if (result.errors) {
			errors.push(...result.errors);
		}
		if (result.warnings) {
			warnings.push(...result.warnings);
		}
	}

	return {
		valid: errors.length === 0,
		errors: errors.length > 0 ? errors : undefined,
		warnings: warnings.length > 0 ? warnings : undefined
	};
}

/**
 * Validate required field
 */
export function validateRequired(value: unknown, path: string): ValidationResult {
	if (value === undefined || value === null || value === '') {
		return invalidResult([createError(path, 'This field is required', 'required')]);
	}
	return validResult();
}

/**
 * Validate string type
 */
export function validateString(
	value: unknown,
	path: string,
	options?: {
		minLength?: number;
		maxLength?: number;
		pattern?: string | RegExp;
	}
): ValidationResult {
	if (typeof value !== 'string') {
		return invalidResult([createError(path, 'Must be a string', 'type', 'string', typeof value)]);
	}

	const errors: ValidationError[] = [];

	if (options?.minLength !== undefined && value.length < options.minLength) {
		errors.push(
			createError(
				path,
				`Must be at least ${options.minLength} characters`,
				'minLength',
				`>= ${options.minLength}`,
				value.length
			)
		);
	}

	if (options?.maxLength !== undefined && value.length > options.maxLength) {
		errors.push(
			createError(
				path,
				`Must be at most ${options.maxLength} characters`,
				'maxLength',
				`<= ${options.maxLength}`,
				value.length
			)
		);
	}

	if (options?.pattern) {
		const regex = typeof options.pattern === 'string' ? new RegExp(options.pattern) : options.pattern;
		if (!regex.test(value)) {
			errors.push(createError(path, 'Does not match required pattern', 'pattern', regex.source, value));
		}
	}

	return errors.length > 0 ? invalidResult(errors) : validResult();
}

/**
 * Validate number type
 */
export function validateNumber(
	value: unknown,
	path: string,
	options?: {
		minimum?: number;
		maximum?: number;
		exclusiveMinimum?: number;
		exclusiveMaximum?: number;
		multipleOf?: number;
		integer?: boolean;
	}
): ValidationResult {
	if (typeof value !== 'number' || isNaN(value)) {
		return invalidResult([createError(path, 'Must be a number', 'type', 'number', typeof value)]);
	}

	const errors: ValidationError[] = [];

	if (options?.integer && !Number.isInteger(value)) {
		errors.push(createError(path, 'Must be an integer', 'integer', 'integer', value));
	}

	if (options?.minimum !== undefined && value < options.minimum) {
		errors.push(
			createError(path, `Must be at least ${options.minimum}`, 'minimum', `>= ${options.minimum}`, value)
		);
	}

	if (options?.maximum !== undefined && value > options.maximum) {
		errors.push(createError(path, `Must be at most ${options.maximum}`, 'maximum', `<= ${options.maximum}`, value));
	}

	if (options?.exclusiveMinimum !== undefined && value <= options.exclusiveMinimum) {
		errors.push(
			createError(
				path,
				`Must be greater than ${options.exclusiveMinimum}`,
				'exclusiveMinimum',
				`> ${options.exclusiveMinimum}`,
				value
			)
		);
	}

	if (options?.exclusiveMaximum !== undefined && value >= options.exclusiveMaximum) {
		errors.push(
			createError(
				path,
				`Must be less than ${options.exclusiveMaximum}`,
				'exclusiveMaximum',
				`< ${options.exclusiveMaximum}`,
				value
			)
		);
	}

	if (options?.multipleOf !== undefined && value % options.multipleOf !== 0) {
		errors.push(
			createError(
				path,
				`Must be a multiple of ${options.multipleOf}`,
				'multipleOf',
				`multiple of ${options.multipleOf}`,
				value
			)
		);
	}

	return errors.length > 0 ? invalidResult(errors) : validResult();
}

/**
 * Validate array type
 */
export function validateArray(
	value: unknown,
	path: string,
	options?: {
		minItems?: number;
		maxItems?: number;
		uniqueItems?: boolean;
	}
): ValidationResult {
	if (!Array.isArray(value)) {
		return invalidResult([createError(path, 'Must be an array', 'type', 'array', typeof value)]);
	}

	const errors: ValidationError[] = [];

	if (options?.minItems !== undefined && value.length < options.minItems) {
		errors.push(
			createError(
				path,
				`Must have at least ${options.minItems} items`,
				'minItems',
				`>= ${options.minItems}`,
				value.length
			)
		);
	}

	if (options?.maxItems !== undefined && value.length > options.maxItems) {
		errors.push(
			createError(
				path,
				`Must have at most ${options.maxItems} items`,
				'maxItems',
				`<= ${options.maxItems}`,
				value.length
			)
		);
	}

	if (options?.uniqueItems) {
		const seen = new Set();
		for (let i = 0; i < value.length; i++) {
			const item = JSON.stringify(value[i]);
			if (seen.has(item)) {
				errors.push(createError(`${path}[${i}]`, 'Duplicate item', 'uniqueItems'));
			}
			seen.add(item);
		}
	}

	return errors.length > 0 ? invalidResult(errors) : validResult();
}

/**
 * Validate enum value
 */
export function validateEnum(value: unknown, path: string, allowedValues: readonly unknown[]): ValidationResult {
	if (!allowedValues.includes(value)) {
		return invalidResult([
			createError(
				path,
				`Must be one of: ${allowedValues.map((v) => JSON.stringify(v)).join(', ')}`,
				'enum',
				allowedValues.join(' | '),
				value
			)
		]);
	}
	return validResult();
}

/**
 * Validate URL format
 */
export function validateUrl(value: unknown, path: string): ValidationResult {
	if (typeof value !== 'string') {
		return invalidResult([createError(path, 'Must be a string', 'type', 'string', typeof value)]);
	}

	try {
		new URL(value);
		return validResult();
	} catch {
		return invalidResult([createError(path, 'Must be a valid URL', 'format', 'url', value)]);
	}
}

/**
 * Validate email format
 */
export function validateEmail(value: unknown, path: string): ValidationResult {
	if (typeof value !== 'string') {
		return invalidResult([createError(path, 'Must be a string', 'type', 'string', typeof value)]);
	}

	// Basic email regex
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	if (!emailRegex.test(value)) {
		return invalidResult([createError(path, 'Must be a valid email address', 'format', 'email', value)]);
	}

	return validResult();
}
