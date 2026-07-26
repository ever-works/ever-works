import type {
    MergePolicy,
    MergePolicyChainEntry,
    MergePolicyOverride,
    MergePolicyScope,
    MergePolicySource,
    MergeMethod,
    ResolvedMergePolicy,
} from '@ever-works/contracts';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — the pure half of
 * the settings UI.
 *
 * `GET /api/merge-policy/resolve` answers with `{ policy, source, chain }`.
 * The `chain` is the interesting part and the reason this feature is
 * worth a UI at all: it reports, per scope, exactly which FIELDS that
 * scope contributed to the final answer. Everything here turns that into
 * the two things a settings card has to say —
 *
 *   1. what the effective value is, and
 *   2. where it came from, so "agents may not merge here" is a sentence a
 *      user can act on rather than argue with.
 *
 * Zero React, zero fetch: all of it is unit-testable in isolation, which
 * is the point.
 */

/** Every field of the matrix, in the order the cards render them. */
export const MERGE_POLICY_UI_FIELDS = [
    'allowAgentMerge',
    'requireGreenGate',
    'requireHumanApproval',
    'allowedMergeMethods',
    'protectedBranches',
] as const satisfies readonly (keyof MergePolicy)[];

export type MergePolicyField = (typeof MERGE_POLICY_UI_FIELDS)[number];

/** The three merge strategies, mirrored for the checkbox row. */
export const MERGE_POLICY_UI_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase'];

/**
 * Where one field's effective value came from, and whether that is THIS
 * card's scope (i.e. the card owns it and can reset it to inherit) or an
 * ancestor's (the card can override it).
 */
export interface MergePolicyFieldOrigin {
    source: MergePolicySource;
    /** True when the field's owner is the scope this card edits. */
    ownedHere: boolean;
    /** Row id of the owning scope; `null` for the platform default. */
    id: string | null;
}

/**
 * Fold the resolution chain into a per-field origin map.
 *
 * The chain is ordered least → most specific and each entry lists only
 * the fields it actually OWNS (declared and not shadowed), so a field
 * appears in at most one entry. A field missing from every entry can only
 * mean the platform default — which is what the `'default'` link reports,
 * but we fall back to it explicitly so a truncated or empty chain (the
 * resolver returns `chain: []` when a lookup fails) still renders
 * something honest instead of throwing.
 */
export function resolveFieldOrigins(
    chain: MergePolicyChainEntry[] | undefined,
    scope: MergePolicyScope,
): Record<MergePolicyField, MergePolicyFieldOrigin> {
    const origins = {} as Record<MergePolicyField, MergePolicyFieldOrigin>;
    for (const field of MERGE_POLICY_UI_FIELDS) {
        origins[field] = { source: 'default', ownedHere: false, id: null };
    }
    for (const entry of chain ?? []) {
        for (const field of entry.fields ?? []) {
            if (!(MERGE_POLICY_UI_FIELDS as readonly string[]).includes(field)) continue;
            origins[field as MergePolicyField] = {
                source: entry.scope,
                ownedHere: entry.scope === scope,
                id: entry.id ?? null,
            };
        }
    }
    return origins;
}

/**
 * The label under each control. Deliberately says "inherited from X"
 * rather than just naming the scope: a bare scope name reads as "this is
 * set here", which is the exact confusion the chain exists to prevent.
 */
export function describeFieldOrigin(origin: MergePolicyFieldOrigin): string {
    if (origin.ownedHere) return 'Set here';
    if (origin.source === 'default') return 'Platform default';
    return `Inherited from ${origin.source}`;
}

/**
 * Reset-to-inherit: DELETE the key rather than writing a falsy value.
 * `null`/absent means "inherit" everywhere in this feature, and `false`
 * means "explicitly forbidden" — conflating them is the one mistake that
 * would make an inheritance UI worse than no UI.
 *
 * Returns `null` when the override empties out, because the write paths
 * store an empty override as NULL and the UI should send exactly what
 * will be stored.
 */
export function clearField(
    override: MergePolicyOverride | null | undefined,
    field: MergePolicyField,
): MergePolicyOverride | null {
    if (!override) return null;
    const next: MergePolicyOverride = { ...override };
    delete next[field];
    return Object.keys(next).length > 0 ? next : null;
}

/**
 * Set one field on the scope-local override, leaving every other field
 * inheriting. The counterpart of {@link clearField}: together they are
 * the whole write model, because a stored policy is a PARTIAL.
 */
export function setField<F extends MergePolicyField>(
    override: MergePolicyOverride | null | undefined,
    field: F,
    value: MergePolicy[F],
): MergePolicyOverride {
    return { ...(override ?? {}), [field]: value } as MergePolicyOverride;
}

/**
 * Whether the scope-local override declares a field at all. Drives the
 * enabled state of the reset-to-inherit control — resetting a field the
 * scope never set is a no-op the UI should not offer.
 */
export function isOverridden(
    override: MergePolicyOverride | null | undefined,
    field: MergePolicyField,
): boolean {
    return Boolean(override) && override![field] !== undefined;
}

/**
 * Toggle one merge method in the effective list, returning the NEW list.
 * Kept pure (and here) because the checkbox row is otherwise the most
 * bug-prone control on the card: an empty list is meaningful (it refuses
 * every merge), so it must be preservable rather than normalized away.
 */
export function toggleMergeMethod(
    current: readonly MergeMethod[],
    method: MergeMethod,
    enabled: boolean,
): MergeMethod[] {
    const set = new Set(current);
    if (enabled) set.add(method);
    else set.delete(method);
    // Stable, documented order rather than click order.
    return MERGE_POLICY_UI_METHODS.filter((candidate) => set.has(candidate));
}

/**
 * Parse the protected-branches textarea. One branch per line; blanks and
 * duplicates dropped, order preserved. An empty result is legal and means
 * "protect nothing" — the API validator caps the list at 50 × 255 chars.
 */
export function parseBranchList(raw: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of raw.split(/[\n,]/)) {
        const branch = line.trim();
        if (!branch) continue;
        const key = branch.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(branch.slice(0, 255));
    }
    return out.slice(0, 50);
}

/** Render a branch list back into the textarea. */
export function formatBranchList(branches: readonly string[] | undefined): string {
    return (branches ?? []).join('\n');
}

/**
 * One-line summary for the card header: the answer to "can an agent merge
 * here?" without reading five controls.
 */
export function summarizePolicy(policy: MergePolicy | undefined): string {
    if (!policy) return 'Loading the effective policy…';
    if (!policy.allowAgentMerge) {
        return 'Agents may open pull requests here, but may not merge them.';
    }
    const conditions: string[] = [];
    if (policy.requireGreenGate) conditions.push('the quality gate is green');
    if (policy.requireHumanApproval) conditions.push('a human has approved');
    const methods =
        policy.allowedMergeMethods.length > 0
            ? policy.allowedMergeMethods.join(' / ')
            : 'no method';
    const suffix = conditions.length > 0 ? ` when ${conditions.join(' and ')}` : '';
    return `Agents may merge using ${methods}${suffix}.`;
}

/** Narrowing helper for the fetch layer — the wire shape is untrusted. */
export function isResolvedMergePolicy(value: unknown): value is ResolvedMergePolicy {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ResolvedMergePolicy>;
    return (
        Boolean(candidate.policy) &&
        typeof candidate.policy === 'object' &&
        typeof (candidate.policy as MergePolicy).allowAgentMerge === 'boolean' &&
        Array.isArray((candidate.policy as MergePolicy).allowedMergeMethods) &&
        Array.isArray((candidate.policy as MergePolicy).protectedBranches)
    );
}
