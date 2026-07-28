/**
 * Tool-grant matrix (audit item G4) — the CONTRACT half.
 *
 * Tool access is scoped down the same four-level lattice the merge-policy
 * matrix already uses:
 *
 *     platform default  <  tenant  <  organization  <  Work  <  Agent
 *
 * with one rule that makes it a security boundary rather than a
 * preference: **a more specific scope may only ever NARROW what its
 * ancestors granted.** An Agent-level grant that names a tool its Work /
 * organization / tenant never granted is rejected outright — it does not
 * widen the Agent's reach, it is dropped and reported.
 *
 * Everything here is pure and dependency-free so the same functions run in
 * the API, the agent tool loop, the worker and the web UI.
 */

/** The four configurable scopes, least → most specific. */
export type ToolGrantScope = 'tenant' | 'organization' | 'work' | 'agent';

/**
 * Precedence order. Layers may be supplied in any order — the resolver
 * sorts them by this array so no caller can accidentally invert it.
 */
export const TOOL_GRANT_SCOPE_PRECEDENCE: readonly ToolGrantScope[] = Object.freeze([
	'tenant',
	'organization',
	'work',
	'agent'
] as readonly ToolGrantScope[]);

/** Where a resolved matrix (or a single decision) came from. */
export type ToolGrantSource = 'default' | ToolGrantScope;

/**
 * What one scope row stores. Both fields optional:
 *
 *  - `allow` omitted  → "inherit whatever my ancestors allow".
 *  - `allow` present  → intersected with the inherited set; patterns the
 *    ancestors never granted are REJECTED (never widened in).
 *  - `deny` is always additive and permanent: once a scope denies a tool,
 *    no descendant can un-deny it.
 */
export interface ToolGrantOverride {
	allow?: string[];
	deny?: string[];
}

/** A fully-resolved grant matrix — the effective allow/deny sets. */
export interface ToolGrantMatrix {
	allow: string[];
	deny: string[];
}

/**
 * The safe default: everything allowed, nothing denied.
 *
 * This preserves today's behaviour exactly — before this feature there was
 * no matrix at all, so every tool the per-Agent `permissions` flags already
 * permitted stayed reachable. The matrix only ever SUBTRACTS from that, and
 * subtracts nothing until an operator writes a row.
 */
export const PLATFORM_DEFAULT_TOOL_GRANT: ToolGrantMatrix = Object.freeze({
	allow: Object.freeze(['*']) as unknown as string[],
	deny: Object.freeze([]) as unknown as string[]
});

/** One reported layer of the resolution chain, least specific first. */
export interface ToolGrantChainEntry {
	scope: ToolGrantSource;
	/** Row id of the scope entity; `null` for the platform default. */
	id: string | null;
	/** Allow patterns this layer contributed AFTER the narrowing check. */
	allow: string[];
	/** Deny patterns this layer contributed. */
	deny: string[];
	/**
	 * Allow patterns this layer asked for that its ancestors never granted.
	 * Reported, never applied — this is the "no upward widening" rule made
	 * visible so an operator can see why their grant did nothing.
	 */
	rejected: string[];
}

export interface ResolvedToolGrants {
	matrix: ToolGrantMatrix;
	/** The most specific layer that contributed anything. */
	source: ToolGrantSource;
	/** Least → most specific, starting at the platform default. */
	chain: ToolGrantChainEntry[];
}

/** Stable refusal codes so callers can branch without string-matching. */
export type ToolGrantDecisionCode = 'tool-denied' | 'tool-not-granted' | 'tool-name-invalid';

export interface ToolGrantDecision {
	allowed: boolean;
	toolName: string;
	/** Which scope decided. */
	source: ToolGrantSource;
	code?: ToolGrantDecisionCode;
	/** Human-readable, names the offending pattern — never a secret. */
	reason?: string;
}

/**
 * Pattern matching for tool names. Deliberately tiny — three forms only:
 *
 *   `*`          matches every tool
 *   `prefix*`    matches every tool starting with `prefix`
 *   `exact_name` matches that tool only
 *
 * Case-insensitive because tool names are model-facing identifiers and a
 * grant that silently misses on case is a security bug, not a nicety.
 */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
	const p = pattern.trim().toLowerCase();
	const name = toolName.trim().toLowerCase();
	if (!p || !name) return false;
	if (p === '*') return true;
	if (p.endsWith('*')) return name.startsWith(p.slice(0, -1));
	return p === name;
}

/** Does ANY pattern in the list match this tool name? */
export function matchesAnyToolPattern(patterns: readonly string[], toolName: string): boolean {
	for (const pattern of patterns) {
		if (matchesToolPattern(pattern, toolName)) return true;
	}
	return false;
}

/**
 * Does the broader pattern `outer` fully cover `inner`?
 *
 * This is the narrowing test: a child layer may only keep an allow pattern
 * that some ancestor pattern already covers. `*` covers everything;
 * `git_*` covers `git_commit` and `git_*` but NOT `*` or `deploy_*`.
 */
export function toolPatternCovers(outer: string, inner: string): boolean {
	const o = outer.trim().toLowerCase();
	const i = inner.trim().toLowerCase();
	if (!o || !i) return false;
	if (o === '*') return true;
	if (o.endsWith('*')) return i.startsWith(o.slice(0, -1));
	// A concrete outer pattern can only cover the identical concrete inner
	// one — a wildcard inner would reach further than the outer allows.
	return o === i;
}

/** Tool names are model-facing identifiers; keep them boring and bounded. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;

/** Allow patterns additionally permit a single trailing `*`. */
export const TOOL_GRANT_PATTERN = /^(\*|[A-Za-z0-9_.:-]{1,120}\*?)$/;

// ── Credential references (audit item G14) ───────────────────────────

/**
 * `{{cred.<key>}}` — the only credential reference syntax the platform
 * understands. Resolved SERVER-SIDE immediately before an outbound call;
 * the resolved value is never logged, never persisted and never echoed
 * back to the model.
 *
 * Returned as a FACTORY, not a shared constant: a `/g` regex carries
 * `lastIndex` state, and a shared instance silently skips matches on the
 * second call. Every caller gets its own.
 */
export function credentialRefPattern(): RegExp {
	return /\{\{\s*cred\.([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})\s*\}\}/g;
}

/** A credential key: alphanumeric, `_`, `.` and `-`, up to 64 chars. */
export const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export function isCredentialKey(value: string): boolean {
	return CREDENTIAL_KEY_PATTERN.test(value);
}
