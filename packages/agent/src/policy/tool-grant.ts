import {
    PLATFORM_DEFAULT_TOOL_GRANT,
    TOOL_GRANT_SCOPE_PRECEDENCE,
    matchesAnyToolPattern,
    matchesToolPattern,
    sanitizeToolGrantOverride,
    toolPatternCovers,
    type ResolvedToolGrants,
    type ToolGrantChainEntry,
    type ToolGrantDecision,
    type ToolGrantMatrix,
    type ToolGrantOverride,
    type ToolGrantScope,
    type ToolGrantSource,
} from '@ever-works/contracts';

/**
 * Tool-grant matrix (audit item G4) — the PURE half.
 *
 * Before this existed, tool access could not be scoped: the only gate was
 * the per-Agent `permissions` booleans, which live on the Agent's own row.
 * An organization could not say "no Agent under me may call `deploy_*`"
 * and have that hold.
 *
 * The matrix folds four scopes over a permissive platform default:
 *
 *     platform default  <  tenant  <  organization  <  Work  <  Agent
 *
 * ## The one rule that makes this a security boundary
 *
 * **A grant may never widen scope upward.** The fold is therefore NOT a
 * "last writer wins" override like the merge-policy matrix:
 *
 *   - `allow` INTERSECTS. A child layer keeps only the patterns some
 *     ancestor pattern already covers; anything else is REJECTED and
 *     reported in the chain (so an operator can see why their grant did
 *     nothing) but never applied.
 *   - `deny` UNIONS and is permanent. Once any ancestor denies a tool no
 *     descendant can un-deny it.
 *
 * "Most specific wins" still holds in the sense that matters: within the
 * bounds its ancestors set, the deepest layer that speaks about a tool is
 * the one that decides, and `decideToolGrant` reports exactly which layer
 * that was.
 *
 * ## Safe default
 *
 * With no rows anywhere the chain resolves to `PLATFORM_DEFAULT_TOOL_GRANT`
 * (`allow: ['*']`, `deny: []`) — i.e. today's behaviour, unchanged. The
 * matrix only ever subtracts, and subtracts nothing until someone writes a
 * row.
 *
 * Everything here is side-effect free so the precedence rules and the
 * decision can be unit-tested without a database, and so the same
 * functions run in the API, the worker and the agent tool loop. The I/O
 * half (loading the rows) lives in `tool-grant.service.ts`.
 */

/** One layer of the resolution chain. */
export interface ToolGrantLayer {
    scope: ToolGrantScope;
    /** Row id of the scope entity; kept for the reported chain. */
    id: string;
    /** What the row stores. `null`/`undefined`/`{}` all mean "inherit". */
    grant?: ToolGrantOverride | null;
}

function cloneMatrix(matrix: ToolGrantMatrix): ToolGrantMatrix {
    return { allow: [...matrix.allow], deny: [...matrix.deny] };
}

/**
 * Split a child's requested allow patterns into the ones its ancestors
 * already cover (kept) and the ones they never granted (rejected).
 *
 * Exported because this split IS the no-upward-widening rule, and a rule
 * that cannot be tested in isolation is a rule nobody trusts.
 */
export function narrowAllowPatterns(
    inherited: readonly string[],
    requested: readonly string[],
): { kept: string[]; rejected: string[] } {
    const kept: string[] = [];
    const rejected: string[] = [];
    for (const pattern of requested) {
        const covered = inherited.some((outer) => toolPatternCovers(outer, pattern));
        if (covered) kept.push(pattern);
        else rejected.push(pattern);
    }
    return { kept: Array.from(new Set(kept)), rejected: Array.from(new Set(rejected)) };
}

/**
 * THE resolution function. Folds the layers over the platform default,
 * least → most specific.
 *
 * Layers may be passed in any order — they are sorted into the documented
 * precedence here, so no caller can accidentally invert it (which, for
 * this matrix, would mean a tenant "narrowing" an Agent instead of the
 * other way round).
 */
export function resolveToolGrantChain(layers: ToolGrantLayer[]): ResolvedToolGrants {
    const ordered = [...layers].sort(
        (a, b) =>
            TOOL_GRANT_SCOPE_PRECEDENCE.indexOf(a.scope) -
            TOOL_GRANT_SCOPE_PRECEDENCE.indexOf(b.scope),
    );

    const matrix = cloneMatrix(PLATFORM_DEFAULT_TOOL_GRANT);
    const chain: ToolGrantChainEntry[] = [
        {
            scope: 'default',
            id: null,
            allow: [...PLATFORM_DEFAULT_TOOL_GRANT.allow],
            deny: [...PLATFORM_DEFAULT_TOOL_GRANT.deny],
            rejected: [],
        },
    ];

    let source: ToolGrantSource = 'default';

    for (const layer of ordered) {
        const override = sanitizeToolGrantOverride(layer.grant);
        const entry: ToolGrantChainEntry = {
            scope: layer.scope,
            id: layer.id,
            allow: [],
            deny: [],
            rejected: [],
        };

        if (override.allow !== undefined) {
            // Narrow, never widen: only patterns an ancestor already
            // covers survive. An empty result is legitimate — "this scope
            // grants nothing" is the strongest narrowing there is.
            const { kept, rejected } = narrowAllowPatterns(matrix.allow, override.allow);
            matrix.allow = kept;
            entry.allow = [...kept];
            entry.rejected = rejected;
            source = layer.scope;
        }

        if (override.deny !== undefined && override.deny.length > 0) {
            matrix.deny = Array.from(new Set([...matrix.deny, ...override.deny]));
            entry.deny = [...override.deny];
            source = layer.scope;
        }

        chain.push(entry);
    }

    return { matrix, source, chain };
}

/** What the decision point needs beyond the tool name. */
export interface ToolGrantDecisionContext {
    /** The already-resolved matrix (from `resolveToolGrantChain`). */
    matrix: ToolGrantMatrix;
    /** The reported chain, used to attribute the decision to a scope. */
    chain?: ToolGrantChainEntry[];
}

/**
 * Attribute a decision to the most specific layer that spoke about the
 * tool. The chain is least → most specific, so we scan BACKWARDS and stop
 * at the first layer whose patterns match.
 */
function attribute(
    chain: ToolGrantChainEntry[] | undefined,
    toolName: string,
    field: 'allow' | 'deny',
): ToolGrantSource {
    if (!chain || chain.length === 0) return 'default';
    for (let i = chain.length - 1; i >= 0; i -= 1) {
        const entry = chain[i];
        if (matchesAnyToolPattern(entry[field], toolName)) return entry.scope;
    }
    return 'default';
}

/**
 * THE decision point. Every path that could hand a tool to a model routes
 * through this one function, so "may this tool be called in this scope?"
 * is answered in exactly one place.
 *
 * Order matters: deny beats allow. A denied tool is denied even if some
 * layer also allows it — otherwise a broad `allow: ['*']` at the tenant
 * would defeat a targeted `deny` beneath it.
 */
export function decideToolGrant(
    ctx: ToolGrantDecisionContext,
    toolName: string,
): ToolGrantDecision {
    const name = typeof toolName === 'string' ? toolName.trim() : '';
    if (!name) {
        return {
            allowed: false,
            toolName: String(toolName ?? ''),
            source: 'default',
            code: 'tool-name-invalid',
            reason: 'A tool name is required to evaluate a grant.',
        };
    }

    const denyMatch = ctx.matrix.deny.find((pattern) => matchesToolPattern(pattern, name));
    if (denyMatch) {
        return {
            allowed: false,
            toolName: name,
            source: attribute(ctx.chain, name, 'deny'),
            code: 'tool-denied',
            reason: `Tool '${name}' is denied by the effective tool-grant matrix (pattern '${denyMatch}').`,
        };
    }

    if (!matchesAnyToolPattern(ctx.matrix.allow, name)) {
        return {
            allowed: false,
            toolName: name,
            source: attribute(ctx.chain, name, 'allow'),
            code: 'tool-not-granted',
            reason:
                `Tool '${name}' is not granted by the effective tool-grant matrix (allowed: ` +
                `${ctx.matrix.allow.join(', ') || 'nothing'}).`,
        };
    }

    return { allowed: true, toolName: name, source: attribute(ctx.chain, name, 'allow') };
}

/**
 * Convenience for the tool loop: partition a set of tool names into the
 * granted ones and the refused ones (each with its refusal). Keeps the
 * caller from re-implementing the deny-beats-allow order.
 */
export function partitionToolsByGrant(
    resolved: Pick<ResolvedToolGrants, 'matrix' | 'chain'>,
    toolNames: readonly string[],
): { granted: string[]; refused: ToolGrantDecision[] } {
    const granted: string[] = [];
    const refused: ToolGrantDecision[] = [];
    for (const name of toolNames) {
        const decision = decideToolGrant({ matrix: resolved.matrix, chain: resolved.chain }, name);
        if (decision.allowed) granted.push(name);
        else refused.push(decision);
    }
    return { granted, refused };
}
