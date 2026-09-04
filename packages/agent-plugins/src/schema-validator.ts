/**
 * JSON Schema plumbing.
 *
 * Validation runs against the **canonical upstream schemas**, vendored
 * verbatim under `src/schemas/`, rather than against a hand-written
 * paraphrase of them. That is deliberate: it means a change in the published
 * artifact shows up here as a diff in a vendored file, not as a subtle drift
 * between our reading of the specification and the specification itself.
 *
 * The schemas declare JSON Schema draft 2020-12, so this module uses Ajv's
 * 2020 build. Schemas are added once and compiled on first use; each
 * document and each MCP server variant gets its own validator so callers can
 * preserve the failure boundaries of spec 7.2.2.
 *
 * Where the specification expresses a rule the schema cannot — the severity
 * split of spec 5.2, `name`-equals-directory, URL semantics, header
 * case-insensitivity, containment — the sibling modules hand-roll it. The
 * specification text is authoritative if the two ever disagree, as spec 5.2
 * and 7.2.1 both state.
 */

// The `.js` extension is REQUIRED, not stylistic. ajv 8 publishes no
// `exports` map, so Node's ESM resolver takes this specifier literally: an
// extensionless `ajv/dist/2020` resolves fine under bundler resolution (which
// is why Vitest is happy) and throws ERR_MODULE_NOT_FOUND the moment the built
// ESM bundle is imported by plain Node. CommonJS masks it too, because CJS
// resolution retries with `.js`. A round-trip test imports `dist/index.js` in
// real Node so this cannot regress silently.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import {
	mcpJsonSchema,
	mcpSchemaId,
	pluginJsonSchema,
	pluginSchemaId,
	SUPPORTED_SPEC_VERSIONS,
	type SpecVersion
} from './versions';

/** MCP server variants, keyed by their `$defs` member name in the canonical schema. */
export type McpServerVariant = 'stdioServer' | 'streamableHttpServer' | 'sseServer';

let ajv: Ajv2020 | undefined;

function instance(): Ajv2020 {
	if (ajv) {
		return ajv;
	}
	// `strict: false` — the vendored schemas are fixed artifacts we do not
	// author, and Ajv's strict mode objects to legal constructs in them (a
	// `oneOf` union with no sibling `type`, for one). `allErrors` so a single
	// pass reports every violation instead of only the first.
	const created = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
	for (const version of SUPPORTED_SPEC_VERSIONS) {
		created.addSchema(pluginJsonSchema(version), pluginSchemaId(version));
		created.addSchema(mcpJsonSchema(version), mcpSchemaId(version));
	}
	ajv = created;
	return created;
}

function requireValidator(ref: string): ValidateFunction {
	const validate = instance().getSchema(ref);
	if (!validate) {
		throw new Error(`No compiled JSON Schema validator for "${ref}"`);
	}
	return validate;
}

/** Validator for a whole `plugin.json` document at a given release. */
export function pluginManifestValidator(version: SpecVersion): ValidateFunction {
	return requireValidator(pluginSchemaId(version));
}

/**
 * Validator for one MCP server entry.
 *
 * The canonical schema exposes the variants under `$defs` precisely so that
 * "clients can validate each server independently and preserve the failure
 * boundaries in 7.2.2" (spec 7.2.1). Validating the chosen variant directly,
 * rather than the `oneOf` union, is also what makes a useful message
 * possible: a union failure reports every branch, while a variant failure
 * names the offending field.
 */
export function mcpServerVariantValidator(version: SpecVersion, variant: McpServerVariant): ValidateFunction {
	return requireValidator(`${mcpSchemaId(version)}#/$defs/${variant}`);
}

/**
 * Renders one Ajv error as a short operator-facing sentence.
 *
 * Ajv's own `errorsText` concatenates everything into one line and drops the
 * instance path for root-level failures, which makes findings hard to read
 * and impossible to attribute to a field.
 */
export function describeSchemaError(error: ErrorObject): string {
	const where = error.instancePath === '' ? 'the document root' : `"${error.instancePath}"`;
	if (error.keyword === 'additionalProperties') {
		const extra = (error.params as { additionalProperty?: string }).additionalProperty;
		return `${where} has an unpermitted field "${extra}"`;
	}
	if (error.keyword === 'required') {
		const missing = (error.params as { missingProperty?: string }).missingProperty;
		return `${where} is missing the required field "${missing}"`;
	}
	if (error.keyword === 'propertyNames') {
		return `${where} uses a property name this field does not permit`;
	}
	return `${where} ${error.message ?? 'does not satisfy the schema'}`;
}

/** JSON pointer for the field an Ajv error is about, normalised for findings. */
export function schemaErrorPointer(error: ErrorObject): string {
	if (error.keyword === 'additionalProperties') {
		const extra = (error.params as { additionalProperty?: string }).additionalProperty;
		return `${error.instancePath}/${extra ?? ''}`;
	}
	if (error.keyword === 'required') {
		const missing = (error.params as { missingProperty?: string }).missingProperty;
		return `${error.instancePath}/${missing ?? ''}`;
	}
	return error.instancePath === '' ? '/' : error.instancePath;
}

/** Test seam: drops the cached Ajv instance so a suite can assert on cold-start behaviour. */
export function resetSchemaValidatorCache(): void {
	ajv = undefined;
}
