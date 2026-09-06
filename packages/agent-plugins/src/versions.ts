/**
 * Version registry — which Agent Plugins releases this loader implements.
 *
 * A package declares the release it targets through the canonical `$schema`
 * identifier in `plugin.json` (and, when present, in `mcp.json`). The
 * specification requires a client to select its validation rules *from that
 * identifier* and forbids fetching the schema over the network while loading
 * a plugin (spec 5.2, 7.2.1), so every schema we honour is vendored under
 * `src/schemas/` and resolved through this table.
 *
 * Spec 5.2 also permits mapping several canonical identifiers onto one
 * implementation, but only when the client "explicitly recognizes those
 * Agent Plugins versions as compatible". We do that for 1.1.0: its two
 * published schemas are byte-identical to the 1.0.0 pair apart from the
 * version strings in `$id`, `description` and the `$schema` const, and its
 * specification text differs only in version numbers plus three editorial
 * rewordings. Verified against the upstream repository on 2026-09-03.
 *
 * Two things follow, and the tests pin both:
 *
 *  1. A package targeting either release loads under the same rules.
 *  2. `mcp.json` must still match `plugin.json` **exactly** (spec 10.1). A
 *     1.0.0 manifest beside a 1.1.0 MCP configuration disables MCP for that
 *     package even though both releases are supported. Compatibility governs
 *     which identifiers we accept, never whether a pair may disagree.
 */

import pluginSchema100 from './schemas/1.0.0/plugin.schema.json';
import mcpSchema100 from './schemas/1.0.0/mcp.schema.json';
import pluginSchema110 from './schemas/1.1.0/plugin.schema.json';
import mcpSchema110 from './schemas/1.1.0/mcp.schema.json';

/** Agent Plugins releases this loader implements, oldest first. */
export const SUPPORTED_SPEC_VERSIONS = ['1.0.0', '1.1.0'] as const;

export type SpecVersion = (typeof SUPPORTED_SPEC_VERSIONS)[number];

/**
 * The release Ever Works publishes a conformance claim against. 1.1.0 is a
 * Working Draft upstream, so it is accepted but never advertised.
 */
export const PUBLISHED_CONFORMANCE_VERSION: SpecVersion = '1.0.0';

/** Releases whose status upstream is still `Working Draft`. */
export const WORKING_DRAFT_VERSIONS: readonly SpecVersion[] = ['1.1.0'];

const SCHEMA_ID_BASE = 'https://agent-plugins.org/schemas';

/** Canonical `plugin.json` `$schema` identifier for a release. */
export function pluginSchemaId(version: SpecVersion): string {
	return `${SCHEMA_ID_BASE}/${version}/plugin.schema.json`;
}

/** Canonical `mcp.json` `$schema` identifier for a release. */
export function mcpSchemaId(version: SpecVersion): string {
	return `${SCHEMA_ID_BASE}/${version}/mcp.schema.json`;
}

interface VersionEntry {
	readonly version: SpecVersion;
	readonly pluginSchema: object;
	readonly mcpSchema: object;
}

const REGISTRY: readonly VersionEntry[] = [
	{ version: '1.0.0', pluginSchema: pluginSchema100, mcpSchema: mcpSchema100 },
	{ version: '1.1.0', pluginSchema: pluginSchema110, mcpSchema: mcpSchema110 }
];

const BY_PLUGIN_SCHEMA_ID = new Map<string, VersionEntry>(REGISTRY.map((e) => [pluginSchemaId(e.version), e]));
const BY_MCP_SCHEMA_ID = new Map<string, VersionEntry>(REGISTRY.map((e) => [mcpSchemaId(e.version), e]));

/** Resolves a `plugin.json` `$schema` value to a release, or `undefined` when unsupported. */
export function specVersionFromPluginSchemaId(id: unknown): SpecVersion | undefined {
	return typeof id === 'string' ? BY_PLUGIN_SCHEMA_ID.get(id)?.version : undefined;
}

/** Resolves an `mcp.json` `$schema` value to a release, or `undefined` when unsupported. */
export function specVersionFromMcpSchemaId(id: unknown): SpecVersion | undefined {
	return typeof id === 'string' ? BY_MCP_SCHEMA_ID.get(id)?.version : undefined;
}

/** The vendored `plugin.json` JSON Schema for a release. */
export function pluginJsonSchema(version: SpecVersion): object {
	const entry = BY_PLUGIN_SCHEMA_ID.get(pluginSchemaId(version));
	if (!entry) {
		throw new Error(`No vendored plugin schema for Agent Plugins ${version}`);
	}
	return entry.pluginSchema;
}

/** The vendored `mcp.json` JSON Schema for a release. */
export function mcpJsonSchema(version: SpecVersion): object {
	const entry = BY_MCP_SCHEMA_ID.get(mcpSchemaId(version));
	if (!entry) {
		throw new Error(`No vendored MCP schema for Agent Plugins ${version}`);
	}
	return entry.mcpSchema;
}

/** Every supported `plugin.json` `$schema` identifier — for error messages. */
export function supportedPluginSchemaIds(): string[] {
	return SUPPORTED_SPEC_VERSIONS.map(pluginSchemaId);
}

/** Every supported `mcp.json` `$schema` identifier — for error messages. */
export function supportedMcpSchemaIds(): string[] {
	return SUPPORTED_SPEC_VERSIONS.map(mcpSchemaId);
}
