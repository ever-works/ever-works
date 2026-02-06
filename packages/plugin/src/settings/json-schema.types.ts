/**
 * JSON Schema types for plugin settings validation
 * Based on JSON Schema Draft 7
 */

/**
 * Primitive JSON Schema types
 */
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/**
 * String format validators
 */
export type JsonSchemaStringFormat =
	| 'date-time'
	| 'date'
	| 'time'
	| 'email'
	| 'uri'
	| 'uri-reference'
	| 'hostname'
	| 'ipv4'
	| 'ipv6'
	| 'uuid'
	| 'regex';

/**
 * JSON Schema definition for a single property or schema
 */
export interface JsonSchema {
	/** Schema type */
	readonly type?: JsonSchemaType | readonly JsonSchemaType[];

	/** Schema title for display */
	readonly title?: string;

	/** Schema description */
	readonly description?: string;

	/** Default value */
	readonly default?: unknown;

	/** Example values */
	readonly examples?: readonly unknown[];

	// String constraints
	/** Minimum string length */
	readonly minLength?: number;
	/** Maximum string length */
	readonly maxLength?: number;
	/** Regular expression pattern */
	readonly pattern?: string;
	/** String format */
	readonly format?: JsonSchemaStringFormat | string;

	// Number constraints
	/** Minimum value */
	readonly minimum?: number;
	/** Maximum value */
	readonly maximum?: number;
	/** Exclusive minimum value */
	readonly exclusiveMinimum?: number;
	/** Exclusive maximum value */
	readonly exclusiveMaximum?: number;
	/** Value must be a multiple of this */
	readonly multipleOf?: number;

	// Object constraints
	/** Object properties */
	readonly properties?: Record<string, JsonSchema>;
	/** Required property names */
	readonly required?: readonly string[];
	/** Additional properties schema or boolean */
	readonly additionalProperties?: boolean | JsonSchema;
	/** Minimum number of properties */
	readonly minProperties?: number;
	/** Maximum number of properties */
	readonly maxProperties?: number;
	/** Property name pattern to schema mapping */
	readonly patternProperties?: Record<string, JsonSchema>;
	/** Property dependencies */
	readonly dependencies?: Record<string, JsonSchema | readonly string[]>;

	// Array constraints
	/** Array items schema */
	readonly items?: JsonSchema | readonly JsonSchema[];
	/** Additional items schema (for tuple validation) */
	readonly additionalItems?: boolean | JsonSchema;
	/** Minimum number of items */
	readonly minItems?: number;
	/** Maximum number of items */
	readonly maxItems?: number;
	/** All items must be unique */
	readonly uniqueItems?: boolean;
	/** Array must contain items matching this schema */
	readonly contains?: JsonSchema;

	// Enum and const
	/** Enumerated allowed values */
	readonly enum?: readonly unknown[];
	/** Constant value */
	readonly const?: unknown;

	// Composition
	/** Must match all schemas */
	readonly allOf?: readonly JsonSchema[];
	/** Must match at least one schema */
	readonly anyOf?: readonly JsonSchema[];
	/** Must match exactly one schema */
	readonly oneOf?: readonly JsonSchema[];
	/** Must not match this schema */
	readonly not?: JsonSchema;

	// Conditional
	/** Condition schema */
	readonly if?: JsonSchema;
	/** Schema to apply if condition matches */
	readonly then?: JsonSchema;
	/** Schema to apply if condition does not match */
	readonly else?: JsonSchema;

	// References
	/** Reference to another schema */
	readonly $ref?: string;
	/** Schema definitions for references */
	readonly definitions?: Record<string, JsonSchema>;
	readonly $defs?: Record<string, JsonSchema>;

	// UI extensions (for form generation)
	/** UI widget type hint */
	readonly 'x-widget'?: string;
	/** UI display order */
	readonly 'x-order'?: number;
	/** UI group/section */
	readonly 'x-group'?: string;
	/** UI visibility condition */
	readonly 'x-visible-if'?: Record<string, unknown>;
	/** Whether field is secret (e.g., API keys) */
	readonly 'x-secret'?: boolean;
	/** Placeholder text */
	readonly 'x-placeholder'?: string;

	// Plugin settings extensions
	/** Environment variable fallback (checked when no other setting is found) */
	readonly 'x-envVar'?: string;
	/** Setting scope: global, user, or directory */
	readonly 'x-scope'?: 'global' | 'user' | 'directory';
	/** Category for grouping settings in UI */
	readonly 'x-category'?: string;
	/** Whether changes require plugin restart */
	readonly 'x-requiresRestart'?: boolean;
	/** Whether field should be masked in UI (for secrets) */
	readonly 'x-masked'?: boolean;
	/** Whether field should be write-only (not readable after set) */
	readonly 'x-writeOnly'?: boolean;
	/** Whether field is admin-only (not visible to regular users) */
	readonly 'x-adminOnly'?: boolean;
	/** Whether field should be hidden from the settings UI entirely */
	readonly 'x-hidden'?: boolean;
}

/**
 * Root JSON Schema with metadata
 */
export interface RootJsonSchema extends JsonSchema {
	/** JSON Schema version */
	readonly $schema?: string;
	/** Schema identifier */
	readonly $id?: string;
}
