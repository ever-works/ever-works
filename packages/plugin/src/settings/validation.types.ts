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
