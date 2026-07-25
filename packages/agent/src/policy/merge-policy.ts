import {
    MERGE_POLICY_FIELDS,
    MERGE_POLICY_SCOPE_PRECEDENCE,
    PLATFORM_DEFAULT_MERGE_POLICY,
    sanitizeMergePolicyOverride,
    type GateStatus,
    type MergeDecision,
    type MergeMethod,
    type MergePolicy,
    type MergePolicyChainEntry,
    type MergePolicyOverride,
    type MergePolicyScope,
    type MergePolicySource,
    type ResolvedMergePolicy,
} from '@ever-works/contracts';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — the PURE half.
 *
 * The platform never hardcodes "agents do not merge". It ships a
 * conservative DEFAULT (`PLATFORM_DEFAULT_MERGE_POLICY`) that any of the
 * four scopes can override, field by field:
 *
 *     platform default  <  tenant  <  organization  <  Work  <  Agent
 *
 * Everything in this file is side-effect free so the precedence rules and
 * the merge decision can be unit-tested without a database, and so the
 * same functions can run in the API, the worker, or a future edge caller.
 * The I/O half (loading the four rows) lives in `merge-policy.service.ts`.
 */

/** One layer of the resolution chain, least specific first. */
export interface MergePolicyLayer {
    scope: MergePolicyScope;
    /** Row id of the scope entity; kept for the reported chain. */
    id: string;
    /** What the row stores. `null`/`undefined`/`{}` all mean "inherit". */
    policy?: MergePolicyOverride | null;
}

/**
 * The stored-override shape guard lives in `@ever-works/contracts`
 * (zero-dependency, next to the type) so writers that only touch the
 * contract — the API's organization update path, importers — do not have
 * to pull the agent package's entity graph in just to validate five
 * fields. Re-exported here so `@ever-works/agent/policy` remains the one
 * import site for everything merge-policy inside this package.
 */
export { sanitizeMergePolicyOverride };

/** Defensive copy so callers can never mutate the frozen platform default. */
function clonePolicy(policy: MergePolicy): MergePolicy {
    return {
        ...policy,
        allowedMergeMethods: [...policy.allowedMergeMethods],
        protectedBranches: [...policy.protectedBranches],
    };
}

/**
 * THE resolution function. Folds the layers over the platform default,
 * FIELD BY FIELD (a deep merge, not a whole-object override) so a Work can
 * change exactly one knob and inherit the other four.
 *
 * Layers may be passed in any order — they are sorted into the documented
 * precedence (`MERGE_POLICY_SCOPE_PRECEDENCE`) here, so no caller can
 * accidentally invert it.
 */
export function resolveMergePolicyChain(layers: MergePolicyLayer[]): ResolvedMergePolicy {
    const ordered = [...layers].sort(
        (a, b) =>
            MERGE_POLICY_SCOPE_PRECEDENCE.indexOf(a.scope) -
            MERGE_POLICY_SCOPE_PRECEDENCE.indexOf(b.scope),
    );

    const policy = clonePolicy(PLATFORM_DEFAULT_MERGE_POLICY);
    // Which layer index (or -1 for the platform default) owns each field.
    const owner = new Map<keyof MergePolicy, number>();
    for (const field of MERGE_POLICY_FIELDS) owner.set(field, -1);

    ordered.forEach((layer, index) => {
        const override = sanitizeMergePolicyOverride(layer.policy);
        for (const field of MERGE_POLICY_FIELDS) {
            const value = override[field];
            if (value === undefined) continue;
            // Field-level assignment: later (more specific) layers win only
            // for the fields they actually declare.
            (policy as unknown as Record<string, unknown>)[field] = Array.isArray(value)
                ? [...value]
                : value;
            owner.set(field, index);
        }
    });

    const fieldsOwnedBy = (index: number): (keyof MergePolicy)[] =>
        MERGE_POLICY_FIELDS.filter((field) => owner.get(field) === index);

    const chain: MergePolicyChainEntry[] = [
        { scope: 'default', id: null, fields: fieldsOwnedBy(-1) },
        ...ordered.map((layer, index) => ({
            scope: layer.scope as MergePolicySource,
            id: layer.id,
            fields: fieldsOwnedBy(index),
        })),
    ];

    // The most specific layer that contributed anything; 'default' when the
    // whole chain was silent.
    let source: MergePolicySource = 'default';
    for (const entry of chain) {
        if (entry.fields.length > 0) source = entry.scope;
    }

    return { policy, source, chain };
}

/** Context the single decision point evaluates against. */
export interface MergeDecisionContext {
    /** The already-resolved policy (from `resolveMergePolicyChain`). */
    policy: MergePolicy;
    /** Where the policy came from; echoed into the decision for logs/UI. */
    source?: MergePolicySource;
    /** Latest quality-gate verdict for the work being merged. */
    gateStatus?: GateStatus | null;
    /** Whether a human approval is on record for this merge. */
    humanApproved?: boolean;
    /**
     * The pull request's BASE branch. `refs/heads/` prefixes are stripped
     * and comparison is case-insensitive. When the policy protects at least
     * one branch and the target is unknown, the decision FAILS CLOSED — a
     * policy that cannot be evaluated is never satisfied.
     */
    targetBranch?: string | null;
    /**
     * Requested merge strategy. `undefined` means "provider default", which
     * every supported provider treats as a merge commit — so it is
     * evaluated as `'merge'` rather than waved through.
     */
    mergeMethod?: MergeMethod | null;
}

function normalizeBranch(ref: string): string {
    return ref
        .trim()
        .replace(/^refs\/heads\//i, '')
        .toLowerCase();
}

/**
 * THE decision point. Every agent-driven merge path routes through this
 * one function so there is exactly one place where "may this agent land
 * this pull request" is answered.
 *
 * Refusals are ordered from most to least fundamental, and each carries a
 * stable `code` plus a human `reason` that names the offending value — a
 * refusal a user cannot act on is a bug report waiting to happen.
 */
export function evaluateAgentMerge(ctx: MergeDecisionContext): MergeDecision {
    const { policy, source } = ctx;
    const deny = (code: NonNullable<MergeDecision['code']>, reason: string): MergeDecision => ({
        allowed: false,
        code,
        reason,
        source,
    });

    if (!policy.allowAgentMerge) {
        return deny(
            'agent-merge-disabled',
            'Agent merges are disabled by the effective merge policy' +
                `${source ? ` (from ${source} scope)` : ''}. Enable allowAgentMerge at the tenant, organization, Work or Agent scope to allow it.`,
        );
    }

    if (policy.protectedBranches.length > 0) {
        if (!ctx.targetBranch || !ctx.targetBranch.trim()) {
            return deny(
                'target-branch-unknown',
                'The pull request target branch could not be determined, and the merge policy protects ' +
                    `${policy.protectedBranches.length} branch(es) — refusing rather than merging blind.`,
            );
        }
        const target = normalizeBranch(ctx.targetBranch);
        const protectedMatch = policy.protectedBranches.find(
            (branch) => normalizeBranch(branch) === target,
        );
        if (protectedMatch) {
            return deny(
                'protected-branch',
                `Branch '${protectedMatch}' is protected by the effective merge policy — an agent may not merge into it.`,
            );
        }
    }

    const method: MergeMethod = ctx.mergeMethod ?? 'merge';
    if (!policy.allowedMergeMethods.includes(method)) {
        return deny(
            'merge-method-not-allowed',
            `Merge method '${method}' is not allowed by the effective merge policy (allowed: ${
                policy.allowedMergeMethods.join(', ') || 'none'
            }).`,
        );
    }

    if (policy.requireGreenGate && ctx.gateStatus !== 'green') {
        return deny(
            'gate-not-green',
            `The effective merge policy requires a green quality gate; the current gate status is '${
                ctx.gateStatus ?? 'unknown'
            }'.`,
        );
    }

    if (policy.requireHumanApproval && !ctx.humanApproved) {
        return deny(
            'human-approval-required',
            'The effective merge policy requires a human approval before an agent may merge.',
        );
    }

    return { allowed: true, source };
}
