/**
 * zod 4 → JSON Schema for `AiOperations.askJson` structured output.
 *
 * Why this file exists: under zod 3, `askJson` handed the zod schema straight to
 * LangChain's `withStructuredOutput`, which converted it with OpenAI's own zod-3
 * helper. With zod 4 that is no longer safe on our pinned LangChain (0.3 / 0.6):
 *
 * - its zod-4 path converts with the zod copy LangChain bundles, whose metadata
 *   registry is not ours, so every `.describe()` (the field-by-field extraction
 *   instructions) silently disappears from the request;
 * - its JSON-schema step rewrites object shapes IN PLACE, stripping every
 *   `.transform()` from the caller's schema for the rest of the process;
 * - OpenAI's zod-3 helper refused an object property that is `.optional()`
 *   without `.nullable()` before any request went out, and `askJson` then fell
 *   back to a plain completion + jsonrepair. The zod-4 path sends such a schema
 *   anyway, the API rejects it, and the model gets marked as having no
 *   structured output for the rest of the process.
 *
 * So `askJson` now converts the schema itself (with the same zod instance that
 * built it), keeps the zod-3 client-side refusal, gives LangChain plain JSON
 * Schema, and validates the answer with the caller's schema.
 */
import { z, type ZodType } from 'zod';

/** The JSON Schema object handed to LangChain. */
export type StructuredOutputJsonSchema = Record<string, unknown>;

/** The tool / response-format name LangChain used by default. */
export const STRUCTURED_OUTPUT_NAME = 'extract';

/**
 * Mirrors `ChatOpenAI._getStructuredOutputMethod` (@langchain/openai 0.6) for a call
 * without an explicit `method`: every model uses the `json_schema` response format
 * except `gpt-3*`, `gpt-4-*` and `gpt-4`, which use function calling.
 */
export function usesJsonSchemaResponseFormat(model: string): boolean {
	return !(model.startsWith('gpt-3') || model.startsWith('gpt-4-') || model === 'gpt-4');
}

type ZodDefLike = { type?: string; [key: string]: unknown };

function defOf(schema: unknown): ZodDefLike | undefined {
	return (schema as { _zod?: { def?: ZodDefLike } } | undefined)?._zod?.def;
}

function accepts(schema: ZodType, value: unknown): boolean {
	return schema.safeParse(value).success;
}

/**
 * The zod-3 helper's rule, verbatim: an object property that accepts `undefined`,
 * rejects `null` and has no `.default()` cannot be expressed in OpenAI's strict
 * mode. Returns the JSON pointer of the first such property (nested properties
 * first, as the zod-3 helper reported them), or `undefined` when there is none.
 */
export function findOptionalWithoutNullable(
	schema: ZodType,
	path: readonly string[] = ['#', 'definitions', STRUCTURED_OUTPUT_NAME],
	seen: Set<unknown> = new Set()
): string | undefined {
	if (seen.has(schema)) return undefined;
	seen.add(schema);
	const def = defOf(schema);
	if (!def) return undefined;
	const child = (next: unknown, nextPath: readonly string[] = path) =>
		next ? findOptionalWithoutNullable(next as ZodType, nextPath, seen) : undefined;

	switch (def.type) {
		case 'object': {
			const shape = (def.shape ?? {}) as Record<string, ZodType>;
			for (const [key, prop] of Object.entries(shape)) {
				const propPath = [...path, 'properties', key];
				const nested = child(prop, propPath);
				if (nested) return nested;
				if (accepts(prop, undefined) && !accepts(prop, null) && defOf(prop)?.type !== 'default') {
					return propPath.join('/');
				}
			}
			return child(def.catchall, [...path, 'additionalProperties']);
		}
		case 'array':
			return child(def.element, [...path, 'items']);
		case 'tuple': {
			const items = (def.items ?? []) as ZodType[];
			for (const [index, item] of items.entries()) {
				const found = child(item, [...path, 'items', String(index)]);
				if (found) return found;
			}
			return child(def.rest, [...path, 'additionalItems']);
		}
		case 'union': {
			const options = (def.options ?? []) as ZodType[];
			for (const [index, option] of options.entries()) {
				const found = child(option, [...path, 'anyOf', String(index)]);
				if (found) return found;
			}
			return undefined;
		}
		case 'intersection':
			return child(def.left, [...path, 'allOf', '0']) ?? child(def.right, [...path, 'allOf', '1']);
		case 'record':
			return child(def.valueType, [...path, 'additionalProperties']);
		case 'pipe':
			return child(def.in) ?? child(def.out);
		case 'lazy':
			return typeof def.getter === 'function' ? child((def.getter as () => unknown)()) : undefined;
		case 'optional':
		case 'nullable':
		case 'default':
		case 'prefault':
		case 'catch':
		case 'readonly':
		case 'nonoptional':
		case 'promise':
			return child(def.innerType);
		default:
			return undefined;
	}
}

/** The error the zod-3 helper threw, so the fallback log line reads the same. */
export function optionalWithoutNullableError(pointer: string): Error {
	return new Error(
		`Zod field at \`${pointer}\` uses \`.optional()\` without \`.nullable()\` which is not supported by the API. See: https://platform.openai.com/docs/guides/structured-outputs?api-mode=responses#all-fields-must-be-required`
	);
}

const SCHEMA_CHILD_MAPS = ['properties', 'definitions', '$defs', 'patternProperties'] as const;
const SCHEMA_CHILD_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const;
const SCHEMA_CHILD_NODES = ['items', 'additionalProperties', 'additionalItems', 'not'] as const;

function isNode(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shapes every object node the way the zod-3 converter did: unknown keys closed
 * (`additionalProperties: false`) unless the schema says otherwise, and — in
 * OpenAI strict mode — every property listed in `required`.
 */
function normalizeObjects(node: unknown, strict: boolean): void {
	if (Array.isArray(node)) {
		for (const entry of node) normalizeObjects(entry, strict);
		return;
	}
	if (!isNode(node)) return;
	if (isNode(node.properties)) {
		if (node.additionalProperties === undefined) node.additionalProperties = false;
		if (strict) {
			const keys = Object.keys(node.properties);
			if (keys.length) node.required = keys;
		}
	}
	for (const key of SCHEMA_CHILD_MAPS) {
		const map = node[key];
		if (isNode(map)) for (const value of Object.values(map)) normalizeObjects(value, strict);
	}
	for (const key of SCHEMA_CHILD_LISTS) normalizeObjects(node[key], strict);
	for (const key of SCHEMA_CHILD_NODES) {
		const value = node[key];
		if (isNode(value) || Array.isArray(value)) normalizeObjects(value, strict);
	}
}

/**
 * Converts the caller's zod schema to the JSON Schema LangChain sends. `strict`
 * marks the OpenAI strict `json_schema` response format. Transforms are described
 * by their input (what the model must produce); types JSON Schema cannot express
 * become `{}` instead of failing the call.
 */
export function toStructuredOutputJsonSchema(schema: ZodType, strict: boolean): StructuredOutputJsonSchema {
	const jsonSchema = z.toJSONSchema(schema, {
		target: 'draft-07',
		io: 'input',
		unrepresentable: 'any'
	}) as StructuredOutputJsonSchema;
	delete jsonSchema.$schema;
	normalizeObjects(jsonSchema, strict);
	return jsonSchema;
}
