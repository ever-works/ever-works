/**
 * App Works — the numeric limits and closed reason-code sets that more than one
 * epic reads.
 *
 * Owning epic: **APW-01 / APW-03** (CONTRACTS.md §2A, last row: "One
 * repository-size limits source").
 *
 * Spec: the per-stage repository limits are CONTRACTS.md:336 — private copy
 * ≤ 500 MB with no LFS (APW-01 FR-20), provisioning checkout ≤ 3 GiB (APW-04
 * FR-15), the build and Fleet/sandbox checkout limits, and whether LFS is
 * fetched. `POST /api/works/app-source/inspect` reports **which stage would
 * refuse a repository first**, and every epic reads THIS file instead of
 * restating a number (APW-08 FR-72).
 *
 * Why one file: the same repository size is checked at four points — the
 * private copy, the provisioner's checkout, the build runner's checkout and the
 * evolve loop's Fleet/sandbox checkout — and four hand-written copies of a
 * number drift the first time one of them changes. A repository that passes one
 * stage and fails the next is a support ticket nobody can explain.
 *
 * What is deliberately NOT here: the caps of §7A that another epic owns
 * (builds, provisions, deploys, upstream PRs, mail) live with their owner, and a
 * value declared twice would be ambiguous in the apps barrel — the exact
 * failure `src/__tests__/index.barrel.spec.ts` exists to catch.
 */

import { APP_PRIVATE_COPY_MAX_SIZE_KB } from './app-source.js';

// ---------------------------------------------------------------------------
// Stages (CONTRACTS.md:336)
// ---------------------------------------------------------------------------

/**
 * The stages a repository is read at, in pipeline order.
 *
 * The order is the point: inspect reports the FIRST stage that would refuse, so
 * a member is told about the earliest gate rather than a later one.
 */
export const APP_REPOSITORY_STAGES = ['private-copy', 'provisioning', 'build', 'sandbox'] as const;

/** Union derived from {@link APP_REPOSITORY_STAGES}. */
export type AppRepositoryStage = (typeof APP_REPOSITORY_STAGES)[number];

/**
 * The codes a stage refuses with.
 *
 * The first two are APW-01's own reason codes (FR-20, and they are members of
 * `APP_SOURCE_REASON_CODES`); `repository-too-large` is APW-04's failure reason
 * (spec.md:234, plan.md:229, spec.md:492) and is spelled exactly as APW-04
 * writes it.
 */
export const APP_REPOSITORY_STAGE_REFUSAL_CODES = [
	'too_large_for_private_copy',
	'uses_lfs',
	'repository-too-large'
] as const;

/** Union derived from {@link APP_REPOSITORY_STAGE_REFUSAL_CODES}. */
export type AppRepositoryStageRefusalCode = (typeof APP_REPOSITORY_STAGE_REFUSAL_CODES)[number];

/**
 * What one stage allows.
 *
 * A field is **absent** when no spec states its value — never guessed. Today
 * that is `maxSizeKb` for `build` and `sandbox` and `fetchesLfs` for everything
 * but the private copy; {@link APP_REPOSITORY_STAGES_WITHOUT_SPEC_LIMIT} names
 * the gaps and a spec test pins them, so the day a number is written down the
 * test fails until it is entered here.
 */
export interface AppRepositoryStageLimit {
	/** The largest repository this stage will read, in KB as the provider reports it. */
	maxSizeKb?: number;
	/** Whether this stage carries Git LFS content (`false` = it refuses or skips LFS). */
	fetchesLfs?: boolean;
	/** Every code this stage may refuse with, in the order it checks them. */
	refusalCodes: readonly AppRepositoryStageRefusalCode[];
}

/**
 * The per-stage limits (CONTRACTS.md:336).
 *
 * `'private-copy'` imports APW-01's constant rather than repeating 512 000, and
 * `provisioning` is APW-04 FR-15's 3 GiB written as its own arithmetic so the
 * unit is unambiguous — GitHub reports `size` in KB, so 3 GiB is 3 × 1024 × 1024
 * KB.
 */
export const APP_REPOSITORY_STAGE_LIMITS: Readonly<Record<AppRepositoryStage, AppRepositoryStageLimit>> = {
	'private-copy': {
		maxSizeKb: APP_PRIVATE_COPY_MAX_SIZE_KB,
		fetchesLfs: false,
		refusalCodes: ['too_large_for_private_copy', 'uses_lfs']
	},
	provisioning: {
		maxSizeKb: 3 * 1024 * 1024,
		refusalCodes: ['repository-too-large']
	},
	build: {
		refusalCodes: []
	},
	sandbox: {
		refusalCodes: []
	}
};

/**
 * The stages whose size limit no spec states yet (CONTRACTS.md:336 names the
 * stages, not their numbers).
 *
 * A named placeholder, not a guess: the entry stays empty and this list records
 * WHY, so nobody fills it in from intuition. APW-05 owns the build checkout
 * limit and APW-08 FR-72 the Fleet/sandbox one.
 */
export const APP_REPOSITORY_STAGES_WITHOUT_SPEC_LIMIT: readonly AppRepositoryStage[] = ['build', 'sandbox'];

/**
 * Which stage would refuse a repository first, or `null` when none of the
 * stages in its path has a limit that refuses it (CONTRACTS.md:336).
 *
 * `stages` defaults to the whole pipeline; a caller that knows the relation
 * passes the stages the repository will actually traverse — a linked repository
 * is never copied, so the private-copy ceiling does not apply to it.
 *
 * Fails closed in two ways. An LFS repository is refused at the private-copy
 * stage (APW-01 FR-20). An **unmeasurable** size — absent, `NaN`, negative or
 * infinite — is refused at the first stage in the path that has a limit, because
 * "we could not measure it" must never be reported as "it fits".
 */
export function firstRefusingRepositoryStage(input: {
	sizeKb?: number | null;
	usesLfs?: boolean;
	stages?: readonly AppRepositoryStage[];
}): AppRepositoryStage | null {
	const stages = input.stages ?? APP_REPOSITORY_STAGES;
	const sizeKnown = typeof input.sizeKb === 'number' && Number.isFinite(input.sizeKb) && input.sizeKb >= 0;

	for (const stage of stages) {
		const limit = APP_REPOSITORY_STAGE_LIMITS[stage];
		if (stage === 'private-copy' && input.usesLfs === true) {
			return stage;
		}
		if (limit.maxSizeKb === undefined) {
			continue;
		}
		if (!sizeKnown || (input.sizeKb as number) > limit.maxSizeKb) {
			return stage;
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Quotas and caps (CONTRACTS.md §7A, resolution R-31)
// ---------------------------------------------------------------------------

/**
 * The two scopes every §7A cap is measured at (CONTRACTS.md:651 — "`member` and
 * `org` are the two scopes"; the table headers spell the second one out in
 * full).
 */
export const APP_QUOTA_SCOPES = ['member', 'org'] as const;

/** Union derived from {@link APP_QUOTA_SCOPES}. */
export type AppQuotaScope = (typeof APP_QUOTA_SCOPES)[number];

/**
 * APW-01's three caps from §7A, with the environment override that raises each
 * one (CONTRACTS.md:658-660).
 *
 * Defaults are deliberately generous and raising one is an operator action, no
 * redeploy (R-31). Filling a cap is a refusal with copy — never a silent drop
 * and never a deletion to make room.
 */
export const APP_WORK_QUOTA_CAPS = {
	/** Active App Works per member / organization (CONTRACTS.md:658). */
	activeAppWorks: { member: 25, org: 200, env: 'EVER_WORKS_APPS_MAX_ACTIVE' },
	/** Creates per day (CONTRACTS.md:659). */
	createsPerDay: { member: 20, org: 100, env: 'EVER_WORKS_APPS_MAX_CREATES_PER_DAY' },
	/** Private copies held, each already bounded by the 500 MB of APW-01 FR-20 (CONTRACTS.md:660). */
	privateCopies: { member: 10, org: 50, env: 'EVER_WORKS_APPS_MAX_PRIVATE_COPIES' }
} as const;

/** The key of one §7A cap APW-01 owns. */
export type AppWorkQuotaCapKey = keyof typeof APP_WORK_QUOTA_CAPS;

/**
 * Whether one more item fits under a cap that currently holds `currentCount`.
 *
 * A cap of 25 admits exactly 25, so the check is `currentCount < cap`. Fails
 * closed on a cap that is not a positive number: an unreadable cap refuses
 * rather than admitting without limit.
 */
export function appWorkQuotaAllows(cap: number, currentCount: number): boolean {
	return Number.isFinite(cap) && cap > 0 && Number.isFinite(currentCount) && currentCount < cap;
}
