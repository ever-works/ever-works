/**
 * APW-05 T9 — is the tracked branch protected? (plan §4.6 step 1, `APW05-G16`)
 *
 * Two reads, because one is not enough: the classic endpoint
 * `GET /repos/{o}/{r}/branches/{branch}/protection` answers **404** for a branch
 * that is protected only by a **ruleset**, so a plugin that trusted it alone would
 * commit straight into a protected branch. The rules read
 * (`GET /repos/{o}/{r}/rules/branches/{branch}`, paginated, read access only)
 * closes that hole.
 *
 * The verdict carries **which read decided it**, because "protected" is not a
 * boolean anyone can act on: a 403 is treated as protected *without* knowing why
 * (the token cannot see the rules), and the delivery rules of plan §4.6 step 2
 * then rely on `refRejectedByRule` as the fallback. That distinction is what the
 * T9 spec asserts, and it is the difference between a branch we know is protected
 * and one we merely cannot prove is open.
 *
 * Nothing here writes, and nothing here throws on a provider refusal: a 403 or a
 * 404 from either endpoint is an *answer* (the plan's own words: "A 403 or 404
 * from the rules endpoint means no rules are known locally; the refusal fallback
 * of step 2 covers that case").
 */

/** One endpoint's answer — a status and, when there is one, a body. A refusal is data, not an exception. */
export interface BranchProtectionResponse<T> {
	readonly ok: boolean;
	readonly status: number;
	readonly data?: T;
}

/** The fields of the classic protection payload this decision reads (plan §4.6 step 1). */
export interface BranchProtectionPayload {
	readonly required_pull_request_reviews?: unknown;
	readonly required_status_checks?: unknown;
}

/** One rule from `GET /rules/branches/{branch}` — the fields this decision reads. */
export interface BranchRulePayload {
	readonly type?: string;
	/** Present on some payloads; when it is, only `active` counts (plan §4.6 step 1). */
	readonly enforcement?: string;
}

/** The two reads the branch-rules decision needs, and nothing else. */
export interface BranchProtectionPort {
	readBranchProtection(input: {
		readonly owner: string;
		readonly repo: string;
		readonly branch: string;
	}): Promise<BranchProtectionResponse<BranchProtectionPayload>>;
	readBranchRules(input: {
		readonly owner: string;
		readonly repo: string;
		readonly branch: string;
		readonly page: number;
	}): Promise<BranchProtectionResponse<readonly BranchRulePayload[]>>;
}

/** Which read decided the verdict — the reason, not just the boolean. */
export type BranchProtectionDecision =
	| 'requiredPullRequestReviews'
	| 'requiredStatusChecks'
	| 'forbidden'
	| 'rulesetPullRequest'
	| 'rulesetStatusChecks'
	| 'none';

/** The decision and the read that produced it. */
export interface BranchProtectionVerdict {
	readonly protected: boolean;
	readonly decision: BranchProtectionDecision;
}

/** The branch coordinates both reads address. */
export interface BranchCoordinates {
	readonly owner: string;
	readonly repo: string;
	readonly branch: string;
}

/** Page size for the rules read — GitHub's maximum, so the pagination loop is as short as it can be. */
export const BRANCH_RULES_PAGE_SIZE = 100;

/**
 * How many rules pages are read before the loop stops.
 *
 * A bound, not a guess: an active `pull_request` or `required_status_checks` rule
 * is almost always on the first page, and a repository with more than a thousand
 * branch rules is not a case worth hanging a preparation job on. Reaching the cap
 * without a match answers `unprotected`, which the `refRejectedByRule` fallback
 * of §4.6 step 2 covers.
 */
export const BRANCH_RULES_MAX_PAGES = 10;

/** The two rule types plan §4.6 step 1 names. */
export const BRANCH_PROTECTION_RULE_TYPES = ['pull_request', 'required_status_checks'] as const;

function isActiveRule(rule: BranchRulePayload): boolean {
	// `/rules/branches/{branch}` returns the rules in force on the branch, so an
	// absent `enforcement` means "this endpoint already filtered them". When a
	// payload does carry one, only `active` protects.
	return rule.enforcement === undefined || rule.enforcement === 'active';
}

/**
 * Decide whether the tracked branch is protected (plan §4.6 step 1).
 *
 * Order, and why:
 *
 *   1. the classic endpoint — `403` is **protected** (we cannot see the rules, so
 *      we do not get to assume the branch is open); a `200` protects when either
 *      `required_pull_request_reviews` or `required_status_checks` is present;
 *   2. the rules endpoint — consulted on a `404` **and** on a `200` that carried
 *      neither field, because a ruleset can protect a branch the classic endpoint
 *      reports as unprotected.
 */
export async function isBranchProtected(
	port: BranchProtectionPort,
	coordinates: BranchCoordinates
): Promise<BranchProtectionVerdict> {
	const classic = await port.readBranchProtection(coordinates);
	if (!classic.ok && classic.status === 403) return { protected: true, decision: 'forbidden' };
	if (classic.ok) {
		if (
			classic.data?.required_pull_request_reviews !== undefined &&
			classic.data?.required_pull_request_reviews !== null
		) {
			return { protected: true, decision: 'requiredPullRequestReviews' };
		}
		if (classic.data?.required_status_checks !== undefined && classic.data?.required_status_checks !== null) {
			return { protected: true, decision: 'requiredStatusChecks' };
		}
	}

	for (let page = 1; page <= BRANCH_RULES_MAX_PAGES; page += 1) {
		const rules = await port.readBranchRules({ ...coordinates, page });
		// 403 or 404 → no rules are known locally; the caller's
		// `refRejectedByRule` fallback is what covers a rule we cannot read.
		if (!rules.ok) return { protected: false, decision: 'none' };
		const page1 = rules.data ?? [];
		for (const rule of page1) {
			if (!isActiveRule(rule)) continue;
			if (rule.type === 'pull_request') return { protected: true, decision: 'rulesetPullRequest' };
			if (rule.type === 'required_status_checks') return { protected: true, decision: 'rulesetStatusChecks' };
		}
		if (page1.length < BRANCH_RULES_PAGE_SIZE) break;
	}

	return { protected: false, decision: 'none' };
}
