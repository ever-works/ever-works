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
 *
 * This form cannot tell an operator's hand-written deny of a managed name from
 * one the control added, so it would remove both. Any path that writes a stored
 * row must use `applyConnectionScopePresetWithOwnership`, which never removes a
 * pattern the operator owned before the control touched it.
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

// ── Ownership (who put a deny pattern on the row) ────────────────────

/**
 * What the access-level control ITSELF wrote on one scope's tool-grant row,
 * for one provider: the level chosen there and the deny patterns the control
 * added. Stored beside the row (`tool_grants.presetOwnership`), keyed by
 * provider id.
 *
 * ## Why ownership is recorded, not inferred
 *
 * A level is ordinary deny patterns, and an operator can deny the very same
 * names by hand (`commitToRepo` at this agent, say). Inferring "the control
 * owns every pattern it manages" would let "Read and write" silently delete
 * that operator's safety control. So the control records exactly what it
 * added, and only ever removes what it recorded:
 *
 *   - A pattern that was already in `deny` when the control first touched it
 *     is operator-owned. No level change ever removes it.
 *   - Narrowing adds only the patterns that are not already denied, and
 *     records those.
 *   - Widening removes only recorded patterns (and never one another
 *     provider's level still records).
 *
 * A pattern the operator later removes by hand drops out of the record on
 * that write (`pruneConnectionScopePresetOwnership`), so re-adding it by hand
 * afterwards makes it operator-owned again.
 */
export interface ConnectionScopePresetOwnershipEntry {
	/** The level last chosen at this scope for this provider. */
	preset: ConnectionScopePresetId;
	/** Deny patterns the access-level control added and still owns. */
	deny: string[];
}

/** Provider id → what the access-level control owns on one row. */
export type ConnectionScopePresetOwnership = Record<string, ConnectionScopePresetOwnershipEntry>;

/**
 * Shape guard for a stored ownership record. Malformed entries are DROPPED —
 * a dropped entry only means the control owns less, so the worst case is a
 * pattern treated as operator-owned (kept), never one silently removed.
 */
export function normalizeConnectionScopePresetOwnership(raw: unknown): ConnectionScopePresetOwnership | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const out: ConnectionScopePresetOwnership = {};
	for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
		if (providerId.length === 0 || providerId.length > 128 || !value || typeof value !== 'object') continue;
		const entry = value as Record<string, unknown>;
		if (!isConnectionScopePresetId(entry.preset)) continue;
		out[providerId] = { preset: entry.preset, deny: cleanPatterns(entry.deny) };
	}
	return Object.keys(out).length > 0 ? out : null;
}

function hasToolPattern(list: readonly string[], pattern: string): boolean {
	return list.some((entry) => sameToolPattern(entry, pattern));
}

/** Every pattern ANY provider's level owns on this row. */
function ownedByAnyProvider(ownership: ConnectionScopePresetOwnership | null | undefined): string[] {
	const out: string[] = [];
	for (const entry of Object.values(ownership ?? {})) {
		for (const pattern of entry.deny) {
			if (!hasToolPattern(out, pattern)) out.push(pattern);
		}
	}
	return out;
}

/**
 * Keep only owned patterns that are still in `deny`. Run on every write that
 * does not come from the access-level control, so a pattern the operator
 * removed by hand is no longer the control's to manage. The chosen level is
 * kept. `null` when there was no usable record.
 */
export function pruneConnectionScopePresetOwnership(
	ownership: unknown,
	deny: readonly string[] | null | undefined
): ConnectionScopePresetOwnership | null {
	const normalized = normalizeConnectionScopePresetOwnership(ownership);
	if (!normalized) return null;
	const present = deny ?? [];
	const out: ConnectionScopePresetOwnership = {};
	for (const [providerId, entry] of Object.entries(normalized)) {
		out[providerId] = {
			preset: entry.preset,
			deny: entry.deny.filter((pattern) => hasToolPattern(present, pattern))
		};
	}
	return out;
}

/** Deny patterns on this row that no level owns — the operator's own rules. */
export function connectionScopePresetOperatorDeny(
	deny: readonly string[] | null | undefined,
	ownership: unknown
): string[] {
	const owned = ownedByAnyProvider(normalizeConnectionScopePresetOwnership(ownership));
	return (deny ?? []).filter((pattern) => !hasToolPattern(owned, pattern));
}

/** What to store at one scope after choosing a level there. */
export interface ConnectionScopePresetApplication {
	/** The override to store: `allow` untouched, `deny` recomputed. */
	grant: ToolGrantOverride;
	/** The ownership record to store alongside it. */
	ownership: ConnectionScopePresetOwnership;
}

/**
 * The override AND ownership record to store at ONE scope after choosing
 * `target` for `providerId` there — the ownership-aware counterpart of
 * `applyConnectionScopePresetToToolGrant`:
 *
 *   - operator-owned patterns (in `deny`, owned by no level) are never removed
 *     and never recorded as owned;
 *   - this provider's owned patterns that `target` does not deny are removed,
 *     unless another provider's level still owns them;
 *   - `target`'s deny patterns that are not already present are added and
 *     recorded.
 */
export function applyConnectionScopePresetWithOwnership(
	current: ToolGrantOverride | null | undefined,
	ownership: unknown,
	providerId: string,
	presets: readonly ConnectionScopePresetDeclaration[],
	target: ConnectionScopePresetId
): ConnectionScopePresetApplication {
	const before = [...(current?.deny ?? [])];
	const record = pruneConnectionScopePresetOwnership(ownership, before) ?? {};
	const mine = record[providerId]?.deny ?? [];
	const others: ConnectionScopePresetOwnership = {};
	for (const [id, entry] of Object.entries(record)) {
		if (id !== providerId) others[id] = entry;
	}
	const ownedElsewhere = ownedByAnyProvider(others);
	const operator = before.filter(
		(pattern) => !hasToolPattern(mine, pattern) && !hasToolPattern(ownedElsewhere, pattern)
	);
	const wanted = connectionScopePresetDenyPatterns(presets, target);

	const deny = before.filter(
		(pattern) =>
			!hasToolPattern(mine, pattern) || hasToolPattern(wanted, pattern) || hasToolPattern(ownedElsewhere, pattern)
	);
	for (const pattern of wanted) {
		if (!hasToolPattern(deny, pattern)) deny.push(pattern);
	}

	const grant: ToolGrantOverride = { deny };
	if (current?.allow !== undefined) grant.allow = [...current.allow];
	return {
		grant,
		ownership: {
			...others,
			[providerId]: { preset: target, deny: wanted.filter((pattern) => !hasToolPattern(operator, pattern)) }
		}
	};
}

/**
 * The level a scope selects for one provider, reading the ownership record
 * first: the recorded choice wins while the row still carries that level's
 * whole deny set (whoever owns each pattern). Without a usable record it falls
 * back to `storedConnectionScopePreset`, which reads the row's patterns alone.
 */
export function storedConnectionScopePresetWithOwnership(
	override: ToolGrantOverride | null | undefined,
	ownership: unknown,
	providerId: string,
	presets: readonly ConnectionScopePresetDeclaration[]
): ConnectionScopePresetId | null {
	if (presets.length === 0) return null;
	const entry = normalizeConnectionScopePresetOwnership(ownership)?.[providerId];
	if (entry && presets.some((preset) => preset.id === entry.preset)) {
		const deny = override?.deny ?? [];
		const needed = connectionScopePresetDenyPatterns(presets, entry.preset);
		if (needed.every((pattern) => hasToolPattern(deny, pattern))) return entry.preset;
	}
	return storedConnectionScopePreset(override, presets);
}

/**
 * Operator-owned deny patterns on this scope's OWN row that keep a tool of the
 * `requested` level closed — "blocked by an existing rule". Choosing a level
 * never removes these, so the UI says so instead of looking broken.
 */
export function connectionScopePresetBlockingDeny(
	presets: readonly ConnectionScopePresetDeclaration[],
	requested: ConnectionScopePresetId | null,
	deny: readonly string[] | null | undefined,
	ownership: unknown
): string[] {
	if (requested === null) return [];
	const tools = presets.find((preset) => preset.id === requested)?.toolPatterns ?? [];
	if (tools.length === 0) return [];
	return connectionScopePresetOperatorDeny(deny, ownership).filter((pattern) =>
		tools.some((tool) => patternsOverlap(pattern, tool))
	);
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
	/**
	 * Deny patterns an operator wrote on THIS scope's own row (not by choosing a
	 * level) that keep a tool of `requested` closed. Choosing a level never
	 * removes them. Absent / empty when nothing is blocked.
	 */
	blockedByExistingDeny?: string[];
}
