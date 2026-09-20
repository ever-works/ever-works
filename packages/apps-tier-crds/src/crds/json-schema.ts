/**
 * T3 — the JSON-Schema vocabulary the `hosting.ever.works` CRDs are written in
 * (APW-10 plan §3:216–221, plan §3.1–3.2, tasks T3).
 *
 * One source, two artefacts: the objects in `src/crds/*.ts` are TypeScript values that are emitted
 * to `deploy/crds/*.yaml` by `scripts/generate-crds.ts`, so the CRDs the zone installs and the
 * schemas T5's validator reads can never be two different documents (plan §3:218–220).
 *
 * Only the keywords a Kubernetes **structural schema** accepts are declared here, and only the
 * subset this epic uses. Two absences are deliberate and load-bearing:
 *
 * - **`oneOf` / `anyOf` / `not` are not declared at all.** The apiserver rejects them in a CRD's
 *   main schema (`apiextensions-apiserver` forbids the generic value-validation constructs unless
 *   they are nested inside `x-kubernetes-validations`), so "exactly one of `command` / `http`" —
 *   which `AppsTierJob` states in prose — cannot be spelled here. T5's
 *   `work-spec.validator.ts` owns that rule; this module must not claim it.
 * - **`additionalProperties` is either `false` (a closed object) or a value schema**, never the
 *   permissive `true`. A value schema is used only where the contract itself declares a map — the
 *   three `Record<string, …>` members (`pausedReplicas`, `replicasBefore`, `detail`) — so every
 *   other object is a closed shape and an unknown field is a validation error.
 *
 * The root of each manifest must NOT carry `additionalProperties`: the apiserver's structural
 * schema validation rejects it there ("must not be used at the root"); it is declared on `spec`
 * and `status` instead. See `crd.ts:rootSchema`.
 */
import { APPS_TIER_TENANT_NAMESPACE_PREFIX } from '@ever-works/contracts';

/** A JSON-Schema type name. `integer` is distinct from `number` because every count here is one. */
export type JsonSchemaType = 'array' | 'boolean' | 'integer' | 'null' | 'number' | 'object' | 'string';

/**
 * The subset of JSON Schema a structural CRD schema may use, as this epic writes it.
 *
 * `type` accepts an array so a nullable field is `['string', 'null']` — the CRD spelling of
 * `string | null` in `packages/contracts/src/apps/apps-tier.ts`, not the OpenAPI `nullable: true`
 * extension, which a structural schema does not have.
 */
export interface JsonSchema {
	readonly type?: JsonSchemaType | readonly JsonSchemaType[];
	readonly description?: string;
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean | JsonSchema;
	readonly items?: JsonSchema;
	readonly enum?: readonly (string | number | boolean | null)[];
	readonly pattern?: string;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly maxProperties?: number;
	readonly minimum?: number;
	readonly maximum?: number;
}

/**
 * A lowercase UUID — `Work.spec.workId`, `spec.ownerUserId` and every `uuid` column the platform
 * writes onto a `Work` (plan §3.1:231–232, `requestId` at §3.1:239).
 */
export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * A **digest-pinned** image reference — `ghcr.io/<owner>/<repo>@sha256:<64 hex>` (plan §3.1:243).
 *
 * The CRD enforces the pin itself, which is what ACC-10-27's "an image without `@sha256:`" half
 * observes; *which* registry an image may come from is zone configuration and is refused by the
 * controller with `IMAGE_OUTSIDE_TENANT_REGISTRY` (plan §3.1:275), so no host is spelled here.
 * Lowercase hex matches the house digest predicate used by the platform
 * (`packages/agent/src/works-config/schema/app-spec.rules.ts:1334`) and by the k8s plugin
 * (`packages/plugins/k8s/src/app-dependencies/images.ts:116`).
 */
export const DIGEST_PINNED_IMAGE_PATTERN = '^\\S+@sha256:[0-9a-f]{64}$';

/**
 * The tenant namespace the controller assigns — `ewa-<first 20 hex of workId>` (plan §3.1:259).
 *
 * This appears only on `Work.status.namespace`, never on `spec`: a desired state that names a
 * namespace is refused (ACC-10-26), and `spec` is `additionalProperties: false`.
 */
export const TENANT_NAMESPACE_PATTERN = `^${APPS_TIER_TENANT_NAMESPACE_PREFIX}[0-9a-f]{20}$`;

/**
 * The character length of the base64 encoding of `bytes` bytes (with padding).
 *
 * The plan states two seals in **bytes** — a pull credential of at most 8 KiB (plan §3.1:244) and
 * a sealed environment of at most 256 KiB (spec FR-26:294–297) — while the field that carries them
 * is base64 text. `maxLength` is a character bound, so the two units are converted here rather
 * than compared across units by eye: 8 KiB → 10,924 characters, 256 KiB → 349,528.
 */
export function base64EncodedLength(bytes: number): number {
	return Math.ceil(bytes / 3) * 4;
}

/** Add `null` to a schema's `type` list — the CRD spelling of a nullable member. */
export function nullable(schema: JsonSchema): JsonSchema {
	const types: JsonSchemaType[] =
		schema.type === undefined ? [] : typeof schema.type === 'string' ? [schema.type] : [...schema.type];
	return { ...schema, type: [...types, 'null'] };
}

/**
 * A closed object schema: `properties` exactly as given, `additionalProperties: false`, and the
 * caller's `required` list. Every object in this epic is built through it so "unknown field"
 * cannot creep in by omission — that is what makes ACC-10-26's `namespace` rejection a property of
 * the generated CRD rather than of one hand-written copy of it.
 */
export function closedObject(
	properties: Readonly<Record<string, JsonSchema>>,
	options: { readonly description?: string; readonly required?: readonly string[] } = {}
): JsonSchema {
	return {
		type: 'object',
		...(options.description === undefined ? {} : { description: options.description }),
		properties,
		additionalProperties: false,
		...(options.required === undefined ? {} : { required: options.required })
	};
}

/** A non-empty string, optionally bounded and optionally patterned. */
export function stringSchema(options: {
	readonly description?: string;
	readonly pattern?: string;
	readonly maxLength?: number;
	readonly minLength?: number;
}): JsonSchema {
	return {
		type: 'string',
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.pattern === undefined ? {} : { pattern: options.pattern }),
		...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
		...(options.minLength === undefined ? {} : { minLength: options.minLength })
	};
}

/** A string list with a ceiling — `command[]`, `args[]`, `names[]`, `bodyContains[]`, … */
export function stringArraySchema(options: {
	readonly description?: string;
	readonly maxItems?: number;
	readonly itemDescription?: string;
}): JsonSchema {
	return {
		type: 'array',
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
		items:
			options.itemDescription === undefined
				? { type: 'string' }
				: { type: 'string', description: options.itemDescription }
	};
}

/** An integer with a floor, and optionally a ceiling — every count and every `Ms` field. */
export function integerSchema(options: {
	readonly description?: string;
	readonly minimum?: number;
	readonly maximum?: number;
}): JsonSchema {
	return {
		type: 'integer',
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.minimum === undefined ? {} : { minimum: options.minimum }),
		...(options.maximum === undefined ? {} : { maximum: options.maximum })
	};
}

/** A number with a floor — the two `latencyMs` fields, which are not counts of anything. */
export function numberSchema(options: { readonly description?: string; readonly minimum?: number }): JsonSchema {
	return {
		type: 'number',
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.minimum === undefined ? {} : { minimum: options.minimum })
	};
}

/** A member that is a string when present and `null` when it has not happened yet. */
export function nullableStringSchema(description: string): JsonSchema {
	return { type: ['string', 'null'], description };
}

/** An array of one closed object shape, with a ceiling and no floor beyond `minItems`. */
export function arrayOf(
	items: JsonSchema,
	options: { readonly description?: string; readonly maxItems?: number; readonly minItems?: number } = {}
): JsonSchema {
	return {
		type: 'array',
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
		...(options.minItems === undefined ? {} : { minItems: options.minItems }),
		items
	};
}
