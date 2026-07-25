/**
 * Merge policy — the configurable enforcement matrix for agent-driven merges
 * (Wave 3, founder decision D4).
 *
 * The platform does NOT hardcode whether an agent may merge its own pull
 * request. Whether it may is a POLICY, resolvable at four scopes
 * (tenant → organization → Work → Agent) and layered over a conservative
 * platform DEFAULT. Operators keep the safe posture by doing nothing and can
 * opt into "agents merge when green" — or anything in between — per scope.
 *
 * This package holds the zero-dependency storage/wire shapes only. The
 * resolution algorithm, the deep merge and the single decision point
 * (`canAgentMerge`) live in `@ever-works/agent` (`policy/`), and enforcement
 * lives at the git facade + the Task finalize path.
 */

/** Merge strategy a provider can be asked to use when landing a pull request. */
export type MergeMethod = 'merge' | 'squash' | 'rebase';

/**
 * Canonical list of merge methods. Kept as a const so validators (DTO
 * `@IsIn`, import sanitizers) share one source of truth with the type.
 */
export const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase'];

/**
 * The fully-resolved policy. Every field is REQUIRED here — a resolved policy
 * is always complete, because unset fields fall through to the next scope and
 * ultimately to {@link PLATFORM_DEFAULT_MERGE_POLICY}.
 */
export interface MergePolicy {
	/**
	 * May an agent land a pull request at all? `false` does not stop the agent
	 * from OPENING one (that is `AgentPermissions.canOpenPullRequests`) — it
	 * stops the merge itself.
	 */
	allowAgentMerge: boolean;
	/** Require the run's quality gate to be green before an agent may merge. */
	requireGreenGate: boolean;
	/** Require a recorded human approval before an agent may merge. */
	requireHumanApproval: boolean;
	/** Merge strategies an agent may use. An empty list refuses every merge. */
	allowedMergeMethods: MergeMethod[];
	/**
	 * Branch names an agent may never merge INTO, matched case-insensitively
	 * against the pull request's base branch (a leading `refs/heads/` is
	 * stripped before comparison).
	 */
	protectedBranches: string[];
}

/**
 * The scopes a policy can be stored at, from least to most specific. The
 * most specific scope that declares a field wins for THAT field
 * (see {@link MERGE_POLICY_SCOPE_PRECEDENCE}).
 */
export type MergePolicyScope = 'tenant' | 'organization' | 'work' | 'agent';

/**
 * Documented precedence, least specific first:
 *
 *   platform default  <  tenant  <  organization  <  Work  <  Agent
 *
 * Resolution is FIELD-BY-FIELD (a deep merge, not a whole-object override):
 * a Work that sets only `allowAgentMerge` inherits the other four fields from
 * its organization / tenant / the platform default. `null` or an omitted key
 * at any scope means "inherit", never "false".
 */
export const MERGE_POLICY_SCOPE_PRECEDENCE: readonly MergePolicyScope[] = ['tenant', 'organization', 'work', 'agent'];

/**
 * What a scope actually stores: a PARTIAL policy. Absent/`null` fields
 * inherit from the next-least-specific scope. This is the shape of the
 * additive `mergePolicy` `simple-json` column on `tenants`, `organizations`,
 * `works` and `agents`.
 */
export type MergePolicyOverride = Partial<MergePolicy>;

/**
 * Which scope a resolved policy (or one of its fields) came from. `'default'`
 * means no scope in the chain declared it and the platform default applies.
 */
export type MergePolicySource = MergePolicyScope | 'default';

/**
 * The platform DEFAULT — deliberately conservative, and deliberately NOT a
 * hardcode: every field is overridable at any of the four scopes. An operator
 * who wants agents to land their own green work sets
 * `{ allowAgentMerge: true, requireHumanApproval: false }` at the scope of
 * their choosing.
 */
export const PLATFORM_DEFAULT_MERGE_POLICY: MergePolicy = Object.freeze({
	allowAgentMerge: false,
	requireGreenGate: true,
	requireHumanApproval: true,
	allowedMergeMethods: ['squash'],
	protectedBranches: ['main', 'master', 'develop', 'stage']
}) as MergePolicy;

/** Every field name of {@link MergePolicy}; the deep-merge iterates this. */
export const MERGE_POLICY_FIELDS: readonly (keyof MergePolicy)[] = [
	'allowAgentMerge',
	'requireGreenGate',
	'requireHumanApproval',
	'allowedMergeMethods',
	'protectedBranches'
];

/** One link of the resolution chain, reported so a preview can explain itself. */
export interface MergePolicyChainEntry {
	/** The scope this link represents (`'default'` is always the first link). */
	scope: MergePolicySource;
	/** Row id of the scope entity; `null` for the platform default. */
	id: string | null;
	/**
	 * Fields this link CONTRIBUTED to the final policy — i.e. it declared them
	 * and no more specific link overrode them. An empty array means the link
	 * exists in the ancestry but was fully shadowed (or declared nothing).
	 */
	fields: (keyof MergePolicy)[];
}

/** Result of one policy resolution. */
export interface ResolvedMergePolicy {
	/** The complete, effective policy. */
	policy: MergePolicy;
	/**
	 * The MOST SPECIFIC scope that contributed at least one field, or
	 * `'default'` when nothing in the chain declared anything.
	 */
	source: MergePolicySource;
	/** Least → most specific, starting at the platform default. */
	chain: MergePolicyChainEntry[];
}

/**
 * Stable refusal codes from the single decision point. Kept machine-readable
 * so callers (facade, worker, UI) can branch without string-matching prose.
 */
export type MergeRefusalCode =
	| 'agent-merge-disabled'
	| 'protected-branch'
	| 'target-branch-unknown'
	| 'merge-method-not-allowed'
	| 'gate-not-green'
	| 'human-approval-required';

/** Outcome of the single decision point (`canAgentMerge`). */
export interface MergeDecision {
	allowed: boolean;
	/** Human-readable explanation; present only when `allowed === false`. */
	reason?: string;
	/** Machine-readable counterpart of `reason`. */
	code?: MergeRefusalCode;
	/** The policy the decision was made against, and where it came from. */
	source?: MergePolicySource;
}
