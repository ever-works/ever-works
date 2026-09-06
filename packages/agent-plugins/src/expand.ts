/**
 * Plugin-variable expansion — spec 9.2.
 *
 * "Expansion is a single, non-recursive textual replacement of every exact
 * occurrence of either placeholder. Text introduced by a replacement MUST
 * NOT be scanned for further placeholders."
 *
 * "Expansion applies to every string element of `args`, every string value
 * in `env`, and the `cwd` string. It does not apply to `env` keys,
 * `command`, or fixed component locations."
 *
 * "Unrecognized placeholder-like text MUST remain literal. Clients MUST NOT
 * perform any other placeholder or environment-variable expansion."
 *
 * The single-pass guarantee comes free from `String.prototype.replace` with
 * a global regular expression: the replacement text is never rescanned. That
 * is load-bearing rather than incidental — a package whose `PLUGIN_DATA`
 * path happened to contain the literal text `${PLUGIN_ROOT}` must not see it
 * expanded — so there is a test for it.
 */

/** The two placeholders the specification defines. Nothing else expands. */
export const PLUGIN_ROOT_PLACEHOLDER = '${PLUGIN_ROOT}';
export const PLUGIN_DATA_PLACEHOLDER = '${PLUGIN_DATA}';

/** Environment variable names the client owns; a package `env` may not set them (spec 9.2). */
export const RESERVED_ENV_KEYS: readonly string[] = ['PLUGIN_ROOT', 'PLUGIN_DATA'];

/** Absolute paths substituted for the two placeholders. */
export interface ExpansionContext {
	/** Absolute path to the filesystem-resolved plugin root. */
	readonly pluginRoot: string;
	/** Absolute path to the client-managed persistent data directory for this installed plugin. */
	readonly pluginData: string;
}

const PLACEHOLDER_PATTERN = /\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\}/g;

/**
 * Expands both placeholders in one non-recursive pass. Any other
 * `${...}`-shaped text is left exactly as written.
 */
export function expandPlaceholders(value: string, ctx: ExpansionContext): string {
	// A fresh RegExp per call would also work; resetting lastIndex is enough
	// because `replace` with a global pattern always starts from zero.
	return value.replace(PLACEHOLDER_PATTERN, (match) =>
		match === PLUGIN_ROOT_PLACEHOLDER ? ctx.pluginRoot : ctx.pluginData
	);
}

/** Expands every element of an MCP server's `args` (spec 9.2). */
export function expandArgs(args: readonly string[] | undefined, ctx: ExpansionContext): string[] {
	return (args ?? []).map((arg) => expandPlaceholders(arg, ctx));
}

/**
 * Expands the *values* of an MCP server's `env`, never the keys (spec 9.2).
 *
 * Reserved keys are rejected at validation time (spec 7.2.2 makes such a
 * server entry invalid), so by the time a config reaches here it carries
 * none; this function does not silently drop them.
 */
export function expandEnvValues(
	env: Readonly<Record<string, string>> | undefined,
	ctx: ExpansionContext
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env ?? {})) {
		out[key] = expandPlaceholders(value, ctx);
	}
	return out;
}

/** True when a name is one the client must supply itself (spec 9.2). */
export function isReservedEnvKey(key: string): boolean {
	return RESERVED_ENV_KEYS.includes(key);
}

/** Which root an MCP server `cwd` value is anchored to (spec 7.2.1). */
export type CwdAnchor = 'plugin-relative' | 'plugin-root' | 'plugin-data';

/**
 * Classifies a `cwd` value into one of the three forms spec 7.2.1 permits,
 * returning `undefined` for anything else (which makes the server entry
 * invalid).
 *
 * The distinction matters for containment: plugin-relative and
 * `${PLUGIN_ROOT}`-rooted values must stay inside the plugin root, while a
 * `${PLUGIN_DATA}`-rooted value must stay inside the plugin data directory.
 */
export function classifyCwd(value: string): CwdAnchor | undefined {
	// A `..` segment escapes its anchor by construction, whichever anchor that
	// is, so it can be refused on the text alone. This matters most for
	// `${PLUGIN_DATA}`: the loader does not know the data directory, so
	// without a lexical check `${PLUGIN_DATA}/../elsewhere` would load as a
	// valid entry and only fail much later, at launch.
	if (escapesLexically(value)) {
		return undefined;
	}
	if (value.startsWith('./')) {
		return 'plugin-relative';
	}
	if (value === PLUGIN_ROOT_PLACEHOLDER || value.startsWith(`${PLUGIN_ROOT_PLACEHOLDER}/`)) {
		return 'plugin-root';
	}
	if (value === PLUGIN_DATA_PLACEHOLDER || value.startsWith(`${PLUGIN_DATA_PLACEHOLDER}/`)) {
		return 'plugin-data';
	}
	return undefined;
}

/** True when any path segment is `..`, which leaves the anchor no matter what it is. */
function escapesLexically(value: string): boolean {
	return value.split(/[/\\]/u).includes('..');
}
