import {
	TOOL_GRANT_PATTERN,
	matchesAnyToolPattern,
	toolPatternCovers,
	type ToolGrantChainEntry,
	type ToolGrantMatrix,
	type ToolGrantOverride,
	type ToolGrantScope,
	type ToolGrantSource
} from '../policy/tool-grant.types.js';

/**
 * Scope presets (AW-15) — plain-English access levels for a provider,
 * expressed ON the existing tool-grant lattice.
 *
 * An owner should be able to say "agents may only READ through this
 * provider" without learning tool names or provider scope strings. A preset
 * is exactly that: a provider plugin declares, per level, which agent tools
 * the level unlocks, and choosing a level at a scope is written as ordinary
 * `deny` patterns on that scope's tool-grant row.
 *
 * Why `deny` and never `allow`: a tool-grant row's `allow` narrows EVERY
 * tool the scope can reach, so writing a provider's patterns there would
 * silently strip every other tool. `deny` subtracts only what it names, is
 * additive down the chain, and can never be undone by a more specific scope —
 * which is precisely "a preset may only ever narrow". No second permission
 * model exists: `decideToolGrant` stays the single decision point, and the
 * resolution chain already explains which scope narrowed a tool.
 *
 * Everything here is pure so the API, the agent package and the web UI agree
 * on the mapping.
 */

/** The two levels, least → most access. No third level, by design. */
export const CONNECTION_SCOPE_PRESET_ORDER = ['read', 'write'] as const;

export type ConnectionScopePresetId = (typeof CONNECTION_SCOPE_PRESET_ORDER)[number];

/** What a provider plugin declares for one level. */
export interface ConnectionScopePresetDeclaration {
	readonly id: ConnectionScopePresetId;
	/**
	 * Provider permission strings this level needs from the connected account.
	 * Used only to decide whether widening needs the owner to re-approve; never
	 * shown to the user.
	 */
	readonly providerScopes: readonly string[];
	/** Agent tool-name patterns this level unlocks: `*`, `prefix*` or an exact name. */
	readonly toolPatterns: readonly string[];
}

export function isConnectionScopePresetId(value: unknown): value is ConnectionScopePresetId {
	return typeof value === 'string' && (CONNECTION_SCOPE_PRESET_ORDER as readonly string[]).includes(value);
}

function presetRank(id: ConnectionScopePresetId): number {
	return CONNECTION_SCOPE_PRESET_ORDER.indexOf(id);
}

function cleanPatterns(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== 'string') continue;
		const pattern = entry.trim();
		if (pattern.length === 0 || !TOOL_GRANT_PATTERN.test(pattern)) continue;
		if (!out.includes(pattern)) out.push(pattern);
	}
	return out;
}

function cleanScopes(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== 'string') continue;
		const scope = entry.trim();
		if (scope.length === 0 || scope.length > 200 || out.includes(scope)) continue;
		out.push(scope);
	}
	return out;
}

/**
 * Shape guard for a plugin's declaration. Unknown ids and malformed patterns
 * are DROPPED (never coerced into something permissive), the first
 * declaration of an id wins, and the result is ordered least → most access.
 */
export function normalizeConnectionScopePresets(raw: unknown): ConnectionScopePresetDeclaration[] {
	if (!Array.isArray(raw)) return [];
	const byId = new Map<ConnectionScopePresetId, ConnectionScopePresetDeclaration>();
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') continue;
		const candidate = entry as Record<string, unknown>;
		if (!isConnectionScopePresetId(candidate.id) || byId.has(candidate.id)) continue;
		byId.set(candidate.id, {
			id: candidate.id,
			providerScopes: cleanScopes(candidate.providerScopes),
			toolPatterns: cleanPatterns(candidate.toolPatterns)
		});
	}
	return [...byId.values()].sort((a, b) => presetRank(a.id) - presetRank(b.id));
}

/**
 * Patterns a WIDER level unlocks that `target` does not cover — exactly what
 * choosing `target` at a scope has to deny. Empty for the widest declared
 * level, and for a level the provider does not declare.
 */
export function connectionScopePresetDenyPatterns(
	presets: readonly ConnectionScopePresetDeclaration[],
	target: ConnectionScopePresetId
): string[] {
	const chosen = presets.find((preset) => preset.id === target);
	if (!chosen) return [];
	const out: string[] = [];
	for (const preset of presets) {
		if (presetRank(preset.id) <= presetRank(target)) continue;
		for (const pattern of preset.toolPatterns) {
			const covered = chosen.toolPatterns.some((own) => toolPatternCovers(own, pattern));
			if (!covered && !out.some((seen) => sameToolPattern(seen, pattern))) out.push(pattern);
		}
	}
	return out;
}

/**
 * Every pattern the preset control owns for this provider — the deny set of
 * the NARROWEST declared level. Choosing any level first removes these from a
 * scope's `deny`, then adds back that level's own deny set.
 */
export function connectionScopePresetManagedPatterns(presets: readonly ConnectionScopePresetDeclaration[]): string[] {
	if (presets.length === 0) return [];
	return connectionScopePresetDenyPatterns(presets, presets[0].id);
}

function sameToolPattern(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The override to store at ONE scope after choosing `target` there.
 *
 * `allow` is returned untouched. `deny` keeps every pattern the operator wrote
 * that the preset control does not own, drops the ones it does, and adds the
 * target's deny set. The result may carry no `allow` and an empty `deny` — the
 * caller then removes the row so the scope inherits again.
 */
export function applyConnectionScopePresetToToolGrant(
	current: ToolGrantOverride | null | undefined,
	presets: readonly ConnectionScopePresetDeclaration[],
	target: ConnectionScopePresetId
): ToolGrantOverride {
	const managed = connectionScopePresetManagedPatterns(presets);
	const keep = (current?.deny ?? []).filter((pattern) => !managed.some((owned) => sameToolPattern(owned, pattern)));
	const deny = [...keep];
	for (const pattern of connectionScopePresetDenyPatterns(presets, target)) {
		if (!deny.some((seen) => sameToolPattern(seen, pattern))) deny.push(pattern);
	}
	const out: ToolGrantOverride = { deny };
	if (current?.allow !== undefined) out.allow = [...current.allow];
	return out;
}

/**
 * The level a scope's OWN row selects: the narrowest level whose whole deny
 * set that row carries, or the widest declared level when it carries none of
 * them (the scope adds no narrowing of its own). `null` when the provider
 * declares nothing.
 */
export function storedConnectionScopePreset(
	override: ToolGrantOverride | null | undefined,
	presets: readonly ConnectionScopePresetDeclaration[]
): ConnectionScopePresetId | null {
	if (presets.length === 0) return null;
	const deny = override?.deny ?? [];
	for (const preset of presets.slice(0, -1)) {
		const needed = connectionScopePresetDenyPatterns(presets, preset.id);
		if (needed.length === 0) continue;
		if (needed.every((pattern) => deny.some((stored) => sameToolPattern(stored, pattern)))) {
			return preset.id;
		}
	}
	return presets[presets.length - 1].id;
}

/** Two patterns overlap when either one covers the other. */
function patternsOverlap(a: string, b: string): boolean {
	return toolPatternCovers(a, b) || toolPatternCovers(b, a);
}

/**
 * Is every tool `pattern` names still callable under `matrix`? No deny may
 * touch it, and some allow must cover it entirely.
 */
function patternReachable(matrix: ToolGrantMatrix, pattern: string): boolean {
	if (matrix.deny.some((deny) => patternsOverlap(deny, pattern))) return false;
	return matrix.allow.some((allow) => toolPatternCovers(allow, pattern));
}

/**
 * The level that is actually in effect under a RESOLVED matrix: the widest
 * declared level all of whose tools are still reachable. `null` when even the
 * narrowest level is not (some scope granted nothing) or nothing is declared.
 */
export function resolveEffectiveConnectionScopePreset(
	presets: readonly ConnectionScopePresetDeclaration[],
	matrix: ToolGrantMatrix
): ConnectionScopePresetId | null {
	for (const preset of [...presets].reverse()) {
		if (preset.toolPatterns.every((pattern) => patternReachable(matrix, pattern))) {
			return preset.id;
		}
	}
	return null;
}

/**
 * Which scope narrowed the effective level below the requested one?
 *
 * The LEAST specific scope whose `deny` touches a tool the requested level
 * unlocks — a deny is permanent from that scope down, so that is where the
 * owner has to look. When no deny explains it (an `allow` list narrowed it
 * instead), the most specific scope that contributed anything is reported.
 * `null` when nothing narrowed.
 */
export function connectionScopePresetClampSource(
	presets: readonly ConnectionScopePresetDeclaration[],
	requested: ConnectionScopePresetId | null,
	effective: ConnectionScopePresetId | null,
	resolved: { source: ToolGrantSource; chain: readonly ToolGrantChainEntry[] }
): ToolGrantSource | null {
	if (requested === null) return null;
	if (effective !== null && !isNarrowerConnectionScopePreset(effective, requested)) return null;
	const wanted = presets.find((preset) => preset.id === requested)?.toolPatterns ?? [];
	for (const entry of resolved.chain) {
		if (entry.deny.some((deny) => wanted.some((pattern) => patternsOverlap(deny, pattern)))) {
			return entry.scope;
		}
	}
	return resolved.source;
}

/** Does a level unlock this concrete tool name? Same matcher as the tool-grant matrix. */
export function connectionScopePresetCoversTool(
	presets: readonly ConnectionScopePresetDeclaration[],
	target: ConnectionScopePresetId,
	toolName: string
): boolean {
	const preset = presets.find((candidate) => candidate.id === target);
	return preset ? matchesAnyToolPattern(preset.toolPatterns, toolName) : false;
}

/** Is `a` strictly narrower than `b`? */
export function isNarrowerConnectionScopePreset(a: ConnectionScopePresetId, b: ConnectionScopePresetId): boolean {
	return presetRank(a) < presetRank(b);
}

// ── Wire shapes ──────────────────────────────────────────────────────

/** One provider that declares levels, as the API lists it. Provider scope strings are deliberately absent. */
export interface ConnectionScopePresetProviderDto {
	providerId: string;
	providerName: string;
	presets: Array<{ id: ConnectionScopePresetId; toolPatterns: string[] }>;
}

/** The level at one tool-grant scope, and what is actually in effect there. */
export interface ConnectionScopePresetStateDto {
	providerId: string;
	scopeType: ToolGrantScope;
	scopeId: string;
	/** Declared levels, least → most access. */
	presets: ConnectionScopePresetId[];
	/** What this scope's own row selects. */
	requested: ConnectionScopePresetId | null;
	/** What the whole chain leaves in effect. */
	effective: ConnectionScopePresetId | null;
	/** The scope that narrowed `effective` below `requested`; `null` when nothing did. */
	clampedBy: ToolGrantSource | null;
}
