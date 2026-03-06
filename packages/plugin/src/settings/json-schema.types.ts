/**
 * JSON Schema types for plugin settings validation.
 * Based on JSON Schema Draft 7 via @types/json-schema, extended with Ever Works custom properties.
 */
import type { JSONSchema7, JSONSchema7TypeName } from 'json-schema';

/**
 * Primitive JSON Schema types
 */
export type JsonSchemaType = JSONSchema7TypeName;

/**
 * Ever Works custom schema extensions for plugin settings
 */
export interface PluginSchemaExtensions {
	/** UI widget type hint */
	readonly 'x-widget'?: string;
	/** Whether field is secret: never returned in API responses, rendered as password input */
	readonly 'x-secret'?: boolean;
	/** Environment variable fallback (checked when no other setting is found) */
	readonly 'x-envVar'?: string;
	/** Setting scope: global, user, or directory */
	readonly 'x-scope'?: 'global' | 'user' | 'directory';
	/** Whether field is admin-only (not visible to regular users) */
	readonly 'x-adminOnly'?: boolean;
	/** Whether field should be hidden from the settings UI entirely */
	readonly 'x-hidden'?: boolean;
	/** Conditional visibility: show this field only when the referenced field matches the given value */
	readonly 'x-showIf'?: { readonly field: string; readonly value: unknown };
	/** Groups of fields where at least one must be set. Each group is independent. */
	readonly 'x-requiredGroups'?: readonly {
		readonly fields: readonly string[];
		readonly message?: string;
	}[];
}

/**
 * JSON Schema definition for a single property or schema.
 * Extends JSONSchema7 with Ever Works custom x-* extensions, recursively applied.
 */
export type JsonSchema = Omit<
	JSONSchema7,
	| 'properties'
	| 'patternProperties'
	| 'additionalProperties'
	| 'items'
	| 'additionalItems'
	| 'contains'
	| 'allOf'
	| 'anyOf'
	| 'oneOf'
	| 'not'
	| 'if'
	| 'then'
	| 'else'
	| 'definitions'
	| 'dependencies'
	| 'examples'
> &
	PluginSchemaExtensions & {
		examples?: readonly unknown[];
		properties?: Record<string, JsonSchema>;
		patternProperties?: Record<string, JsonSchema>;
		additionalProperties?: boolean | JsonSchema;
		items?: JsonSchema | JsonSchema[];
		additionalItems?: boolean | JsonSchema;
		contains?: JsonSchema;
		allOf?: JsonSchema[];
		anyOf?: JsonSchema[];
		oneOf?: JsonSchema[];
		not?: JsonSchema;
		if?: JsonSchema;
		then?: JsonSchema;
		else?: JsonSchema;
		definitions?: Record<string, JsonSchema>;
		dependencies?: Record<string, JsonSchema | string[]>;
	};

/**
 * Root JSON Schema with metadata
 */
export interface RootJsonSchema extends JsonSchema {
	readonly $schema?: string;
	readonly $id?: string;
}
