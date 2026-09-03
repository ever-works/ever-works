/**
 * `plugin.json` — the manifest (spec 5).
 *
 * The manifest schema is *closed*: only `$schema`, `name`, `version`,
 * `description`, `author`, `homepage`, `repository`, `license`, `keywords`
 * and `extensions` are permitted. What makes this module more than an Ajv
 * call is the severity split of spec 5.2, which draws a line straight
 * through "does not conform to the schema":
 *
 *   - an **unknown top-level field** → report it, ignore it, keep loading;
 *   - a **non-object `extensions`** → report it, ignore it, keep loading;
 *   - **anything else** → fatal. Reject the plugin and discover nothing.
 *
 * A plain `additionalProperties: false` validation cannot express that, so
 * the two tolerated cases are stripped (with a finding each) *before* the
 * document reaches the schema, and any surviving violation is fatal by
 * definition.
 *
 * The other half of the specification's leniency is about what we must NOT
 * reject (spec 5.4): a `version` that is not semver, a `homepage`,
 * `repository` or `author.url` that is not a recognisable URL, an
 * `author.email` that is not an email, a `license` that is not an SPDX
 * identifier. Metadata is type-checked and nothing more. The canonical
 * schema already encodes exactly that, which is one reason to validate
 * against it verbatim.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finding, type Finding } from './findings';
import { describeSchemaError, pluginManifestValidator, schemaErrorPointer } from './schema-validator';
import { specVersionFromPluginSchemaId, supportedPluginSchemaIds, type SpecVersion } from './versions';

/** The manifest file name, fixed at the plugin root by spec 5.1. */
export const MANIFEST_FILENAME = 'plugin.json';

/** Author object — a closed set of optional string fields (spec 5.4). */
export interface AgentPluginAuthor {
	readonly name?: string;
	readonly email?: string;
	readonly url?: string;
}

/** A validated `plugin.json`. Unknown top-level fields are absent by construction. */
export interface AgentPluginManifest {
	readonly $schema: string;
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	readonly author?: AgentPluginAuthor;
	readonly homepage?: string;
	readonly repository?: string;
	readonly license?: string;
	readonly keywords?: readonly string[];
	/**
	 * Client-specific data keyed by reverse-domain namespace. Namespaces we
	 * do not implement are carried through untouched and unvalidated
	 * (spec 8.1) — a consumer must not assume anything about their contents.
	 */
	readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Every top-level field the manifest schema permits, in specification order. */
export const PERMITTED_MANIFEST_FIELDS: readonly string[] = [
	'$schema',
	'name',
	'version',
	'description',
	'author',
	'homepage',
	'repository',
	'license',
	'keywords',
	'extensions'
];

/**
 * Plugin name rule (spec 5.5): 1–64 characters, lowercase alphanumerics plus
 * `-` and `.`, first and last character alphanumeric, no `--` and no `..`.
 *
 * Mirrors the canonical schema's pattern. Kept separately so the export path
 * and error messages can use it without running a full schema validation.
 */
export const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** Maximum plugin-name length (spec 5.5). */
export const PLUGIN_NAME_MAX_LENGTH = 64;

/** True when `value` satisfies every plugin-name constraint of spec 5.5. */
export function isValidPluginName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= 1 &&
		value.length <= PLUGIN_NAME_MAX_LENGTH &&
		PLUGIN_NAME_PATTERN.test(value)
	);
}

/** Outcome of validating a manifest. `ok: false` means the plugin is rejected outright. */
export type ManifestResult =
	| {
			readonly ok: true;
			readonly manifest: AgentPluginManifest;
			/** The release the package targets, selected from `$schema` (spec 5.2). */
			readonly specVersion: SpecVersion;
			/** Non-fatal reports: unknown fields, a non-object `extensions`. */
			readonly findings: readonly Finding[];
	  }
	| { readonly ok: false; readonly findings: readonly Finding[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an already-parsed manifest value.
 *
 * Order matters and follows spec 5.2: establish that we have an object,
 * select the release from `$schema` (a client "MUST use a recognized
 * `$schema` value to select locally supported manifest validation"), then
 * apply that release's rules.
 */
export function validateManifest(value: unknown): ManifestResult {
	if (!isPlainObject(value)) {
		return {
			ok: false,
			findings: [
				finding(
					'manifest.not-an-object',
					'fatal',
					'manifest',
					`${MANIFEST_FILENAME} must contain a top-level JSON object`,
					{ at: MANIFEST_FILENAME }
				)
			]
		};
	}

	const rawSchemaId = value['$schema'];
	if (rawSchemaId === undefined) {
		return {
			ok: false,
			findings: [
				finding(
					'manifest.schema-missing',
					'fatal',
					'manifest',
					`${MANIFEST_FILENAME} is missing the required "$schema" field, so the targeted Agent Plugins version cannot be determined`,
					{ subject: '$schema', at: '/$schema' }
				)
			]
		};
	}

	const specVersion = specVersionFromPluginSchemaId(rawSchemaId);
	if (!specVersion) {
		const shown = typeof rawSchemaId === 'string' ? `"${rawSchemaId}"` : 'a non-string value';
		return {
			ok: false,
			findings: [
				finding(
					'manifest.schema-unsupported',
					'fatal',
					'manifest',
					`${MANIFEST_FILENAME} declares ${shown} as "$schema", which is not an Agent Plugins version this client supports (${supportedPluginSchemaIds().join(', ')})`,
					{ subject: '$schema', at: '/$schema' }
				)
			]
		};
	}

	const findings: Finding[] = [];
	const candidate: Record<string, unknown> = {};

	// Spec 5.2 — report and ignore unknown top-level fields, then keep going.
	// Ignoring them here is what keeps the closed schema from turning a
	// tolerated case into a fatal one.
	for (const [key, member] of Object.entries(value)) {
		if (PERMITTED_MANIFEST_FIELDS.includes(key)) {
			candidate[key] = member;
			continue;
		}
		findings.push(
			finding(
				'manifest.unknown-field',
				'warning',
				'manifest',
				`${MANIFEST_FILENAME} has an unknown top-level field "${key}"; it is ignored. Client-specific data belongs under "extensions".`,
				{ subject: key, at: `/${key}` }
			)
		);
	}

	// Spec 8.1 — a non-object `extensions` is reported and ignored. Note the
	// narrowness: this covers the *field* not being an object. A namespace
	// whose value is not an object is an ordinary schema violation, and
	// therefore fatal.
	if ('extensions' in candidate && !isPlainObject(candidate['extensions'])) {
		findings.push(
			finding(
				'manifest.extensions-not-an-object',
				'warning',
				'manifest',
				`${MANIFEST_FILENAME} has an "extensions" field that is not an object; it is ignored`,
				{ subject: 'extensions', at: '/extensions' }
			)
		);
		delete candidate['extensions'];
	}

	const validate = pluginManifestValidator(specVersion);
	if (!validate(candidate)) {
		const fatal = (validate.errors ?? []).map((error) => {
			const pointer = schemaErrorPointer(error);
			const isName = pointer === '/name' || error.instancePath === '/name';
			return finding(
				isName ? 'manifest.name-invalid' : 'manifest.schema-violation',
				'fatal',
				'manifest',
				isName
					? `${MANIFEST_FILENAME} has an invalid "name": it must be 1-64 characters of lowercase letters, digits, "-" and ".", start and end alphanumeric, with no "--" or ".." (spec 5.5)`
					: `${MANIFEST_FILENAME} is invalid: ${describeSchemaError(error)}`,
				{ subject: pointer.split('/').filter(Boolean)[0] ?? undefined, at: pointer }
			);
		});
		return {
			ok: false,
			findings: [
				...findings,
				...(fatal.length > 0
					? fatal
					: [
							finding(
								'manifest.schema-violation',
								'fatal',
								'manifest',
								`${MANIFEST_FILENAME} does not satisfy the Agent Plugins ${specVersion} manifest schema`,
								{ at: MANIFEST_FILENAME }
							)
						])
			]
		};
	}

	return { ok: true, manifest: candidate as unknown as AgentPluginManifest, specVersion, findings };
}

/** Parses manifest text and validates it. Invalid JSON is fatal (spec 5.2). */
export function parseManifest(text: string): ManifestResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			findings: [
				finding(
					'manifest.invalid-json',
					'fatal',
					'manifest',
					`${MANIFEST_FILENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
					{ at: MANIFEST_FILENAME }
				)
			]
		};
	}
	return validateManifest(parsed);
}

/**
 * Reads and validates `plugin.json` from a plugin root.
 *
 * A missing manifest is fatal, not silent: spec 4.1(2) makes the manifest
 * the one thing every plugin MUST have, and spec 5.1 fixes its location.
 */
export async function loadManifest(pluginRoot: string): Promise<ManifestResult> {
	const manifestPath = join(pluginRoot, MANIFEST_FILENAME);
	let text: string;
	try {
		text = await readFile(manifestPath, 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		const missing = code === 'ENOENT' || code === 'ENOTDIR';
		return {
			ok: false,
			findings: [
				finding(
					missing ? 'manifest.missing' : 'manifest.unreadable',
					'fatal',
					'manifest',
					missing
						? `No ${MANIFEST_FILENAME} at the plugin root; every Agent Plugins package must have one (spec 4.1)`
						: `${MANIFEST_FILENAME} could not be read: ${error instanceof Error ? error.message : String(error)}`,
					{ at: MANIFEST_FILENAME }
				)
			]
		};
	}
	return parseManifest(text);
}
