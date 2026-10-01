/**
 * App Works — the App Provisioner's shared contract surface.
 *
 * Owning epic: **APW-04** (App Provisioner), task `tasks.md` T6:127-143.
 *
 * Plan: `docs/specs/features/app-works/APW-04-app-provisioner/plan.md` §3.2
 * (`plan.md:400-726`) is the normative module — every union, alias, interface,
 * limit, path list and `*_I18N_KEY` map below is that section, verbatim and in
 * the order it states them. Spec: `…/spec.md` §5.3 (the state machine), §6 (the
 * copy of record), §4.9 (cost caps and concurrency), §4.11 (the card).
 *
 * Re-exported from `packages/contracts/src/apps/index.ts`, the programme's
 * single shared-types folder (Resolution R-1: there is no `src/app-works/`).
 *
 * ## Why the views are here and not in the controller
 *
 * `AppProvisioningResponse` is what `GET /api/works/:id/provisioning` returns
 * (plan §4:768-790) and it is ONE place on purpose: the controller maps the
 * row to it, T23 asserts the wire key set equals it, and T25 renders the card
 * from it alone. Every date in it is an **ISO string**, never a `Date` — the
 * conversion happens at the controller boundary, so nothing about the driver,
 * the entity or the timezone leaks into the web.
 *
 * ## What is deliberately absent from the views
 *
 * Plan §3.2:702-708 lists the columns the response must NEVER carry:
 * `userId`, `tenantId`, `organizationId`, `agentId`, `note`, `lease`,
 * `leaseExpiresAt`, `suggestionBundle`, `suggestionUpstream`, `conversationId`,
 * `chatMessagesPosted`, `activeMs`, `openInboxItemId` (except as
 * `question.inboxItemId`, returned only to the question's recipient),
 * `verificationNamespace`, `verificationExpiresAt`, `baseSha`, `lastRunOutput`,
 * `upstreamFromSha` / `upstreamToSha` (surfaced only through
 * `upstreamSmokeBroken`), and `attempts[].fingerprint` / `attempts[].commentId`.
 * Those columns exist on the entity (T7) and are read by the service; their
 * absence here is the contract, not an omission.
 *
 * ## Two additive corrections to plan §3.2, and why neither narrows anything
 *
 * Both are **appends**; every member, value and name the plan states is
 * unchanged (CONTRACTS R-26, the owner's additive-only rule).
 *
 * 1. `APP_PROVISIONING_FAILURE_REASONS` gains `private-repository` as its
 *    eleventh member. §3.2:426-437 lists ten, but the very next block —
 *    `APP_PROVISIONING_FAILURE_REASON_I18N_KEY` (`:674-686`) — carries
 *    `'private-repository': 'privateRepository'` and is declared
 *    `satisfies Record<AppProvisioningFailureReason, string>`, so the ten-member
 *    union does not even compile against its own map. T6:140 requires
 *    "`private-repository` in the failure reasons" by name, §9:1229-1230
 *    declares the `headline.privateRepository` and `reason.privateRepository`
 *    leaves, and spec §6:488,497 publishes the copy. The member is therefore
 *    appended, and the map keeps the eleven entries §3.2 already spells.
 * 2. `APP_PROVISIONING_OPTION_I18N_KEY` gains
 *    `'retry-after-setting': 'retryAfterSetting'` as an eighth entry. §3.2:691-699
 *    lists seven; §9:1241 states "**8 keys** — one per
 *    `APP_PROVISIONING_OPTION_I18N_KEY` leaf: retry, optional, verifyOnCluster,
 *    acceptBuildOnly, raiseCap, choose, stop, **retryAfterSetting**", spec
 *    §6:532 publishes that option's copy (`I set it on the App env page — try
 *    again`), and T49 requires every option id to have a map entry. The seven
 *    §3.2 keys keep their exact spelling, values and order; the eighth is
 *    appended.
 */

// ---------------------------------------------------------------------------
// Closed unions (plan §3.2:406-463)
// ---------------------------------------------------------------------------

/** The seven states of a provisioning row (spec §5.3:429-453, plan §3.1:358). */
export const APP_PROVISIONING_STATUSES = [
	'queued',
	'running',
	'needs_input',
	'succeeded',
	'merged',
	'failed',
	'cancelled'
] as const;

/** The eight ordered steps of §2.5 — `stepStates` is keyed by exactly these (plan §3.1:360). */
export const APP_PROVISIONING_STEPS = [
	'repository',
	'analysis',
	'proposal',
	'validate',
	'build',
	'boot',
	'smoke',
	'evidence'
] as const;

/** The six states one step can be in (§2.5's outcome table, plan §3.1:361). */
export const APP_PROVISIONING_STEP_STATES = ['pending', 'running', 'passed', 'failed', 'blocked', 'skipped'] as const;

/** The closed set of terminal failure reasons (spec §5.3, plan §3.1:364). */
export const APP_PROVISIONING_FAILURE_REASONS = [
	'no-isolated-runtime',
	'repository-not-ready',
	'repository-too-large',
	'not-runnable',
	'token-cap',
	'runner-minute-cap',
	'deadline',
	'could-not-verify',
	'no-answer',
	'verification-infrastructure',
	// Appended — see the module docstring's correction 1.
	'private-repository'
] as const;

/** Why the Provisioner asks a human (spec §4.8, FR-37). */
export const APP_PROVISIONING_QUESTION_REASONS = [
	'attempts-spent',
	'repeated-failure',
	'missing-required-value',
	'runner-capacity',
	'token-cap',
	'runner-minute-cap',
	'multiple-apps',
	'agent-asked',
	'safety-rail' // R-17: a rail refused or held an action (grants, ladder, caps, rules)
] as const;

/** R-17 waits: a parked run consumes no attempt and no active time. */
export const APP_PROVISIONING_PARK_REASONS = [
	'kill-switch',
	'agent-paused',
	'workspace-paused',
	'scope-paused'
] as const;

/** How the repository's runnability was detected (R-13, plan §3.1:362). */
export const APP_PROVISIONING_DETECTION_SOURCES = [
	'app-spec',
	'compose',
	'dockerfile',
	'helm',
	'descriptor-hint',
	'auto' // R-13 zero-config build; the builder is the build plugin's choice
] as const;

// ---------------------------------------------------------------------------
// The attempt record (plan §3.2:465-480)
// ---------------------------------------------------------------------------

/**
 * One verification attempt, as stored in `attempts` (`simple-json`, ≤ 9).
 *
 * `fingerprint` is the sha256 of the normalised failure and `commentId` the
 * evidence comment; both are stored and **both are withheld from the views**
 * (plan §3.2:707-708) — they are the loop detector's and the upserter's keys,
 * not the card's.
 */
export interface AppProvisioningAttempt {
	n: number;
	startedAt: string;
	finishedAt?: string;
	verdict: 'green' | 'red' | 'infra' | 'blocked' | 'running';
	failedStep?: (typeof APP_PROVISIONING_STEPS)[number];
	fingerprint?: string; // sha256 of normalised failure (loop-detector normalisation)
	targetKind?: 'cluster' | 'runner';
	buildId?: string;
	imageDigest?: string;
	logsUrl?: string;
	smoke?: Array<{ name: string; expected: string; observed: string; ms: number; ok: boolean }>; // ≤ 40
	commentId?: number;
	tokens: number;
	runnerMinutes: number;
}

// ---------------------------------------------------------------------------
// The numbers (plan §3.2:482-539)
// ---------------------------------------------------------------------------

/**
 * Every numeric limit of the epic, in one frozen object.
 *
 * A limit cannot change without a deliberate edit to this file AND to
 * `packages/contracts/src/apps/__tests__/app-provisioning.spec.ts`, which pins
 * all of them by value (T6:140-141 calls `startDedupeMs` out by name: two
 * starts of the same App Work inside that window yield ONE row, plan §4
 * "Start semantics").
 */
export const APP_PROVISION_LIMITS = {
	attemptsDefault: 3,
	attemptsMin: 1,
	attemptsMax: 5,
	attemptsPerAnswer: 2,
	questionsMax: 3,
	attemptsCeiling: 9,
	optionsMax: 4,
	tokenCapDefault: 3_000_000,
	tokenCapMin: 500_000,
	tokenCapMax: 10_000_000,
	runnerMinuteCapDefault: 240,
	runnerMinuteCapMin: 60,
	runnerMinuteCapMax: 600,
	/** Two starts of the same App Work inside this window yield one row (§4 "Start semantics"). */
	startDedupeMs: 10_000,
	analysisRunMs: 45 * 60_000,
	iterateRunMs: 30 * 60_000,
	forkWaitMs: 30 * 60_000,
	activeDeadlineMs: 8 * 3_600_000,
	/**
	 * Verification-Build reservation: `min(headSpec.build.resources.timeoutMinutes, buildMinutesMax)
	 * + runnerBootMinutesMax` — 90 minutes at the defaults, and the number §6.4 compares against the cap.
	 */
	buildMinutesMax: 60,
	jobSecondsMax: 900,
	startupSecondsMax: 900,
	smokeRequestMs: 30_000,
	smokeTotalMs: 300_000,
	runnerBootMinutesMax: 30,
	runnerBootMemoryGiB: 12,
	buildMemoryGiBMax: 14,
	namespaceTtlMinutes: 90,
	repoMaxBytes: 3 * 1024 ** 3,
	diffMaxFiles: 12,
	diffMaxLines: 3_000,
	fileMaxBytes: 128 * 1024,
	outputMaxBytes: 512 * 1024,
	reportMaxChars: 40_000,
	instructionFileMaxBytes: 32 * 1024,
	logTailLines: 200,
	logTailBytes: 16 * 1024,
	evidenceCommentMaxChars: 60_000,
	chatMessagesMax: 12,
	questionReminderMs: 72 * 3_600_000,
	questionExpiryMs: 14 * 86_400_000,
	activePerUser: 3,
	activePerOrg: 10,
	startsPerHour: 10,
	pollMs: 5_000,
	infraRetries: 3,
	infraRetryWindowMs: 30 * 60_000,
	suggestionsPer30Days: 5,
	autoReprovisionPerSync: 1,
	autoReprovisionPer7Days: 2,
	clusterProbeMs: 10_000,
	podPendingInfraMs: 10 * 60_000
} as const;

// ---------------------------------------------------------------------------
// The two guard lists (plan §3.2:541-550)
// ---------------------------------------------------------------------------

/**
 * The ONLY paths the Provisioner's pull request may change (spec §4.5, FR-25).
 *
 * `packages/agent`'s output guard (T10) refuses `pathNotWritable` for anything
 * outside these two entries; `.works/works.yml` is the App spec itself and
 * `.works/overlay/**` the Blueprint overlay directory APW-03 applies.
 */
export const APP_PROVISION_WRITABLE_PATHS = ['.works/works.yml', '.works/overlay/**'] as const;

/**
 * The App spec fields the platform owns; a proposal that changes one fails the
 * guard with `preservedFieldChanged` (plan §7.6, spec §4.10).
 *
 * These are exactly the keys APW-03's last-valid-applied spec (the guard's
 * `baseSpecYaml`, plan §3.2:710-717) is compared against — never the raw head
 * file, so a pre-seeded `upstreamPullRequests.requireApproval: false` on the
 * head is not inherited (ACC-NEG-05).
 */
export const APP_PROVISION_PRESERVED_SPEC_FIELDS = [
	'source',
	'blueprint',
	'license',
	'display.protectedPaths',
	'upstreamSync',
	'upstreamPullRequests',
	'provisioning'
] as const;

// ---------------------------------------------------------------------------
// Singular aliases (plan §3.2:552-560)
// ---------------------------------------------------------------------------

/** Singular aliases of the lists above — the names the views below (and every other epic) read. */
export type AppProvisioningStatus = (typeof APP_PROVISIONING_STATUSES)[number];
export type AppProvisioningStep = (typeof APP_PROVISIONING_STEPS)[number];
export type AppProvisioningStepState = (typeof APP_PROVISIONING_STEP_STATES)[number];
export type AppProvisioningFailureReason = (typeof APP_PROVISIONING_FAILURE_REASONS)[number];
export type AppProvisioningQuestionReason = (typeof APP_PROVISIONING_QUESTION_REASONS)[number];
export type AppProvisioningParkReason = (typeof APP_PROVISIONING_PARK_REASONS)[number];
export type AppProvisioningDetectionSource = (typeof APP_PROVISIONING_DETECTION_SOURCES)[number];

/** What started a provisioning. `upstream-smoke` is manual, `auto-upstream-smoke` is not (APW-02 §8). */
export type AppProvisioningTrigger = 'auto-create' | 'manual' | 'chat' | 'upstream-smoke' | 'auto-upstream-smoke';

// ---------------------------------------------------------------------------
// The views (plan §3.2:562-655)
// ---------------------------------------------------------------------------

/** One step of the eight, as the card draws it (§2.5). */
export interface AppProvisioningStepView {
	state: AppProvisioningStepState;
	startedAt: string | null;
	finishedAt: string | null;
	/** i18n leaf under `dashboard.workDetail.appProvisioning.stepNote` (e.g. `waitPlatform`). */
	noteKey: string | null;
	noteParams: Record<string, string | number> | null;
}

/** One attempt, with the two internal keys dropped (see the module docstring). */
export interface AppProvisioningAttemptView {
	n: number;
	startedAt: string;
	finishedAt: string | null;
	verdict: AppProvisioningAttempt['verdict'];
	failedStep: AppProvisioningStep | null;
	targetKind: 'cluster' | 'runner' | null;
	buildId: string | null;
	imageDigest: string | null;
	logsUrl: string | null;
	smoke: AppProvisioningAttempt['smoke'] | null;
	tokens: number;
	runnerMinutes: number;
}

/** The open question, or the shape it would take — names and numbers only, never a value (§3.1). */
export interface AppProvisioningQuestionView {
	reason: AppProvisioningQuestionReason;
	/** names only: variable, step, attempts, candidates, reasonCode (never a value, §3.1). */
	params: Record<string, string | number>;
	askedAt: string;
	/** the Inbox item id — returned to the question's recipient only (§4). */
	inboxItemId: string | null;
}

/** §4's GET body — one place defines the shape the API, the card and the receipts all read. */
export interface AppProvisioningView {
	id: string;
	workId: string;
	taskId: string | null;
	trigger: AppProvisioningTrigger;
	status: AppProvisioningStatus;
	queuedReason: 'user-limit' | 'org-limit' | null;
	step: AppProvisioningStep;
	stepStates: Record<AppProvisioningStep, AppProvisioningStepView>;
	parkedReason: AppProvisioningParkReason | null;
	detectionSource: AppProvisioningDetectionSource | null;
	attemptBudget: number;
	attemptsUsed: number;
	attempts: AppProvisioningAttemptView[];
	question: AppProvisioningQuestionView | null;
	failureReason: AppProvisioningFailureReason | null;
	verified: boolean | null;
	pullRequest: { number: number; url: string } | null;
	headSha: string | null;
	spend: { tokensUsed: number; tokenCap: number; runnerMinutesUsed: number; runnerMinuteCap: number };
	runIds: string[];
	buildIds: string[];
	verificationTargetKind: 'cluster' | 'runner' | null;
	suggestionState: string | null;
	suggestedAt: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** The `recent` rows (≤ 10) — deliberately a `Pick`, so a key added to the full view is a compile error here. */
export type AppProvisioningSummaryView = Pick<
	AppProvisioningView,
	| 'id'
	| 'trigger'
	| 'status'
	| 'failureReason'
	| 'verified'
	| 'pullRequest'
	| 'attemptsUsed'
	| 'attemptBudget'
	| 'spend'
	| 'startedAt'
	| 'finishedAt'
>;

/** The five flags the start path checks before it writes anything (plan §4 "Start semantics"). */
export interface AppProvisioningReadiness {
	isolatedRuntime: boolean;
	agentTemplate: boolean;
	buildCapability: boolean;
	clusterTarget: boolean;
	/** private copy or linked private/internal repository → false in Wave 1 P1 (§2.2, FR-63). */
	publicRepository: boolean;
}

/** The whole `GET /api/works/:id/provisioning` body (plan §4:771). */
export interface AppProvisioningResponse {
	active: AppProvisioningView | null;
	/** newest terminal row — drives the Succeeded / Merged / Failed / Cancelled headlines. */
	latest: AppProvisioningView | null;
	recent: AppProvisioningSummaryView[]; // ≤ 10
	readiness: AppProvisioningReadiness;
	upstreamSmokeBroken: { fromSha: string; toSha: string } | null;
	suggestionEligible: boolean;
	/** the caller may start, cancel or suggest (FR-56); false for a viewer (ACC-04-32). */
	canEdit: boolean;
}

/** The `POST /api/works/:id/provision` body (plan §4:770). */
export interface AppProvisioningStartResponse {
	provisioningId: string;
	status: AppProvisioningStatus;
	/** `true` when the row returned is the one an earlier start inside `startDedupeMs` created. */
	deduplicated: boolean;
}

// ---------------------------------------------------------------------------
// The id → i18n-leaf maps (plan §3.2:657-699)
// ---------------------------------------------------------------------------

/**
 * Reason and option ids are machine tokens; these maps turn each one into the
 * camelCase i18n leaf §9 declares, so no id is ever composed into a key. Same
 * shape as `ACTION_CATEGORY_I18N_KEY` (`packages/contracts/src/safety/action-category.types.ts`).
 * `choose:<n>` resolves by its `choose` prefix, with `n` as a param.
 *
 * Every leaf is `^[a-z][a-zA-Z0-9]*$` — no dash, no dot — which is what T49's
 * equality test against `app-provisioning-copy.ts` asserts in both directions.
 */
export const APP_PROVISIONING_QUESTION_REASON_I18N_KEY = {
	'attempts-spent': 'attemptsSpent',
	'repeated-failure': 'repeatedFailure',
	'missing-required-value': 'missingRequiredValue',
	'runner-capacity': 'runnerCapacity',
	'token-cap': 'tokenCap',
	'runner-minute-cap': 'runnerMinuteCap',
	'multiple-apps': 'multipleApps',
	'agent-asked': 'agentAsked',
	'safety-rail': 'safetyRail'
} as const satisfies Record<AppProvisioningQuestionReason, string>;

export const APP_PROVISIONING_FAILURE_REASON_I18N_KEY = {
	'no-isolated-runtime': 'noIsolatedRuntime',
	'repository-not-ready': 'repositoryNotReady',
	'repository-too-large': 'repositoryTooLarge',
	'not-runnable': 'notRunnable',
	'token-cap': 'tokenCap',
	'runner-minute-cap': 'runnerMinuteCap',
	deadline: 'deadline',
	'could-not-verify': 'couldNotVerify',
	'no-answer': 'noAnswer',
	'verification-infrastructure': 'verificationInfrastructure',
	'private-repository': 'privateRepository'
} as const satisfies Record<AppProvisioningFailureReason, string>;

export const APP_PROVISIONING_QUEUED_REASON_I18N_KEY = {
	'user-limit': 'userLimit',
	'org-limit': 'orgLimit'
} as const;

/**
 * The chat/question option ids and their leaves.
 *
 * §3.2:691-699 lists the first seven; `retry-after-setting` is the appended
 * eighth — see the module docstring's correction 2. `choose` is the prefix of
 * `choose:<n>`, resolved with `n` as a param.
 */
export const APP_PROVISIONING_OPTION_I18N_KEY = {
	retry: 'retry',
	optional: 'optional',
	'verify-on-cluster': 'verifyOnCluster',
	'accept-build-only': 'acceptBuildOnly',
	'raise-cap': 'raiseCap',
	choose: 'choose',
	stop: 'stop',
	'retry-after-setting': 'retryAfterSetting'
} as const;

/** The option ids, as a union — `choose:<n>` is NOT a member: it resolves through its prefix. */
export type AppProvisioningOptionId = keyof typeof APP_PROVISIONING_OPTION_I18N_KEY;

/** The queued reasons, as a union (the two members of `AppProvisioningView['queuedReason']`). */
export type AppProvisioningQueuedReason = keyof typeof APP_PROVISIONING_QUEUED_REASON_I18N_KEY;
