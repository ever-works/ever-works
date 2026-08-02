/**
 * Sub-agent delegation contract (judgment layer G9).
 *
 * Before this file an agent could PROPOSE a `spawn_agent` action into
 * the approval queue, but there was no contract for the delegation
 * itself: no way to say what the child may touch, no bound on how deep
 * the fan-out goes, and no typed result to hand back. "Spawn something"
 * with a free-form payload is not a delegation, it is a wish.
 *
 * The contract has three parts:
 *
 *   1. A REQUEST that states the objective, the inputs, the scope the
 *      child runs under, and the budget it may spend.
 *   2. A SCOPE algebra: a child's scope is always the INTERSECTION of
 *      what it asked for and what its parent already had
 *      ({@link narrowSubAgentScope}). Privilege can only ever shrink
 *      going down the tree — that is the whole safety property.
 *   3. A typed RESULT with a closed status set, so a caller can branch
 *      on `completed | failed | refused | escalated` instead of
 *      sniffing an untyped blob. A refusal always carries a machine
 *      code, and an escalation reuses the G3
 *      `AgentEscalationReasonCode` vocabulary rather than inventing a
 *      parallel one.
 *
 * Zero-dependency value types + pure helpers. The service that turns a
 * validated request into an actual child run lives in
 * `@ever-works/agent/agents`; nothing here talks to a runtime.
 */

import type { AgentEscalationReasonCode } from '../agents/escalation.types.js';

/** How a delegation ended. Persisted tokens — never rename, only add. */
export type SubAgentDelegationStatus = 'completed' | 'failed' | 'refused' | 'escalated';

export const SUB_AGENT_DELEGATION_STATUSES: readonly SubAgentDelegationStatus[] = [
	'completed',
	'failed',
	'refused',
	'escalated'
];

/**
 * Why a delegation was refused BEFORE anything ran. Distinct from
 * `failed` on purpose: a refusal is the contract saying no, a failure
 * is the child trying and not managing it.
 */
export type SubAgentDelegationRefusalCode =
	| 'invalid-request'
	| 'depth-exceeded'
	| 'fanout-exceeded'
	| 'scope-not-subset'
	| 'scope-empty'
	| 'budget-exceeded'
	| 'no-runner';

export const SUB_AGENT_DELEGATION_REFUSAL_CODES: readonly SubAgentDelegationRefusalCode[] = [
	'invalid-request',
	'depth-exceeded',
	'fanout-exceeded',
	'scope-not-subset',
	'scope-empty',
	'budget-exceeded',
	'no-runner'
];

/** Default fan-out bounds. Operator knobs, not product limits. */
export const SUB_AGENT_MAX_DELEGATION_DEPTH = 3;
export const SUB_AGENT_MAX_SIBLING_DELEGATIONS = 5;
export const SUB_AGENT_MAX_OBJECTIVE_CHARS = 2000;
export const SUB_AGENT_MAX_SUMMARY_CHARS = 1000;

/**
 * What a delegated run is allowed to touch.
 *
 * `allowedTools` is an explicit allowlist of tool ids. The single-entry
 * wildcard `['*']` means "everything the parent had" and exists so a
 * top-level scope can be expressed without enumerating the whole tool
 * catalog; it is the ONLY wildcard, and intersecting anything with it
 * yields the other side.
 */
export interface SubAgentScope {
	readonly allowedTools: readonly string[];
	/** Repo-relative path prefixes the child may read/write. Absent ⇒ inherit the parent's. */
	readonly allowedPaths?: readonly string[];
	readonly workId?: string | null;
	readonly organizationId?: string | null;
	/** Outbound network. A child may never turn this ON when the parent had it off. */
	readonly networkAccess?: boolean;
}

/** Ceilings for one delegated run. Every field is optional; absent ⇒ inherit the parent's. */
export interface SubAgentBudget {
	readonly maxCostCents?: number;
	readonly maxTokens?: number;
	readonly maxDurationMs?: number;
}

export interface SubAgentDelegationRequest {
	/** Caller-minted id. Echoed on the result so a caller can correlate. */
	readonly delegationId: string;
	readonly parentAgentId: string;
	readonly parentRunId?: string | null;
	readonly parentTaskId?: string | null;
	/** 0 for a delegation issued by a top-level run; +1 per level below. */
	readonly depth: number;
	/** What the child must accomplish, in prose. */
	readonly objective: string;
	/** Checkable statements the child's output must satisfy. */
	readonly successCriteria?: readonly string[];
	/** Structured inputs handed to the child (already-gathered context). */
	readonly inputs?: Readonly<Record<string, unknown>>;
	readonly scope: SubAgentScope;
	readonly budget?: SubAgentBudget;
	/** Pin the child to a specific Agent row; omit to let the host pick. */
	readonly childAgentId?: string | null;
	/** Hint for the shape the child should return (a JSON-schema-ish description). */
	readonly resultSchemaHint?: string;
}

export interface SubAgentDelegationUsage {
	readonly costCents?: number;
	readonly tokens?: number;
	readonly durationMs?: number;
}

export interface SubAgentDelegationArtifact {
	/** Short machine-ish label: `patch`, `report`, `pr-url`. */
	readonly label: string;
	/** Where the artifact lives (path, url, id). Never inline secrets. */
	readonly ref: string;
	readonly mediaType?: string;
}

export interface SubAgentDelegationResult {
	readonly delegationId: string;
	readonly status: SubAgentDelegationStatus;
	/** One line a human (or the parent) can read without opening anything. */
	readonly summary: string;
	/** The child's structured output. `null` on refusal. */
	readonly output: unknown;
	/** Set iff `status === 'refused'`. */
	readonly refusalCode?: SubAgentDelegationRefusalCode;
	/** Set iff `status === 'escalated'` — reuses the G3 vocabulary. */
	readonly escalationReasonCode?: AgentEscalationReasonCode;
	readonly childRunId?: string | null;
	readonly childAgentId?: string | null;
	readonly usage?: SubAgentDelegationUsage;
	readonly artifacts?: readonly SubAgentDelegationArtifact[];
}

const TOOL_WILDCARD = '*';

function hasWildcard(tools: readonly string[] | undefined): boolean {
	return Array.isArray(tools) && tools.includes(TOOL_WILDCARD);
}

function intersectAllowlist(
	parent: readonly string[] | undefined,
	requested: readonly string[] | undefined
): readonly string[] {
	// Absent on the child ⇒ inherit the parent's list verbatim.
	if (requested === undefined) return parent === undefined ? [] : [...parent];
	if (hasWildcard(requested)) return parent === undefined ? [TOOL_WILDCARD] : [...parent];
	if (parent === undefined || hasWildcard(parent)) return [...requested];
	const allowed = new Set(parent);
	return requested.filter((entry) => allowed.has(entry));
}

/** Is `path` the same as, or nested under, one of `prefixes`? */
function isUnderAnyPrefix(path: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Which of `toolNames` a run under `scope` may actually call.
 *
 * Narrowing a delegation decides what a child is ALLOWED; this is what
 * turns that decision into the concrete tool list handed to a child's
 * run. Without it the narrowed scope is computed and then dropped, and a
 * child executes with its own agent's full tool set — the contract's
 * "privilege can only ever shrink going down the tree" holding at the
 * admission boundary and nowhere else.
 *
 * Lives HERE, next to `narrowSubAgentScope`, because the wildcard rule is
 * contract semantics: `['*']` means "everything the parent had", so it
 * imposes no additional restriction. Reimplementing that in the run loop
 * would let the two definitions drift.
 *
 * Absent / non-array `allowedTools` also imposes no restriction — the
 * caller has not expressed a scope, and inventing an empty one would
 * silently strip every tool from a run that never asked to be limited.
 */
export function filterToolNamesBySubAgentScope(
	toolNames: readonly string[],
	scope: Pick<SubAgentScope, 'allowedTools'> | null | undefined
): readonly string[] {
	const allowed = scope?.allowedTools;
	if (!Array.isArray(allowed)) return toolNames;
	if (hasWildcard(allowed)) return toolNames;
	const permitted = new Set(allowed);
	return toolNames.filter((name) => permitted.has(name));
}

/**
 * Compute the scope a child ACTUALLY runs under: the intersection of
 * what it asked for and what the parent had. Never widens — an entry
 * the parent lacks is dropped, and `networkAccess` can only go from
 * true to false.
 */
export function narrowSubAgentScope(parent: SubAgentScope, requested: SubAgentScope): SubAgentScope {
	const allowedTools = intersectAllowlist(parent.allowedTools, requested.allowedTools);
	const parentPaths = parent.allowedPaths;
	const allowedPaths =
		requested.allowedPaths === undefined
			? parentPaths
			: parentPaths === undefined
				? [...requested.allowedPaths]
				: requested.allowedPaths.filter((path) => isUnderAnyPrefix(path, parentPaths));
	const narrowed: {
		allowedTools: readonly string[];
		allowedPaths?: readonly string[];
		workId?: string | null;
		organizationId?: string | null;
		networkAccess?: boolean;
	} = { allowedTools };
	if (allowedPaths !== undefined) narrowed.allowedPaths = allowedPaths;
	// Scope keys are pinned by the parent — a child may not hop Works or orgs.
	if (parent.workId !== undefined) narrowed.workId = parent.workId;
	if (parent.organizationId !== undefined) narrowed.organizationId = parent.organizationId;
	if (parent.networkAccess !== undefined || requested.networkAccess !== undefined) {
		narrowed.networkAccess = Boolean(parent.networkAccess) && Boolean(requested.networkAccess);
	}
	return narrowed;
}

/** Is `child` no wider than `parent` in every dimension? */
export function isSubAgentScopeSubset(child: SubAgentScope, parent: SubAgentScope): boolean {
	if (!hasWildcard(parent.allowedTools)) {
		if (hasWildcard(child.allowedTools)) return false;
		const allowed = new Set(parent.allowedTools ?? []);
		if ((child.allowedTools ?? []).some((tool) => !allowed.has(tool))) return false;
	}
	const parentPaths = parent.allowedPaths;
	if (parentPaths !== undefined) {
		const childPaths = child.allowedPaths ?? [];
		if (childPaths.some((path) => !isUnderAnyPrefix(path, parentPaths))) return false;
	}
	if (child.networkAccess && !parent.networkAccess) return false;
	if (parent.workId !== undefined && parent.workId !== null && child.workId !== parent.workId) return false;
	if (
		parent.organizationId !== undefined &&
		parent.organizationId !== null &&
		child.organizationId !== parent.organizationId
	) {
		return false;
	}
	return true;
}

/** Budget ceilings enforced against the parent's remaining allowance. */
export interface SubAgentDelegationLimits {
	readonly maxDepth?: number;
	readonly maxSiblings?: number;
	/** How many delegations the parent has already issued in this run. */
	readonly siblingCount?: number;
	/** The scope the PARENT holds; the request's scope is narrowed against it. */
	readonly parentScope?: SubAgentScope;
	/** What the parent has left to spend, if it is metered. */
	readonly remainingCostCents?: number;
}

export type SubAgentDelegationValidation =
	| { readonly ok: true; readonly request: SubAgentDelegationRequest }
	| {
			readonly ok: false;
			readonly refusalCode: SubAgentDelegationRefusalCode;
			readonly message: string;
	  };

/**
 * Validate a delegation request and return the EFFECTIVE request — the
 * one with the narrowed scope already applied. Callers must run the
 * returned request, never the one they were handed: that is what makes
 * "privilege only shrinks" mechanical instead of a convention.
 */
export function validateSubAgentDelegationRequest(
	request: SubAgentDelegationRequest,
	limits: SubAgentDelegationLimits = {}
): SubAgentDelegationValidation {
	if (!request || typeof request !== 'object') {
		return { ok: false, refusalCode: 'invalid-request', message: 'request is not an object' };
	}
	if (!request.delegationId) {
		return { ok: false, refusalCode: 'invalid-request', message: 'delegationId is required' };
	}
	if (!request.parentAgentId) {
		return { ok: false, refusalCode: 'invalid-request', message: 'parentAgentId is required' };
	}
	const objective = typeof request.objective === 'string' ? request.objective.trim() : '';
	if (objective.length === 0) {
		return { ok: false, refusalCode: 'invalid-request', message: 'objective is required' };
	}
	if (objective.length > SUB_AGENT_MAX_OBJECTIVE_CHARS) {
		return {
			ok: false,
			refusalCode: 'invalid-request',
			message: `objective exceeds ${SUB_AGENT_MAX_OBJECTIVE_CHARS} characters`
		};
	}
	if (!Number.isInteger(request.depth) || request.depth < 0) {
		return { ok: false, refusalCode: 'invalid-request', message: 'depth must be a non-negative integer' };
	}
	if (!request.scope || !Array.isArray(request.scope.allowedTools)) {
		return { ok: false, refusalCode: 'invalid-request', message: 'scope.allowedTools is required' };
	}

	const maxDepth = limits.maxDepth ?? SUB_AGENT_MAX_DELEGATION_DEPTH;
	if (request.depth >= maxDepth) {
		return {
			ok: false,
			refusalCode: 'depth-exceeded',
			message: `delegation depth ${request.depth} reaches the limit of ${maxDepth}`
		};
	}

	const maxSiblings = limits.maxSiblings ?? SUB_AGENT_MAX_SIBLING_DELEGATIONS;
	if ((limits.siblingCount ?? 0) >= maxSiblings) {
		return {
			ok: false,
			refusalCode: 'fanout-exceeded',
			message: `parent already issued ${limits.siblingCount} delegations (limit ${maxSiblings})`
		};
	}

	let effectiveScope = request.scope;
	if (limits.parentScope) {
		effectiveScope = narrowSubAgentScope(limits.parentScope, request.scope);
		if (!isSubAgentScopeSubset(effectiveScope, limits.parentScope)) {
			return {
				ok: false,
				refusalCode: 'scope-not-subset',
				message: 'requested scope is not a subset of the parent scope'
			};
		}
	}
	if (effectiveScope.allowedTools.length === 0) {
		return {
			ok: false,
			refusalCode: 'scope-empty',
			message: 'narrowed scope grants no tools — the child could not do anything'
		};
	}

	if (
		limits.remainingCostCents !== undefined &&
		request.budget?.maxCostCents !== undefined &&
		request.budget.maxCostCents > limits.remainingCostCents
	) {
		return {
			ok: false,
			refusalCode: 'budget-exceeded',
			message: `requested ${request.budget.maxCostCents}c exceeds the parent's remaining ${limits.remainingCostCents}c`
		};
	}

	return { ok: true, request: { ...request, objective, scope: effectiveScope } };
}

/** Build the canonical refusal result for a request that never ran. */
export function refuseSubAgentDelegation(
	delegationId: string,
	refusalCode: SubAgentDelegationRefusalCode,
	message: string
): SubAgentDelegationResult {
	return {
		delegationId,
		status: 'refused',
		refusalCode,
		summary: message.slice(0, SUB_AGENT_MAX_SUMMARY_CHARS),
		output: null
	};
}

/** True when the parent may consume `result.output` as a real answer. */
export function isSubAgentDelegationSuccessful(result: SubAgentDelegationResult): boolean {
	return result.status === 'completed';
}
