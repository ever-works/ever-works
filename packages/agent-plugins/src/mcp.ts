/**
 * `mcp.json` — MCP server configuration (spec 7.2).
 *
 * The document is closed (`$schema` plus `mcpServers`, nothing else) and so
 * is every server entry: "Each server configuration MUST contain a `type`
 * field and match exactly one of the closed variants below. An unknown
 * field, an unknown `type` value, or a field belonging to another variant
 * makes that server entry invalid."
 *
 * The failure boundaries of spec 7.2.2 are the whole point of this module,
 * and they are asymmetric:
 *
 *  - a broken *document* — bad JSON, an unsupported `$schema`, a version
 *    that disagrees with `plugin.json`, a stray top-level field — disables
 *    MCP **for that package only**. Skills keep loading.
 *  - a broken *server entry* — or one whose transport this client does not
 *    support — skips **that entry only**. Other servers keep loading.
 *
 * One rule deserves singling out, because supporting several releases makes
 * it easy to get wrong. Spec 10.1: "When `mcp.json` is present, the version
 * in its `$schema` value MUST match the version declared by `plugin.json`."
 * That is string equality against the manifest's release, not membership of
 * the supported set. A 1.0.0 manifest beside a 1.1.0 MCP configuration
 * disables MCP even though this client supports both.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyCwd, isReservedEnvKey, RESERVED_ENV_KEYS, type CwdAnchor } from './expand';
import { finding, type Finding } from './findings';
import { isRegularFile, pathPresent, resolveWithinRoot } from './paths';
import {
	describeSchemaError,
	mcpServerVariantValidator,
	schemaErrorPointer,
	type McpServerVariant
} from './schema-validator';
import { specVersionFromMcpSchemaId, supportedMcpSchemaIds, type SpecVersion } from './versions';

/** The MCP configuration file name, fixed at the plugin root by spec 7.2.1. */
export const MCP_CONFIG_FILENAME = 'mcp.json';

/** Transports the specification defines. `sse` is the deprecated MCP 2024-11-05 HTTP+SSE transport. */
export type McpTransport = 'stdio' | 'streamable-http' | 'sse';

/** Every top-level field `mcp.json` permits. */
export const PERMITTED_MCP_FIELDS: readonly string[] = ['$schema', 'mcpServers'];

export interface McpStdioServer {
	readonly type: 'stdio';
	/** A single executable token: a bare name, or a plugin-relative path starting `./`. */
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
}

export interface McpHttpServer {
	readonly type: 'streamable-http' | 'sse';
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

/** A validated server entry, with the derived facts a launcher needs. */
export interface McpServerEntry {
	/** The member name from `mcpServers`, which identifies the server. */
	readonly name: string;
	readonly config: McpServerConfig;
	readonly transport: McpTransport;
	/** Which root a stdio `cwd` is anchored to; absent when `cwd` is omitted. */
	readonly cwdAnchor?: CwdAnchor;
}

/** Result of parsing `mcp.json`. */
export interface McpConfigResult {
	/**
	 * False when MCP is disabled for this package (spec 7.2.2 rule 2).
	 * Skills and other component types are unaffected.
	 */
	readonly componentValid: boolean;
	/** True when `mcp.json` is simply absent, which spec 6.2 forbids treating as an error. */
	readonly componentAbsent: boolean;
	/** The release declared by `mcp.json`, when it could be determined. */
	readonly specVersion?: SpecVersion;
	/** Valid, supported server entries, ordered by name. */
	readonly servers: readonly McpServerEntry[];
	readonly findings: readonly Finding[];
}

/** Options for parsing an MCP configuration. */
export interface ParseMcpConfigOptions {
	/**
	 * The release declared by `plugin.json`. Required, because spec 10.1
	 * makes the match between the two documents part of validity.
	 */
	readonly manifestSpecVersion: SpecVersion;
	/**
	 * Transports this client can actually connect. An entry declaring
	 * anything else is skipped and reported (spec 7.2.2 rule 4) rather than
	 * treated as invalid configuration.
	 */
	readonly supportedTransports?: readonly McpTransport[];
}

const ALL_TRANSPORTS: readonly McpTransport[] = ['stdio', 'streamable-http', 'sse'];

const VARIANT_BY_TRANSPORT: Readonly<Record<McpTransport, McpServerVariant>> = {
	stdio: 'stdioServer',
	'streamable-http': 'streamableHttpServer',
	sse: 'sseServer'
};

/** RFC 9110 field-name: one or more token characters. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** RFC 9110 field-value: visible characters, space and horizontal tab; never CR or LF. */
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * True for a JSON-shaped object, and deliberately false for a `Date`,
 * `RegExp` or any other exotic object.
 *
 * That distinction is load-bearing for `metadata`. YAML parses an unquoted
 * `2020-01-01` into a `Date`, and a `Date` passes every naive object test
 * while `Object.entries` on it returns `[]` — so a plain "is it an object,
 * is it not an array" guard would walk zero entries, find no non-string
 * value, and wave a timestamp through as a valid string-to-string map.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value) as object | null;
	return proto === Object.prototype || proto === null;
}

/**
 * True when a host is a loopback endpoint, the only case in which spec 7.2.1
 * permits plain HTTP: "the URL host is exactly `localhost` or an IP literal
 * in a loopback range".
 */
export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
	if (host === 'localhost') {
		return true;
	}
	// IPv4 loopback is the whole 127.0.0.0/8 block.
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (ipv4) {
		const octets = ipv4.slice(1).map((part) => Number(part));
		if (octets.some((octet) => octet > 255)) {
			return false;
		}
		return octets[0] === 127;
	}
	const lower = host.toLowerCase();
	if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
		return true;
	}
	// IPv4-mapped and IPv4-compatible loopback, e.g. ::ffff:127.0.0.1.
	const mapped = /^(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
	if (mapped?.[1]) {
		return isLoopbackHost(mapped[1]);
	}
	return false;
}

/** Why a remote URL fails spec 7.2.1, or `undefined` when it passes. */
export function validateRemoteUrl(raw: string): string | undefined {
	// A raw '#' always begins a fragment: inside a query it would have to be
	// percent-encoded. Checking the text rather than `URL.hash` also catches
	// a bare trailing '#', which parses to an empty hash.
	if (raw.includes('#')) {
		return 'it must not contain a fragment';
	}

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return 'it must be an absolute HTTP or HTTPS URL';
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return `its scheme "${url.protocol.replace(':', '')}" is not http or https`;
	}
	if (url.username !== '' || url.password !== '') {
		return 'it must not contain user information';
	}
	if (url.hostname === '') {
		return 'it must include a host';
	}
	if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
		return `plain HTTP is only permitted for loopback hosts, and "${url.hostname}" is not one`;
	}
	return undefined;
}

/**
 * Why a stdio `command` fails spec 7.2.1, or `undefined` when it passes.
 *
 * "The `command` field MUST contain a single executable token, not a shell
 * command string. It MUST be either a bare executable name or a
 * plugin-relative path beginning with `./`."
 *
 * Placeholders are explicitly *not* expanded here, so a `command` that
 * contains one is simply a name containing odd characters — and, because a
 * bare name may not contain a path separator, `${PLUGIN_ROOT}/bin/x` is
 * rejected as the malformed configuration it is.
 */
export function validateStdioCommand(command: string): string | undefined {
	if (command.length === 0) {
		return 'it must not be empty';
	}
	// Note what is NOT rejected: whitespace. "A single executable token, not a
	// shell command string" is a rule about never SPLITTING the value, and we
	// never do — it is passed as one argument, with `args` separate and no
	// shell involved. A path like `./my tools/server` is a single token that
	// happens to contain a space, and refusing it would reject a conformant
	// package. A package that does put a shell string here simply fails to
	// resolve at launch, which spec 7.2.2 rule 5 already covers as a
	// connection failure rather than invalid configuration.
	if (command.startsWith('./')) {
		const rest = command.slice(2);
		if (rest.length === 0) {
			return 'a plugin-relative command must name a file';
		}
		if (rest.split(/[/\\]/u).includes('..')) {
			return 'a plugin-relative command must not traverse outside the plugin root';
		}
		return undefined;
	}
	if (command.startsWith('.') || command.startsWith('/') || command.startsWith('\\')) {
		return 'it must be a bare executable name or a plugin-relative path beginning with "./"';
	}
	if (/^[a-zA-Z]:[\\/]/u.test(command)) {
		return 'an absolute path is not permitted; use a bare executable name or a plugin-relative path beginning with "./"';
	}
	if (/[/\\]/u.test(command)) {
		return 'a bare executable name must not contain a path separator; use "./" to reference a bundled executable';
	}
	return undefined;
}

/**
 * True when a server name can carry through Ever Works' `mcp__<server>__<tool>`
 * tool namespace without sanitisation.
 *
 * Advisory only. The specification puts no constraint on `mcpServers` member
 * names, so a name failing this is still valid configuration — the platform
 * layer sanitises it. Rejecting here would make us non-conformant.
 */
export function isToolNamespaceSafeServerName(name: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) && !name.includes('__');
}

function disabled(findings: readonly Finding[], specVersion?: SpecVersion): McpConfigResult {
	return specVersion === undefined
		? { componentValid: false, componentAbsent: false, servers: [], findings }
		: { componentValid: false, componentAbsent: false, specVersion, servers: [], findings };
}

/** Validates one server entry. Returns the entry, or the findings that skip it. */
function validateServerEntry(
	name: string,
	raw: unknown,
	version: SpecVersion,
	supportedTransports: readonly McpTransport[]
): { entry?: McpServerEntry; findings: Finding[] } {
	const at = `/mcpServers/${name}`;
	const findings: Finding[] = [];
	const skip = (
		code: Parameters<typeof finding>[0],
		message: string
	): { entry?: McpServerEntry; findings: Finding[] } => {
		findings.push(finding(code, 'error', 'mcp-server', message, { subject: name, at }));
		return { findings };
	};

	if (!isPlainObject(raw)) {
		return skip('mcp.server-schema-violation', `MCP server "${name}" is not a JSON object and is skipped`);
	}

	const rawType = raw['type'];
	if (rawType === undefined) {
		return skip('mcp.server-type-missing', `MCP server "${name}" is missing the required "type" field`);
	}
	if (typeof rawType !== 'string' || !ALL_TRANSPORTS.includes(rawType as McpTransport)) {
		return skip(
			'mcp.server-type-unknown',
			`MCP server "${name}" declares an unknown "type" (${JSON.stringify(rawType)}); permitted values are ${ALL_TRANSPORTS.map((t) => `"${t}"`).join(', ')}`
		);
	}
	const transport = rawType as McpTransport;

	// Reserved environment names are checked before the schema so the
	// operator gets the specific rule rather than a `propertyNames` failure.
	// Spec 9.2 makes such an entry invalid, which spec 7.2.2 turns into
	// skip-this-server.
	if (transport === 'stdio' && isPlainObject(raw['env'])) {
		const offending = Object.keys(raw['env']).filter(isReservedEnvKey);
		if (offending.length > 0) {
			return skip(
				'mcp.server-env-reserved-key',
				`MCP server "${name}" sets the reserved environment ${offending.length === 1 ? 'variable' : 'variables'} ${offending.map((k) => `"${k}"`).join(', ')}; ${RESERVED_ENV_KEYS.join(' and ')} are supplied by the client`
			);
		}
	}

	// Validate against the declared variant, not the `oneOf` union: it keeps
	// the failure attributable to a field, and `additionalProperties: false`
	// on the variant is what rejects a field belonging to another variant.
	const validate = mcpServerVariantValidator(version, VARIANT_BY_TRANSPORT[transport]);
	if (!validate(raw)) {
		const errors = validate.errors ?? [];
		const pointer = errors[0] ? schemaErrorPointer(errors[0]) : '';
		// `cwd` exists only on the stdio variant. On a remote entry the same
		// pointer means "unpermitted field", and reporting the cwd FORM rule
		// there would send the author to fix a field that should not be
		// present at all.
		if (transport === 'stdio' && pointer.endsWith('/cwd')) {
			return skip(
				'mcp.server-cwd-invalid',
				`MCP server "${name}" has an invalid "cwd": it must begin with "./", "\${PLUGIN_ROOT}" or "\${PLUGIN_DATA}"`
			);
		}
		const detail = errors.map(describeSchemaError).join('; ');
		return skip(
			'mcp.server-schema-violation',
			`MCP server "${name}" is invalid and is skipped: ${detail || 'it does not satisfy the server schema'}`
		);
	}

	if (transport === 'stdio') {
		const config = raw as unknown as McpStdioServer;

		const commandProblem = validateStdioCommand(config.command);
		if (commandProblem) {
			return skip(
				'mcp.server-command-invalid',
				`MCP server "${name}" has an invalid "command" (${JSON.stringify(config.command)}): ${commandProblem}`
			);
		}

		let cwdAnchor: CwdAnchor | undefined;
		if (config.cwd !== undefined) {
			cwdAnchor = classifyCwd(config.cwd);
			if (!cwdAnchor) {
				return skip(
					'mcp.server-cwd-invalid',
					`MCP server "${name}" has an invalid "cwd" (${JSON.stringify(config.cwd)}): it must be exactly "\${PLUGIN_ROOT}", "\${PLUGIN_DATA}", a path under either, or a plugin-relative path beginning with "./"`
				);
			}
		}

		if (!supportedTransports.includes(transport)) {
			return skip(
				'mcp.server-transport-unsupported',
				`MCP server "${name}" declares the "${transport}" transport, which this client does not support here; the server is skipped`
			);
		}

		return {
			entry: { name, config, transport, ...(cwdAnchor === undefined ? {} : { cwdAnchor }) },
			findings
		};
	}

	const config = raw as unknown as McpHttpServer;

	const urlProblem = validateRemoteUrl(config.url);
	if (urlProblem) {
		return skip(
			'mcp.server-url-invalid',
			`MCP server "${name}" has an invalid "url" (${JSON.stringify(config.url)}): ${urlProblem}`
		);
	}

	if (config.headers) {
		const seen = new Map<string, string>();
		for (const [headerName, headerValue] of Object.entries(config.headers)) {
			if (!HEADER_NAME_PATTERN.test(headerName)) {
				return skip(
					'mcp.server-header-name-invalid',
					`MCP server "${name}" has an invalid header name ${JSON.stringify(headerName)}`
				);
			}
			if (!HEADER_VALUE_PATTERN.test(headerValue)) {
				return skip(
					'mcp.server-header-value-invalid',
					`MCP server "${name}" has an invalid value for header "${headerName}": header values must not contain control characters`
				);
			}
			// "Header names are case-insensitive; an entry containing the
			// same header name more than once under different casing is
			// invalid."
			const lower = headerName.toLowerCase();
			const previous = seen.get(lower);
			if (previous !== undefined) {
				return skip(
					'mcp.server-header-duplicate',
					`MCP server "${name}" sets header "${headerName}" and "${previous}", which are the same case-insensitive header name`
				);
			}
			seen.set(lower, headerName);
		}
	}

	if (!supportedTransports.includes(transport)) {
		return skip(
			'mcp.server-transport-unsupported',
			`MCP server "${name}" declares the "${transport}" transport, which this client does not support here; the server is skipped`
		);
	}

	return { entry: { name, config, transport }, findings };
}

/** Validates an already-parsed `mcp.json` value. */
export function validateMcpConfig(value: unknown, options: ParseMcpConfigOptions): McpConfigResult {
	const supportedTransports = options.supportedTransports ?? ALL_TRANSPORTS;

	if (!isPlainObject(value)) {
		return disabled([
			finding(
				'mcp.not-an-object',
				'error',
				'mcp-component',
				`${MCP_CONFIG_FILENAME} must contain a top-level JSON object; MCP is disabled for this package`,
				{ at: MCP_CONFIG_FILENAME }
			)
		]);
	}

	const rawSchemaId = value['$schema'];
	if (rawSchemaId === undefined) {
		return disabled([
			finding(
				'mcp.schema-missing',
				'error',
				'mcp-component',
				`${MCP_CONFIG_FILENAME} is missing the required "$schema" field; MCP is disabled for this package`,
				{ subject: '$schema', at: '/$schema' }
			)
		]);
	}

	const specVersion = specVersionFromMcpSchemaId(rawSchemaId);
	if (!specVersion) {
		const shown = typeof rawSchemaId === 'string' ? `"${rawSchemaId}"` : 'a non-string value';
		return disabled([
			finding(
				'mcp.schema-unsupported',
				'error',
				'mcp-component',
				`${MCP_CONFIG_FILENAME} declares ${shown} as "$schema", which is not an Agent Plugins version this client supports (${supportedMcpSchemaIds().join(', ')}); MCP is disabled for this package`,
				{ subject: '$schema', at: '/$schema' }
			)
		]);
	}

	// Spec 10.1 / 7.2.2 rule 2 — exact match against the manifest, not
	// membership of the supported set.
	if (specVersion !== options.manifestSpecVersion) {
		return disabled(
			[
				finding(
					'mcp.schema-version-mismatch',
					'error',
					'mcp-component',
					`${MCP_CONFIG_FILENAME} targets Agent Plugins ${specVersion} but plugin.json targets ${options.manifestSpecVersion}; the two must match, so MCP is disabled for this package`,
					{ subject: '$schema', at: '/$schema' }
				)
			],
			specVersion
		);
	}

	const unknownFields = Object.keys(value).filter((key) => !PERMITTED_MCP_FIELDS.includes(key));
	if (unknownFields.length > 0) {
		// Unlike the manifest, `mcp.json` has no leniency for stray
		// top-level fields: spec 7.2.1 permits "no other top-level fields",
		// and 7.2.2 rule 2 disables MCP when the top-level requirements are
		// not satisfied.
		return disabled(
			[
				finding(
					'mcp.unknown-field',
					'error',
					'mcp-component',
					`${MCP_CONFIG_FILENAME} has ${unknownFields.length === 1 ? 'an unpermitted top-level field' : 'unpermitted top-level fields'} ${unknownFields.map((f) => `"${f}"`).join(', ')}; MCP is disabled for this package`,
					{ at: MCP_CONFIG_FILENAME }
				)
			],
			specVersion
		);
	}

	if (!('mcpServers' in value)) {
		return disabled(
			[
				finding(
					'mcp.servers-missing',
					'error',
					'mcp-component',
					`${MCP_CONFIG_FILENAME} is missing the required "mcpServers" field; MCP is disabled for this package`,
					{ subject: 'mcpServers', at: '/mcpServers' }
				)
			],
			specVersion
		);
	}

	const rawServers = value['mcpServers'];
	if (!isPlainObject(rawServers)) {
		return disabled(
			[
				finding(
					'mcp.servers-not-an-object',
					'error',
					'mcp-component',
					`${MCP_CONFIG_FILENAME} has an "mcpServers" field that is not an object; MCP is disabled for this package`,
					{ subject: 'mcpServers', at: '/mcpServers' }
				)
			],
			specVersion
		);
	}

	// Every top-level rule the canonical schema states — the `$schema` const,
	// the required `mcpServers` object, no other fields — has now been checked
	// by hand above, each with its own finding code. Running the document
	// schema here as well would be dead code: it could only fail on a case
	// already returned, and it would report that case under the wrong code.
	// Individual server entries ARE validated against the schema, one at a
	// time, which is what spec 7.2.1 exposes `#/$defs/server` for.

	const findings: Finding[] = [];
	const servers: McpServerEntry[] = [];

	for (const [name, rawServer] of Object.entries(rawServers)) {
		if (name.length === 0) {
			findings.push(
				finding(
					'mcp.server-name-invalid',
					'error',
					'mcp-server',
					'An MCP server is declared under an empty name and cannot be addressed; it is skipped',
					{ at: '/mcpServers' }
				)
			);
			continue;
		}
		const outcome = validateServerEntry(name, rawServer, specVersion, supportedTransports);
		findings.push(...outcome.findings);
		if (outcome.entry) {
			servers.push(outcome.entry);
		}
	}

	servers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	return { componentValid: true, componentAbsent: false, specVersion, servers, findings };
}

/**
 * Enforces the *filesystem* half of containment for one server entry —
 * spec 4.1 boundary 4: "If an MCP server `command` or `cwd` fails
 * containment, the client MUST treat that server entry as invalid."
 *
 * Parsing alone cannot do this. `validateServerEntry` checks the shapes the
 * specification defines — a `command` is a bare token or begins `./`, a
 * `cwd` takes one of three forms — but §4.1(4) additionally requires a
 * plugin-relative path to "remain within the filesystem-resolved plugin
 * root after resolution", and only a caller holding the root can decide
 * that. Symlinks are exactly why: `./bin/server` is lexically innocent and
 * may still point anywhere.
 *
 * Two deliberate non-checks:
 *
 *  - A **bare** `command` is resolved through the platform's executable
 *    search (spec 7.2.1), not against the package, so it has no containment
 *    to fail.
 *  - `args` elements and `env` values are never checked. Spec 4.1(5) is
 *    explicit: they "are opaque strings. Clients MUST NOT interpret them as
 *    package paths for the purpose of enforcing this section." Treating an
 *    argument that merely looks like a path as one would reject conformant
 *    packages.
 *
 * A `${PLUGIN_DATA}`-rooted `cwd` is contained against the data directory
 * rather than the package root, so it is only checked when `pluginData` is
 * supplied — the launcher knows that path, the loader does not.
 */
export async function checkServerContainment(
	pluginRoot: string,
	entry: McpServerEntry,
	options?: { readonly pluginData?: string }
): Promise<Finding[]> {
	if (entry.transport !== 'stdio') {
		return [];
	}
	const config = entry.config as McpStdioServer;
	const at = `/mcpServers/${entry.name}`;
	const findings: Finding[] = [];

	if (config.command.startsWith('./')) {
		const resolved = await resolveWithinRoot(pluginRoot, config.command.slice(2));
		if (!resolved.ok) {
			findings.push(
				finding(
					'mcp.server-command-invalid',
					'error',
					'mcp-server',
					`MCP server "${entry.name}" has a "command" that resolves outside the plugin root; the server is skipped`,
					{ subject: entry.name, at }
				)
			);
		}
	}

	if (config.cwd !== undefined && entry.cwdAnchor === undefined) {
		// Parsing never produces this: an unclassifiable `cwd` skips the entry
		// outright. It is reachable only through a hand-built entry, and
		// treating it as "nothing to check" would be the one silent way past
		// containment, so it is refused instead.
		findings.push(
			finding(
				'mcp.server-cwd-invalid',
				'error',
				'mcp-server',
				`MCP server "${entry.name}" has a "cwd" with no resolved anchor, so containment cannot be established; the server is skipped`,
				{ subject: entry.name, at }
			)
		);
		return findings;
	}

	if (config.cwd !== undefined && entry.cwdAnchor !== undefined) {
		const anchor = entry.cwdAnchor;
		const relative =
			anchor === 'plugin-relative'
				? config.cwd.slice(2)
				: config.cwd.replace(/^\$\{PLUGIN_(?:ROOT|DATA)\}\/?/u, '');
		if (anchor === 'plugin-data') {
			if (options?.pluginData !== undefined) {
				const resolved = await resolveWithinRoot(options.pluginData, relative);
				if (!resolved.ok) {
					findings.push(
						finding(
							'mcp.server-cwd-invalid',
							'error',
							'mcp-server',
							`MCP server "${entry.name}" has a "cwd" that resolves outside the plugin data directory; the server is skipped`,
							{ subject: entry.name, at }
						)
					);
				}
			}
		} else {
			const resolved = await resolveWithinRoot(pluginRoot, relative);
			if (!resolved.ok) {
				findings.push(
					finding(
						'mcp.server-cwd-invalid',
						'error',
						'mcp-server',
						`MCP server "${entry.name}" has a "cwd" that resolves outside the plugin root; the server is skipped`,
						{ subject: entry.name, at }
					)
				);
			}
		}
	}

	return findings;
}

/** Parses `mcp.json` text. Invalid JSON disables MCP for the package (spec 7.2.2 rule 2). */
export function parseMcpConfig(text: string, options: ParseMcpConfigOptions): McpConfigResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return disabled([
			finding(
				'mcp.invalid-json',
				'error',
				'mcp-component',
				`${MCP_CONFIG_FILENAME} is not valid JSON (${error instanceof Error ? error.message : String(error)}); MCP is disabled for this package`,
				{ at: MCP_CONFIG_FILENAME }
			)
		]);
	}
	return validateMcpConfig(parsed, options);
}

/** Reads and validates `mcp.json` from a plugin root. An absent file is not an error. */
export async function loadMcpConfig(pluginRoot: string, options: ParseMcpConfigOptions): Promise<McpConfigResult> {
	const configPath = join(pluginRoot, MCP_CONFIG_FILENAME);

	// Spec 6.2 — absence is measured WITHOUT following symlinks, so a dangling
	// `mcp.json` link is present-but-broken and reaches the not-a-file check
	// below rather than being silently reported as absent.
	if (!(await pathPresent(configPath))) {
		return { componentValid: true, componentAbsent: true, servers: [], findings: [] };
	}

	// Spec 4.1 boundary 2 — a fixed component location resolving outside the
	// root invalidates that component type only.
	const contained = await resolveWithinRoot(pluginRoot, MCP_CONFIG_FILENAME);
	if (!contained.ok) {
		return disabled([
			finding(
				'package.path-escapes-root',
				'error',
				'mcp-component',
				`${MCP_CONFIG_FILENAME} resolves outside the plugin root; MCP is disabled for this package`,
				{ at: MCP_CONFIG_FILENAME }
			)
		]);
	}

	// Spec 6.2 — present but not the expected filesystem kind.
	if (!(await isRegularFile(configPath))) {
		return disabled([
			finding(
				'mcp.location-not-a-file',
				'error',
				'mcp-component',
				`${MCP_CONFIG_FILENAME} exists but does not resolve to a regular file; MCP is disabled for this package`,
				{ at: MCP_CONFIG_FILENAME }
			)
		]);
	}

	let text: string;
	try {
		text = await readFile(configPath, 'utf8');
	} catch (error) {
		return disabled([
			finding(
				'mcp.unreadable',
				'error',
				'mcp-component',
				`${MCP_CONFIG_FILENAME} could not be read (${error instanceof Error ? error.message : String(error)}); MCP is disabled for this package`,
				{ at: MCP_CONFIG_FILENAME }
			)
		]);
	}

	const parsed = parseMcpConfig(text, options);
	if (!parsed.componentValid || parsed.servers.length === 0) {
		return parsed;
	}

	// Spec 4.1 boundary 4 — now that the root is in hand, enforce the
	// filesystem half of containment for `command` and root-anchored `cwd`.
	// A server that escapes is dropped, and only that server: the others and
	// every other component type keep loading.
	const containmentFindings: Finding[] = [];
	const containedServers: McpServerEntry[] = [];
	for (const entry of parsed.servers) {
		const problems = await checkServerContainment(pluginRoot, entry);
		if (problems.length === 0) {
			containedServers.push(entry);
			continue;
		}
		containmentFindings.push(...problems);
	}

	return {
		componentValid: true,
		componentAbsent: false,
		...(parsed.specVersion === undefined ? {} : { specVersion: parsed.specVersion }),
		servers: containedServers,
		findings: [...parsed.findings, ...containmentFindings]
	};
}
