/**
 * Validation error details
 */
export interface ValidationError {
	/** JSON path to the invalid field */
	readonly path: string;
	/** Error message */
	readonly message: string;
	/** Error code for programmatic handling */
	readonly code?: string;
	/** Expected value or type */
	readonly expected?: string;
	/** Actual value received */
	readonly actual?: unknown;
}

/**
 * Result of validation operation
 */
export interface ValidationResult {
	/** Whether validation passed */
	readonly valid: boolean;
	/** Validation errors if any */
	readonly errors?: readonly ValidationError[];
	/** Warnings that don't fail validation */
	readonly warnings?: readonly ValidationError[];
}

/**
 * Validator function type
 */
export type Validator<T = unknown> = (value: T) => ValidationResult | Promise<ValidationResult>;

/**
 * Validation context passed to validators
 */
export interface ValidationContext {
	/** Current field path */
	readonly path: string;
	/** Parent value if nested */
	readonly parent?: unknown;
	/** Root value being validated */
	readonly root: unknown;
	/** Additional context data */
	readonly data?: Record<string, unknown>;
}

/**
 * Custom validator definition
 */
export interface CustomValidator {
	/** Validator name */
	readonly name: string;
	/** Validator function */
	readonly validate: (value: unknown, context: ValidationContext) => ValidationResult | Promise<ValidationResult>;
	/** Error message template */
	readonly message?: string;
}
