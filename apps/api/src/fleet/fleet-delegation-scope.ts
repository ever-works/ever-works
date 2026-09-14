/**
 * Judgment layer G9 on the FLEET — does a delegated run's admission scope
 * narrow what the run may do, in a way a fleet node would have to enforce?
 *
 * A leaf on purpose (no Nest, no repository, no contracts runtime import):
 * a pure reading of the `agent_runs.delegationScope` column value, shared by
 * the planner's refusal and its specs, so "narrowed" has exactly one
 * definition on the fleet path. It also holds the one-shot clearance the
 * dispatcher hands the job writer (see {@link markDelegationScopeCleared}),
 * so the router can refuse a payload that never went through the guard.
 *
 * ## What "narrows" means
 *
 * `SubAgentScope` (packages/contracts/src/delegation/sub-agent-delegation.types.ts)
 * has three dimensions that restrict a run's surface. A scope narrows it
 * when ANY of them does:
 *
 *   - `allowedTools` is an ARRAY that does not contain the `'*'` wildcard
 *     (`[]` included: no tools at all is the narrowest list there is).
 *     Reads the LIST the way `filterToolNamesBySubAgentScope` — the one
 *     enforcement point that exists, in the in-process tool loop — reads it:
 *     a wildcard ANYWHERE in the list (`hasWildcard` is `includes('*')`), an
 *     absent key and a non-array value all impose no restriction there, so
 *     they impose none here. So every list the cloud treats as "no
 *     restriction" passes here, and the fleet never admits a list the cloud
 *     would use to limit tools.
 *
 *     This is NOT "refuse only what the cloud would actually limit". The
 *     cloud compares a concrete list with the agent's resolved catalog, and
 *     a list equal to that catalog withholds nothing there; the fleet has no
 *     catalog to compare against, so any concrete list narrows here. That is
 *     the common case: `delegateToAgent` turns `['*']` into the parent's
 *     concrete tool names, and `childAgentId` defaults to the parent, so a
 *     default self-delegation runs with every tool on the cloud and is
 *     refused on the fleet. The two rules below are stricter than the cloud
 *     as well: the in-process runtime enforces neither `allowedPaths` nor
 *     `networkAccess`, while a node has a shell and a push of its own.
 *   - `allowedPaths` is present at all. `[]` is "no paths", the narrowest
 *     path scope, not "unset"; only an ABSENT key means "no restriction"
 *     (the contract's own `narrowSubAgentScope` / `isSubAgentScopeSubset`
 *     test `!== undefined`, so a `null` is a present, malformed value and
 *     is treated as narrowing rather than guessed away).
 *   - `networkAccess` is present and not `true`. `false` is the documented
 *     restriction; a `null` (or any other non-boolean) is read as OFF,
 *     which is how the contract's `Boolean(...)` / truthiness checks read
 *     it when a child is narrowed against a parent.
 *
 * `workId` / `organizationId` pin WHICH Work and organization a child
 * belongs to; the child Task is created inside that Work, so they do not
 * widen or narrow the tool surface and are not part of this rule.
 *
 * ## Fail closed on shape
 *
 * `null` / `undefined` is "not a delegated run" (every ordinary dispatch,
 * and every run that predates the column). Anything else that is not a
 * plain object cannot be proven unrestricted and NARROWS:
 *
 *   - a STRING (the column is `simple-json`, so the ORM hands back a parsed
 *     object; a string only arrives from a raw read or a double-encoded
 *     value) is parsed once and must decode to a plain object — unparseable
 *     text, or JSON that decodes to anything else (`null`, an array, a
 *     number, another string), narrows;
 *   - an array, number or boolean narrows.
 */

/**
 * Stable reason tokens a refusal leads its message with, so the run row's
 * `errorMessage` (`dispatch-failed: <token>: …`) says which rule refused it.
 * Distinct from every other fleet refusal on purpose.
 *
 *   - `UNENFORCEABLE` — the row was read and its scope narrows the surface.
 *   - `UNVERIFIABLE`  — the row could not be read, so the scope could not be
 *                       proven unrestricted (the fail-closed half).
 */
export const FLEET_DELEGATION_SCOPE_UNENFORCEABLE = 'fleet-delegation-scope-unenforceable' as const;
export const FLEET_DELEGATION_SCOPE_UNVERIFIABLE = 'fleet-delegation-scope-unverifiable' as const;
export type FleetDelegationScopeRefusalCode =
    | typeof FLEET_DELEGATION_SCOPE_UNENFORCEABLE
    | typeof FLEET_DELEGATION_SCOPE_UNVERIFIABLE;

/** The only tool wildcard `SubAgentScope` defines (mirrors `TOOL_WILDCARD` in contracts). */
const TOOL_WILDCARD = '*';

/** Cap on how many tool names a refusal message lists — agent tool sets run to dozens. */
const MAX_LISTED_ENTRIES = 8;

/**
 * Every way `scope` narrows the run's surface, as short human-readable
 * clauses (`allowedTools [readFile]`, `networkAccess off`, …). Empty when it
 * narrows nothing. Pure; never throws.
 */
export function describeDelegationScopeNarrowing(scope: unknown): string[] {
    if (scope === null || scope === undefined) return [];

    let value: unknown = scope;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return ['scope is not valid JSON'];
        }
    }
    if (!isPlainObject(value)) {
        return [`scope is not an object (${describeShape(value)})`];
    }

    const reasons: string[] = [];

    const tools = value.allowedTools;
    if (Array.isArray(tools) && !tools.includes(TOOL_WILDCARD)) {
        reasons.push(
            tools.length === 0 ? 'allowedTools [] (no tools)' : `allowedTools ${listOf(tools)}`,
        );
    }

    if (value.allowedPaths !== undefined) {
        const paths = value.allowedPaths;
        if (Array.isArray(paths)) {
            reasons.push(
                paths.length === 0 ? 'allowedPaths [] (no paths)' : `allowedPaths ${listOf(paths)}`,
            );
        } else {
            reasons.push(`allowedPaths is malformed (${describeShape(paths)})`);
        }
    }

    if (value.networkAccess !== undefined && value.networkAccess !== true) {
        reasons.push(
            value.networkAccess === false
                ? 'networkAccess off'
                : `networkAccess is malformed (${describeShape(value.networkAccess)}), read as off`,
        );
    }

    return reasons;
}

/**
 * THE predicate: does this `agent_runs.delegationScope` value narrow the
 * run's tool surface (see the module doc for exactly what that means)?
 * `false` only for "not delegated" and for a scope that restricts nothing.
 */
export function delegationScopeNarrowsToolSurface(scope: unknown): boolean {
    return describeDelegationScopeNarrowing(scope).length > 0;
}

/**
 * Payloads the fleet-aware dispatcher has cleared through the G9 guard and
 * not yet handed to the job writer. Module-private: the only way in is
 * {@link markDelegationScopeCleared}, the only way out is
 * {@link consumeDelegationScopeClearance}. A `WeakSet`, so a payload whose
 * enqueue never happens (a plan that throws after clearance) is simply
 * garbage-collected.
 */
const clearedPayloads = new WeakSet<object>();

/**
 * Record that THIS dispatch payload object passed the G9 delegation-scope
 * guard. Called by the fleet-aware dispatcher, and only after the guard
 * resolved; never call it anywhere else — a caller that marks a payload
 * without asking the guard defeats the rule.
 */
export function markDelegationScopeCleared(payload: object): void {
    clearedPayloads.add(payload);
}

/**
 * The job writer's half (`FleetRunRouterService.enqueueAgentTask`): `true`
 * exactly once for a payload object the dispatcher cleared, and `false` for
 * anything else — a direct caller that skipped the dispatcher, or a second
 * enqueue of the same object. One-shot, so a clearance cannot be replayed.
 *
 * Why a proof of the check rather than a second run-row read: the router
 * has no run repository, and a second read per dispatch would buy nothing
 * the dispatcher's read did not already establish a few awaits earlier.
 */
export function consumeDelegationScopeClearance(payload: object): boolean {
    return clearedPayloads.delete(payload);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeShape(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

function listOf(entries: readonly unknown[]): string {
    const shown = entries.slice(0, MAX_LISTED_ENTRIES).map((entry) => String(entry));
    const more = entries.length - shown.length;
    return `[${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}]`;
}
