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

/**
 * The protected-branch FLOOR (works-security lane 3a, 2026-10-18).
 *
 * A scope may still list `protectedBranches: []` — the resolution is
 * field-by-field and an explicit empty list keeps meaning "protect nothing"
 * for every OTHER branch. What it can no longer do is make an agent merge
 * into one of these branches happen unattended:
 *
 *   - `main` and `master` ({@link MERGE_POLICY_ALWAYS_APPROVED_BRANCHES}):
 *     ALWAYS need a recorded human approval, whatever any scope says;
 *   - `develop` and `stage`: need one UNLESS a human-set TENANT or
 *     ORGANIZATION policy explicitly turned approval off
 *     (`requireHumanApproval: false` at that scope, and the effective policy
 *     says the same). A Work- or Agent-level loosening never lifts it: those
 *     are the scopes a machine principal could ever write;
 *   - a base nobody can name: always, as the worst case.
 *
 * Listed in `protectedBranches`, a floor branch stays refused outright, as
 * before. Why approval-required rather than an absolute refusal: the release
 * promotion lane merges INTO `stage` and `main` (always with a recorded
 * approval), and refusing those outright would remove it.
 */
export const MERGE_POLICY_PROTECTED_BRANCH_FLOOR: readonly string[] = Object.freeze([
	'main',
	'master',
	'develop',
	'stage'
]);

/** The floor branches no scope can ever waive: `main` and `master`. */
export const MERGE_POLICY_ALWAYS_APPROVED_BRANCHES: readonly string[] = Object.freeze(['main', 'master']);

function normalizeFloorRef(ref: string | null | undefined): string | null {
	if (typeof ref !== 'string') return null;
	const normalized = ref
		.trim()
		.replace(/^refs\/heads\//i, '')
		.toLowerCase();
	return normalized || null;
}

/**
 * Whether a merge into `ref` needs a recorded human approval because of the
 * {@link MERGE_POLICY_PROTECTED_BRANCH_FLOOR}. An unknown or blank base
 * answers `true`. `refs/heads/` is stripped and the comparison is
 * case-insensitive, the same normalisation the protected-branch rule uses.
 *
 * `humanScopeWaivesApproval` is {@link ResolvedMergePolicy.humanScopeWaivesApproval}:
 * true only when a tenant or organization policy explicitly turned approval
 * off. It lifts the floor for `develop` / `stage`, never for `main` / `master`.
 */
export function mergeTargetNeedsFloorApproval(
	ref: string | null | undefined,
	opts: { humanScopeWaivesApproval?: boolean } = {}
): boolean {
	const normalized = normalizeFloorRef(ref);
	if (!normalized) return true;
	if (MERGE_POLICY_ALWAYS_APPROVED_BRANCHES.includes(normalized)) return true;
	if (!MERGE_POLICY_PROTECTED_BRANCH_FLOOR.includes(normalized)) return false;
	return opts.humanScopeWaivesApproval !== true;
}

/** Two branch refs name the same branch (`refs/heads/` stripped, case-insensitive). */
export function sameMergeBranch(a: string | null | undefined, b: string | null | undefined): boolean {
	const left = normalizeFloorRef(a);
	return left !== null && left === normalizeFloorRef(b);
}

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
	/**
	 * Works-security lane 3a — true only when the most specific TENANT or
	 * ORGANIZATION layer that declares `requireHumanApproval` declares `false`
	 * AND the effective policy is `false` too. Those are the scopes only a
	 * person can write; it lifts the protected-branch floor for `develop` /
	 * `stage` (never for `main` / `master`, see
	 * {@link mergeTargetNeedsFloorApproval}). Absent = false (fail closed).
	 */
	humanScopeWaivesApproval?: boolean;
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
	| 'human-approval-required'
	// ── Merge approval (self-build slice AE, EW-805) ──────────────────
	// `human-approval-required` above is the POLICY refusal: the policy
	// wants an approval and the merge path could not produce one. The
	// codes below are the APPROVAL refusals — the merge path looked, and
	// says precisely what it found instead. They are separate values on
	// purpose: "nobody approved this" and "somebody approved a commit
	// that is no longer the head" are the same policy outcome and
	// completely different things for the human reading the refusal.
	/** No recorded approval names this pull request at all. */
	| 'approval-missing'
	/** An approval exists for this pull request, but for an EARLIER head commit. */
	| 'approval-stale'
	/** A matching approval exists but is older than `MERGE_APPROVAL_MAX_AGE_MS`. */
	| 'approval-expired'
	/** The recorded decision was not made by a human (guardrail / no decider). */
	| 'approval-not-human'
	/** The approver is not entitled to approve for this Task's scope. */
	| 'approver-not-entitled'
	/** The pull request is draft/closed/merged at merge time. */
	| 'pull-request-not-open'
	/** Provider CI is not green at merge time (it may have been at approval time). */
	| 'pull-request-not-green'
	/** The live head commit could not be read, so nothing can be pinned to it. */
	| 'head-sha-unknown'
	/**
	 * Works-security lane 3a — the pull request's LIVE base (read from the
	 * provider) is not the branch the caller planned to merge into: the PR was
	 * retargeted. The live base is authoritative; the merge is refused.
	 */
	| 'target-branch-mismatch';

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
