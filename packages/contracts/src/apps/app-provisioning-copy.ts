/**
 * App Works — the App Provisioner's English copy module.
 *
 * Owning epic: **APW-04** (App Provisioner), task `tasks.md` T49:§"T49 (P1,
 * lands with T6–T12)" — created by T6:135 ("Create
 * `packages/contracts/src/apps/app-provisioning-copy.ts` **(new)** per T49").
 *
 * Plan: `docs/specs/features/app-works/APW-04-app-provisioner/plan.md` §3.2
 * (`plan.md:719-726`, the module's contract) and §9 (`:1217-1255`, the i18n
 * leaves). Spec: `…/spec.md` §6 (`:455-549`) — **the copy of record**, as §9
 * itself says at `:1241-1242` and `:1252-1253`.
 *
 * ## Why the server owns English text at all
 *
 * The Inbox and the Task conversation **store text**, and GitHub is not
 * translated — so the platform writes English there, while every headline,
 * reason, label and step note the **card** draws resolves from the viewer's
 * locale through keys (§9:1247-1255, FR-58, ACC-04-33). This module is the
 * server half: pure templates, no I/O, no locale files read at runtime, and
 * **one exported constant per string** so T27's equality test can pin each one
 * against its `en.json` leaf in both directions.
 *
 * Plan §3.2:723-724 states the invariant: "Its values are exactly the `en.json`
 * leaves of §9, so §9 remains the single source of the copy and T27 pins the two
 * together."
 *
 * ## The resolution rule, applied once, because §9 and spec §6 disagree in four places
 *
 * §9 is a compact listing of leaves; spec §6 is the same copy rendered as final
 * English. They disagree on four values, and §9 names spec §6 as the copy of
 * record (`:1241`, `:1242`), so **every value below is spec §6 character for
 * character** and each delta is recorded here rather than silently chosen:
 *
 * | Leaf                      | §9 (`plan.md:…`)                                                       | spec §6 (`:…`) and what this file uses                                                  |
 * | ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
 * | `queuedReason.userLimit`  | `you already have 3 provisionings running` (`:1231`) — no full stop    | `you already have 3 provisionings running.` (`:523`) — with one                        |
 * | `queuedReason.orgLimit`   | `this workspace already has 10 provisionings running` (`:1231`)        | `this workspace already has 10 provisionings running.` (`:523`) — with one              |
 * | `question.reminder.body`  | `Still waiting on your answer about {repo}.` (`:1242`) — one sentence  | the same sentence **plus** `The provisioning keeps waiting and fails after 14 days without an answer.` (`:536-537`) |
 * | `reasonText.noAnswer`     | claimed to take `{attempts}` (`:1232`)                                 | `the question went unanswered for 14 days.` (`:496`) — no placeholder                   |
 *
 * For the fourth, `attempts` is **declared as an accepted param and the §6 text
 * is used unchanged**: a declared-but-unused param satisfies both readings —
 * §9's claim that the template takes one, and T49's rule that no template may
 * contain a placeholder it has not declared. Nothing is narrowed either way.
 *
 * ## What spec §6 does not publish, and is therefore authored here (named, not hidden)
 *
 * Two groups of strings have a key in §9 but **no literal text anywhere in the
 * plan or the spec**, and are written here in the platform's voice:
 *
 * 1. `chat.failed` (§9:1243 lists the leaf; §6:515-517 gives the other five
 *    milestones and this one not at all) → {@link APP_PROVISION_CHAT_FAILED}.
 * 2. `evidence.*` (§9:1244 names the nine headings — attempt, step, verdict,
 *    duration, buildLog, imageDigest, target, smoke, spend — and gives no text)
 *    → the nine `APP_PROVISION_EVIDENCE_*` constants, whose values are those
 *    nine nouns, because §9's own parenthetical is the only description of them
 *    that exists. FR-34 (`spec.md:303-307`) fixes what each heading must carry,
 *    not how it is spelled.
 *
 * ## `choose:<n>` (T49's last case)
 *
 * `multiple-apps` offers one `choose:<n>` option per candidate, at most
 * `APP_PROVISION_LIMITS.optionsMax - 1` so `stop` always fits inside the cap of
 * four. The id resolves through the `choose` **prefix** — `choose:1` is not a
 * key of `APP_PROVISIONING_OPTION_I18N_KEY` — and `n` travels as the `candidate`
 * param, which is the rule §3.2:661 and §9:1249-1250 both state.
 */

import {
	APP_PROVISION_LIMITS,
	APP_PROVISIONING_FAILURE_REASON_I18N_KEY,
	APP_PROVISIONING_OPTION_I18N_KEY,
	APP_PROVISIONING_QUEUED_REASON_I18N_KEY,
	APP_PROVISIONING_QUESTION_REASON_I18N_KEY,
	type AppProvisioningFailureReason,
	type AppProvisioningOptionId,
	type AppProvisioningQueuedReason,
	type AppProvisioningQuestionReason
} from './app-provisioning.js';

// ---------------------------------------------------------------------------
// The declared params (T49: "no template contains a placeholder that is not a declared param")
// ---------------------------------------------------------------------------

/**
 * Every placeholder any template in this module may use.
 *
 * The first six are the names §3.1:370 fixes for `questionParams` — "params
 * carry names only (`variable`, `step`, `attempts`, `candidates`, `reasonCode`,
 * `fingerprint`), ≤ 1 KB, `scanForSecrets`-ed, **never a value**". The rest are
 * composition params of the English text (a repository name, a pull-request
 * number, a spend figure); they are **not** stored in `questionParams` and never
 * carry a secret.
 */
export const APP_PROVISION_COPY_PARAMS = [
	'repo',
	'attempts',
	'variable',
	'step',
	'reason',
	'candidate',
	'candidates',
	'pr',
	'n',
	'budget',
	'detail',
	'tokens',
	'minutes'
] as const;

/** One of the declared placeholder names. */
export type AppProvisionCopyParam = (typeof APP_PROVISION_COPY_PARAMS)[number];

/** The values a caller resolves a template with — strings and numbers only. */
export type AppProvisionCopyValues = Partial<Record<AppProvisionCopyParam, string | number>>;

/** One template and the params it declares. T49's spec reads exactly this shape. */
export interface AppProvisionCopyTemplate {
	/** The exported constant's name, so a failure names the string it is about. */
	readonly name: string;
	/** The template, character for character. */
	readonly value: string;
	/** The params the template declares — a superset of the placeholders it uses. */
	readonly params: readonly AppProvisionCopyParam[];
}

// ---------------------------------------------------------------------------
// Failure reason text (spec §6:491-497; leaf `reasonText.<leaf>`)
// ---------------------------------------------------------------------------

/** `no-isolated-runtime` (FR-2, plan §2.4). */
export const APP_PROVISION_REASON_TEXT_NO_ISOLATED_RUNTIME = 'no isolated sandbox is available.';

/** `repository-not-ready` — the §2.5 repository step's 30-minute wait. */
export const APP_PROVISION_REASON_TEXT_REPOSITORY_NOT_READY = 'the repository was not ready after 30 minutes.';

/** `repository-too-large` — the 3 GiB ceiling of `APP_PROVISION_LIMITS.repoMaxBytes`. */
export const APP_PROVISION_REASON_TEXT_REPOSITORY_TOO_LARGE = 'the repository is larger than 3 GiB.';

/** `not-runnable` — the analysis found no service to boot. */
export const APP_PROVISION_REASON_TEXT_NOT_RUNNABLE = 'this repository is not something that can run as a service.';

/** `token-cap` — the same sentence as the `token-cap` question subject (§6:493 and :528). */
export const APP_PROVISION_REASON_TEXT_TOKEN_CAP = 'the token cap was reached.';

/** `runner-minute-cap` — likewise shared with the `runner-minute-cap` question subject. */
export const APP_PROVISION_REASON_TEXT_RUNNER_MINUTE_CAP = 'the runner-minute cap was reached.';

/** `deadline` — `APP_PROVISION_LIMITS.activeDeadlineMs`, 8 hours. */
export const APP_PROVISION_REASON_TEXT_DEADLINE = 'it ran for more than 8 hours.';

/** `could-not-verify` — the one reason template §6 gives a placeholder to. */
export const APP_PROVISION_REASON_TEXT_COULD_NOT_VERIFY = 'it could not be verified after {attempts} attempts.';

/** `no-answer` — `APP_PROVISION_LIMITS.questionExpiryMs`, 14 days. Takes `attempts`; uses none. */
export const APP_PROVISION_REASON_TEXT_NO_ANSWER = 'the question went unanswered for 14 days.';

/** `verification-infrastructure` — no build capability for this repository. */
export const APP_PROVISION_REASON_TEXT_VERIFICATION_INFRASTRUCTURE = 'builds are not available for this repository.';

/** `private-repository` — the Wave 1 P1 boundary (§2.2, FR-63). */
export const APP_PROVISION_REASON_TEXT_PRIVATE_REPOSITORY = "private repositories can't be provisioned yet.";

/** Every failure reason's text, total over the union — a missing one is a compile error. */
export const APP_PROVISION_REASON_TEXTS = {
	'no-isolated-runtime': APP_PROVISION_REASON_TEXT_NO_ISOLATED_RUNTIME,
	'repository-not-ready': APP_PROVISION_REASON_TEXT_REPOSITORY_NOT_READY,
	'repository-too-large': APP_PROVISION_REASON_TEXT_REPOSITORY_TOO_LARGE,
	'not-runnable': APP_PROVISION_REASON_TEXT_NOT_RUNNABLE,
	'token-cap': APP_PROVISION_REASON_TEXT_TOKEN_CAP,
	'runner-minute-cap': APP_PROVISION_REASON_TEXT_RUNNER_MINUTE_CAP,
	deadline: APP_PROVISION_REASON_TEXT_DEADLINE,
	'could-not-verify': APP_PROVISION_REASON_TEXT_COULD_NOT_VERIFY,
	'no-answer': APP_PROVISION_REASON_TEXT_NO_ANSWER,
	'verification-infrastructure': APP_PROVISION_REASON_TEXT_VERIFICATION_INFRASTRUCTURE,
	'private-repository': APP_PROVISION_REASON_TEXT_PRIVATE_REPOSITORY
} as const satisfies Record<AppProvisioningFailureReason, string>;

// ---------------------------------------------------------------------------
// Question subjects (spec §6:511-512, :526-530; leaves `question.subject.<reason>`)
// ---------------------------------------------------------------------------

/** The prefix every composed Inbox subject carries (spec §6:511). */
export const APP_PROVISION_QUESTION_SUBJECT_PREFIX = 'Provisioning {repo}: ';

/** `attempts-spent` — the budget is spent; the human decides. */
export const APP_PROVISION_QUESTION_SUBJECT_ATTEMPTS_SPENT = 'the app could not be verified in {attempts} attempts.';

/** `repeated-failure` — the loop detector's fingerprint matched twice. */
export const APP_PROVISION_QUESTION_SUBJECT_REPEATED_FAILURE = 'the same failure happened twice.';

/** `missing-required-value` — a prompted variable the app will not boot without. */
export const APP_PROVISION_QUESTION_SUBJECT_MISSING_REQUIRED_VALUE = 'the app will not start without {variable}.';

/** `runner-capacity` — it cannot boot in the runner; the cluster may be the better target. */
export const APP_PROVISION_QUESTION_SUBJECT_RUNNER_CAPACITY = 'this app cannot boot in the build runner.';

/** `token-cap` — matches the `token-cap` failure text exactly (§6:493, :528). */
export const APP_PROVISION_QUESTION_SUBJECT_TOKEN_CAP = 'the token cap was reached.';

/** `runner-minute-cap` — matches the `runner-minute-cap` failure text exactly. */
export const APP_PROVISION_QUESTION_SUBJECT_RUNNER_MINUTE_CAP = 'the runner-minute cap was reached.';

/** `multiple-apps` — one repository, more than one candidate app. */
export const APP_PROVISION_QUESTION_SUBJECT_MULTIPLE_APPS = 'this repository has more than one app.';

/** `agent-asked` — the model itself asked (the reason code travels as a param, never as text). */
export const APP_PROVISION_QUESTION_SUBJECT_AGENT_ASKED = 'the agent needs a decision.';

/** `safety-rail` — R-17: a rail refused or held an action. */
export const APP_PROVISION_QUESTION_SUBJECT_SAFETY_RAIL = 'a safety rule stopped the run: {reason}.';

/** Every question reason's subject fragment, total over the union. */
export const APP_PROVISION_QUESTION_SUBJECTS = {
	'attempts-spent': APP_PROVISION_QUESTION_SUBJECT_ATTEMPTS_SPENT,
	'repeated-failure': APP_PROVISION_QUESTION_SUBJECT_REPEATED_FAILURE,
	'missing-required-value': APP_PROVISION_QUESTION_SUBJECT_MISSING_REQUIRED_VALUE,
	'runner-capacity': APP_PROVISION_QUESTION_SUBJECT_RUNNER_CAPACITY,
	'token-cap': APP_PROVISION_QUESTION_SUBJECT_TOKEN_CAP,
	'runner-minute-cap': APP_PROVISION_QUESTION_SUBJECT_RUNNER_MINUTE_CAP,
	'multiple-apps': APP_PROVISION_QUESTION_SUBJECT_MULTIPLE_APPS,
	'agent-asked': APP_PROVISION_QUESTION_SUBJECT_AGENT_ASKED,
	'safety-rail': APP_PROVISION_QUESTION_SUBJECT_SAFETY_RAIL
} as const satisfies Record<AppProvisioningQuestionReason, string>;

// ---------------------------------------------------------------------------
// Question option labels (spec §6:512-513, :532-534, :521; leaves `question.option.<leaf>`)
// ---------------------------------------------------------------------------

/** `retry` — the default first option (spec §6:532; the safety question's first too, §6:521). */
export const APP_PROVISION_OPTION_RETRY = 'Try again';

/** `retry-after-setting` — the `missing-required-value` case (§6:532-533). */
export const APP_PROVISION_OPTION_RETRY_AFTER_SETTING = 'I set it on the App env page — try again';

/** `optional` — declare the prompted variable optional and carry on. */
export const APP_PROVISION_OPTION_OPTIONAL = 'Treat it as optional';

/** `verify-on-cluster` — switch the verification target (§2.4). */
export const APP_PROVISION_OPTION_VERIFY_ON_CLUSTER = 'Verify on my cluster instead';

/** `accept-build-only` — accept the weaker "it builds" verdict. */
export const APP_PROVISION_OPTION_ACCEPT_BUILD_ONLY = 'Build and check only';

/** `raise-cap`, token variant — the `token-cap` question's option (§6:533). */
export const APP_PROVISION_OPTION_RAISE_CAP_TOKENS = 'Raise the cap by 1,000,000 tokens';

/** `raise-cap`, runner-minute variant — the `runner-minute-cap` question's option (§6:533). */
export const APP_PROVISION_OPTION_RAISE_CAP_MINUTES = 'Raise the cap by 60 runner minutes';

/** `choose` — one per candidate, `n` as the `candidate` param (§6:534). */
export const APP_PROVISION_OPTION_CHOOSE = 'Use {candidate}';

/** `stop` — always the last option (spec §6:513, :521, :534). */
export const APP_PROVISION_OPTION_STOP = 'Stop provisioning';

/** The option id → label, for the ids that have exactly one label. */
export const APP_PROVISION_OPTION_LABELS = {
	retry: APP_PROVISION_OPTION_RETRY,
	'retry-after-setting': APP_PROVISION_OPTION_RETRY_AFTER_SETTING,
	optional: APP_PROVISION_OPTION_OPTIONAL,
	'verify-on-cluster': APP_PROVISION_OPTION_VERIFY_ON_CLUSTER,
	'accept-build-only': APP_PROVISION_OPTION_ACCEPT_BUILD_ONLY,
	choose: APP_PROVISION_OPTION_CHOOSE,
	stop: APP_PROVISION_OPTION_STOP
} as const;

/**
 * The `raise-cap` label the caller must pick by hand: the id has two, because
 * the cap being raised is a token cap or a runner-minute cap (§6:533).
 */
export const APP_PROVISION_RAISE_CAP_LABELS = {
	'token-cap': APP_PROVISION_OPTION_RAISE_CAP_TOKENS,
	'runner-minute-cap': APP_PROVISION_OPTION_RAISE_CAP_MINUTES
} as const;

/** One option as the Inbox receives it: the machine id, the leaf, and the English label. */
export interface AppProvisioningQuestionOption {
	/** `choose:<n>` for a candidate option; otherwise the map's own key. */
	readonly id: string;
	/** The i18n leaf `question.option.<i18nKey>` (§9:1241). */
	readonly i18nKey: string;
	/** The English label the Inbox stores. */
	readonly label: string;
	/** The candidate number, on a `choose:<n>` option only. */
	readonly candidate?: number;
}

// ---------------------------------------------------------------------------
// Chat milestones (spec §6:515-517; leaves `chat.*`)
// ---------------------------------------------------------------------------

/** `chat.started` — posted to the Task conversation when a run starts. */
export const APP_PROVISION_CHAT_STARTED = "Started provisioning {repo}. I'll post here at each milestone.";

/** `chat.proposed` — the pull request is open and verification has begun. */
export const APP_PROVISION_CHAT_PROPOSED = 'Opened pull request #{pr} with the App spec. Verifying now.';

/** `chat.attemptRed` — one red attempt, with the failing step and the reason it gave. */
export const APP_PROVISION_CHAT_ATTEMPT_RED = 'Attempt {n} of {budget} failed at {step}: {detail}. Fixing it.';

/** `chat.succeeded` — verified; the human merges. */
export const APP_PROVISION_CHAT_SUCCEEDED = 'Verified. Review and merge pull request #{pr}.';

/** `chat.needsInput` — the question is in My Decisions (never the question's text: §6:542). */
export const APP_PROVISION_CHAT_NEEDS_INPUT = "I need a decision from you — it's in My Decisions.";

/**
 * `chat.failed` — **authored here**: §9:1243 declares the leaf and spec §6
 * publishes no text for it (see the module docstring). The composed sentence is
 * `Provisioning stopped: <reasonText>` so the chat and the card cannot disagree
 * about why.
 */
export const APP_PROVISION_CHAT_FAILED = 'Provisioning stopped: {reason}.';

/** Every chat milestone, by leaf. */
export const APP_PROVISION_CHAT_TEMPLATES = {
	started: APP_PROVISION_CHAT_STARTED,
	proposed: APP_PROVISION_CHAT_PROPOSED,
	attemptRed: APP_PROVISION_CHAT_ATTEMPT_RED,
	succeeded: APP_PROVISION_CHAT_SUCCEEDED,
	needsInput: APP_PROVISION_CHAT_NEEDS_INPUT,
	failed: APP_PROVISION_CHAT_FAILED
} as const;

// ---------------------------------------------------------------------------
// Evidence headings (plan §9:1244, FR-34 at spec §6… §4.7:303-307; leaves `evidence.*`)
// ---------------------------------------------------------------------------

/** The attempt's number and budget line. */
export const APP_PROVISION_EVIDENCE_ATTEMPT = 'Attempt';
/** One step's row. */
export const APP_PROVISION_EVIDENCE_STEP = 'Step';
/** The verdict of a step or of the attempt. */
export const APP_PROVISION_EVIDENCE_VERDICT = 'Verdict';
/** How long a step or the attempt took. */
export const APP_PROVISION_EVIDENCE_DURATION = 'Duration';
/** The build log link (FR-34). */
export const APP_PROVISION_EVIDENCE_BUILD_LOG = 'Build log';
/** The image digest the run booted (FR-34). */
export const APP_PROVISION_EVIDENCE_IMAGE_DIGEST = 'Image digest';
/** `cluster` or `runner` — `AppProvisioningView.verificationTargetKind` (§2.4). */
export const APP_PROVISION_EVIDENCE_TARGET = 'Target';
/** The smoke table's heading: name, expected, observed, duration (FR-34). */
export const APP_PROVISION_EVIDENCE_SMOKE = 'Smoke tests';
/** Tokens and runner minutes spent so far (FR-34). */
export const APP_PROVISION_EVIDENCE_SPEND = 'Spend';

/** Every evidence heading, by leaf — one per `evidence.*` leaf of §9:1244. */
export const APP_PROVISION_EVIDENCE_HEADINGS = {
	attempt: APP_PROVISION_EVIDENCE_ATTEMPT,
	step: APP_PROVISION_EVIDENCE_STEP,
	verdict: APP_PROVISION_EVIDENCE_VERDICT,
	duration: APP_PROVISION_EVIDENCE_DURATION,
	buildLog: APP_PROVISION_EVIDENCE_BUILD_LOG,
	imageDigest: APP_PROVISION_EVIDENCE_IMAGE_DIGEST,
	target: APP_PROVISION_EVIDENCE_TARGET,
	smoke: APP_PROVISION_EVIDENCE_SMOKE,
	spend: APP_PROVISION_EVIDENCE_SPEND
} as const;

// ---------------------------------------------------------------------------
// The queued reasons (spec §6:523-524; leaves `queuedReason.<leaf>`)
// ---------------------------------------------------------------------------

/** `user-limit` — `APP_PROVISION_LIMITS.activePerUser` (3). */
export const APP_PROVISION_QUEUED_REASON_USER_LIMIT = 'you already have 3 provisionings running.';

/** `org-limit` — `APP_PROVISION_LIMITS.activePerOrg` (10). */
export const APP_PROVISION_QUEUED_REASON_ORG_LIMIT = 'this workspace already has 10 provisionings running.';

/** Both queued reasons, total over the union (spec §6:523, FR-44). */
export const APP_PROVISION_QUEUED_REASON_TEXTS = {
	'user-limit': APP_PROVISION_QUEUED_REASON_USER_LIMIT,
	'org-limit': APP_PROVISION_QUEUED_REASON_ORG_LIMIT
} as const satisfies Record<AppProvisioningQueuedReason, string>;

// ---------------------------------------------------------------------------
// The reminder (spec §6:536-537, S20; leaves `question.reminder.title` / `.body`)
// ---------------------------------------------------------------------------

/** The reminder's Inbox title. */
export const APP_PROVISION_REMINDER_TITLE = 'Still waiting on your answer';

/** The reminder's Inbox body — `questionReminderMs` is 72 h, `questionExpiryMs` 14 days. */
export const APP_PROVISION_REMINDER_BODY =
	'Still waiting on your answer about {repo}. The provisioning keeps waiting and fails after 14 days without an answer.';

// ---------------------------------------------------------------------------
// The template registry — what T49's spec iterates
// ---------------------------------------------------------------------------

/**
 * Every template this module exports, with the params it declares.
 *
 * T49's tests read this array: every `value` non-empty, every placeholder a
 * declared param, and every reason / option / failure / queued id carrying a
 * map entry whose leaf matches `/^[a-z][a-zA-Z0-9]*$/`.
 */
export const APP_PROVISION_COPY_TEMPLATES: readonly AppProvisionCopyTemplate[] = [
	{
		name: 'APP_PROVISION_REASON_TEXT_NO_ISOLATED_RUNTIME',
		value: APP_PROVISION_REASON_TEXT_NO_ISOLATED_RUNTIME,
		params: []
	},
	{
		name: 'APP_PROVISION_REASON_TEXT_REPOSITORY_NOT_READY',
		value: APP_PROVISION_REASON_TEXT_REPOSITORY_NOT_READY,
		params: []
	},
	{
		name: 'APP_PROVISION_REASON_TEXT_REPOSITORY_TOO_LARGE',
		value: APP_PROVISION_REASON_TEXT_REPOSITORY_TOO_LARGE,
		params: []
	},
	{ name: 'APP_PROVISION_REASON_TEXT_NOT_RUNNABLE', value: APP_PROVISION_REASON_TEXT_NOT_RUNNABLE, params: [] },
	{ name: 'APP_PROVISION_REASON_TEXT_TOKEN_CAP', value: APP_PROVISION_REASON_TEXT_TOKEN_CAP, params: [] },
	{
		name: 'APP_PROVISION_REASON_TEXT_RUNNER_MINUTE_CAP',
		value: APP_PROVISION_REASON_TEXT_RUNNER_MINUTE_CAP,
		params: []
	},
	{ name: 'APP_PROVISION_REASON_TEXT_DEADLINE', value: APP_PROVISION_REASON_TEXT_DEADLINE, params: [] },
	{
		name: 'APP_PROVISION_REASON_TEXT_COULD_NOT_VERIFY',
		value: APP_PROVISION_REASON_TEXT_COULD_NOT_VERIFY,
		params: ['attempts']
	},
	{ name: 'APP_PROVISION_REASON_TEXT_NO_ANSWER', value: APP_PROVISION_REASON_TEXT_NO_ANSWER, params: ['attempts'] },
	{
		name: 'APP_PROVISION_REASON_TEXT_VERIFICATION_INFRASTRUCTURE',
		value: APP_PROVISION_REASON_TEXT_VERIFICATION_INFRASTRUCTURE,
		params: []
	},
	{
		name: 'APP_PROVISION_REASON_TEXT_PRIVATE_REPOSITORY',
		value: APP_PROVISION_REASON_TEXT_PRIVATE_REPOSITORY,
		params: []
	},
	{ name: 'APP_PROVISION_QUESTION_SUBJECT_PREFIX', value: APP_PROVISION_QUESTION_SUBJECT_PREFIX, params: ['repo'] },
	{
		name: 'APP_PROVISION_QUESTION_SUBJECT_ATTEMPTS_SPENT',
		value: APP_PROVISION_QUESTION_SUBJECT_ATTEMPTS_SPENT,
		params: ['attempts']
	},
	{
		name: 'APP_PROVISION_QUESTION_SUBJECT_REPEATED_FAILURE',
		value: APP_PROVISION_QUESTION_SUBJECT_REPEATED_FAILURE,
		params: []
	},
	{
		name: 'APP_PROVISION_QUESTION_SUBJECT_MISSING_REQUIRED_VALUE',
		value: APP_PROVISION_QUESTION_SUBJECT_MISSING_REQUIRED_VALUE,
		params: ['variable']
	},
	{
		name: 'APP_PROVISION_QUESTION_SUBJECT_RUNNER_CAPACITY',
		value: APP_PROVISION_QUESTION_SUBJECT_RUNNER_CAPACITY,
		params: []
	},
	{ name: 'APP_PROVISION_QUESTION_SUBJECT_TOKEN_CAP', value: APP_PROVISION_QUESTION_SUBJECT_TOKEN_CAP, params: [] },
	{
		name: 'APP_PROVISION_QUESTION_SUBJECT_RUNNER_MINUTE_CAP',
		value: APP_PROVISION_QUESTION_SUBJECT_RUNNER_MINUTE_CAP,
		params: []
	},
	{
		name: 'APP_PROVISION_QUESTION_SUBJECT_MULTIPLE_APPS',
		value: APP_PROVISION_QUESTION_SUBJECT_MULTIPLE_APPS,
		params: []
	},
	{
		name: 'APP_PROVISION_QUESTION_SUBJECT_AGENT_ASKED',
		value: APP_PROVISION_QUESTION_SUBJECT_AGENT_ASKED,
		params: []
	},
	{
		name: 'APP_PROVISION_QUESTION_SUBJECT_SAFETY_RAIL',
		value: APP_PROVISION_QUESTION_SUBJECT_SAFETY_RAIL,
		params: ['reason']
	},
	{ name: 'APP_PROVISION_OPTION_RETRY', value: APP_PROVISION_OPTION_RETRY, params: [] },
	{ name: 'APP_PROVISION_OPTION_RETRY_AFTER_SETTING', value: APP_PROVISION_OPTION_RETRY_AFTER_SETTING, params: [] },
	{ name: 'APP_PROVISION_OPTION_OPTIONAL', value: APP_PROVISION_OPTION_OPTIONAL, params: [] },
	{ name: 'APP_PROVISION_OPTION_VERIFY_ON_CLUSTER', value: APP_PROVISION_OPTION_VERIFY_ON_CLUSTER, params: [] },
	{ name: 'APP_PROVISION_OPTION_ACCEPT_BUILD_ONLY', value: APP_PROVISION_OPTION_ACCEPT_BUILD_ONLY, params: [] },
	{ name: 'APP_PROVISION_OPTION_RAISE_CAP_TOKENS', value: APP_PROVISION_OPTION_RAISE_CAP_TOKENS, params: [] },
	{ name: 'APP_PROVISION_OPTION_RAISE_CAP_MINUTES', value: APP_PROVISION_OPTION_RAISE_CAP_MINUTES, params: [] },
	{ name: 'APP_PROVISION_OPTION_CHOOSE', value: APP_PROVISION_OPTION_CHOOSE, params: ['candidate'] },
	{ name: 'APP_PROVISION_OPTION_STOP', value: APP_PROVISION_OPTION_STOP, params: [] },
	{ name: 'APP_PROVISION_CHAT_STARTED', value: APP_PROVISION_CHAT_STARTED, params: ['repo'] },
	{ name: 'APP_PROVISION_CHAT_PROPOSED', value: APP_PROVISION_CHAT_PROPOSED, params: ['pr'] },
	{
		name: 'APP_PROVISION_CHAT_ATTEMPT_RED',
		value: APP_PROVISION_CHAT_ATTEMPT_RED,
		params: ['n', 'budget', 'step', 'detail']
	},
	{ name: 'APP_PROVISION_CHAT_SUCCEEDED', value: APP_PROVISION_CHAT_SUCCEEDED, params: ['pr'] },
	{ name: 'APP_PROVISION_CHAT_NEEDS_INPUT', value: APP_PROVISION_CHAT_NEEDS_INPUT, params: [] },
	{ name: 'APP_PROVISION_CHAT_FAILED', value: APP_PROVISION_CHAT_FAILED, params: ['reason'] },
	{ name: 'APP_PROVISION_EVIDENCE_ATTEMPT', value: APP_PROVISION_EVIDENCE_ATTEMPT, params: [] },
	{ name: 'APP_PROVISION_EVIDENCE_STEP', value: APP_PROVISION_EVIDENCE_STEP, params: [] },
	{ name: 'APP_PROVISION_EVIDENCE_VERDICT', value: APP_PROVISION_EVIDENCE_VERDICT, params: [] },
	{ name: 'APP_PROVISION_EVIDENCE_DURATION', value: APP_PROVISION_EVIDENCE_DURATION, params: [] },
	{ name: 'APP_PROVISION_EVIDENCE_BUILD_LOG', value: APP_PROVISION_EVIDENCE_BUILD_LOG, params: [] },
	{ name: 'APP_PROVISION_EVIDENCE_IMAGE_DIGEST', value: APP_PROVISION_EVIDENCE_IMAGE_DIGEST, params: [] },
	{ name: 'APP_PROVISION_EVIDENCE_TARGET', value: APP_PROVISION_EVIDENCE_TARGET, params: [] },
	{ name: 'APP_PROVISION_EVIDENCE_SMOKE', value: APP_PROVISION_EVIDENCE_SMOKE, params: [] },
	{ name: 'APP_PROVISION_EVIDENCE_SPEND', value: APP_PROVISION_EVIDENCE_SPEND, params: [] },
	{ name: 'APP_PROVISION_QUEUED_REASON_USER_LIMIT', value: APP_PROVISION_QUEUED_REASON_USER_LIMIT, params: [] },
	{ name: 'APP_PROVISION_QUEUED_REASON_ORG_LIMIT', value: APP_PROVISION_QUEUED_REASON_ORG_LIMIT, params: [] },
	{ name: 'APP_PROVISION_REMINDER_TITLE', value: APP_PROVISION_REMINDER_TITLE, params: [] },
	{ name: 'APP_PROVISION_REMINDER_BODY', value: APP_PROVISION_REMINDER_BODY, params: ['repo'] }
];

// ---------------------------------------------------------------------------
// The resolver — every placeholder substituted, nothing left to interpret
// ---------------------------------------------------------------------------

/** Every placeholder a template can carry, as a global matcher. */
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/**
 * Resolve one template with the values the caller has.
 *
 * A placeholder with no value is left **verbatim** rather than blanked: the job
 * composes every string from data it already holds, so a `{repo}` that survived
 * is a bug that should be visible on the card, not an empty sentence that reads
 * as deliberate English.
 */
export function resolveAppProvisionCopy(template: string, values: AppProvisionCopyValues = {}): string {
	return template.replace(PLACEHOLDER, (placeholder, name: string) => {
		const value = values[name as AppProvisionCopyParam];
		return value === undefined ? placeholder : String(value);
	});
}

/** The placeholders a template actually uses, in first-appearance order. */
export function appProvisionCopyPlaceholders(template: string): string[] {
	return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// `appProvisionCopy` — the one object §3.2:721 and §7.7:1154 name
// ---------------------------------------------------------------------------

/**
 * The order a reason's options are offered in. Every list ends with `stop`, and
 * no list exceeds `APP_PROVISION_LIMITS.optionsMax` (spec §6:511, plan §3.2:489).
 *
 * `multiple-apps` is built dynamically — one `choose:<n>` per candidate — so its
 * entry here lists only the fixed tail.
 */
const OPTION_ORDER: Record<AppProvisioningQuestionReason, readonly AppProvisioningOptionId[]> = {
	'attempts-spent': ['retry', 'stop'],
	'repeated-failure': ['retry', 'stop'],
	'missing-required-value': ['retry-after-setting', 'optional', 'stop'],
	'runner-capacity': ['verify-on-cluster', 'accept-build-only', 'stop'],
	'token-cap': ['raise-cap', 'stop'],
	'runner-minute-cap': ['raise-cap', 'stop'],
	'multiple-apps': ['stop'],
	'agent-asked': ['retry', 'stop'],
	'safety-rail': ['retry', 'stop']
};

/** How many candidate options fit beside `stop` inside `optionsMax`. */
const MAX_CANDIDATE_OPTIONS = APP_PROVISION_LIMITS.optionsMax - 1;

/** The label for a fixed option id, at a given reason. */
function optionLabel(reason: AppProvisioningQuestionReason, id: AppProvisioningOptionId): string {
	if (id === 'raise-cap') {
		return reason === 'runner-minute-cap'
			? APP_PROVISION_OPTION_RAISE_CAP_MINUTES
			: APP_PROVISION_OPTION_RAISE_CAP_TOKENS;
	}

	return (APP_PROVISION_OPTION_LABELS as Record<string, string>)[id];
}

/**
 * The English copy the Provisioner writes to the Inbox, the Task conversation
 * and the pull request — the single object §3.2:721 declares and §7.7:1154
 * calls.
 *
 * Pure: no I/O, no locale file, no clock, no random. Every method is total over
 * its union, so a reason added to `APP_PROVISIONING_QUESTION_REASONS` without a
 * template is a compile error rather than a blank sentence.
 */
export const appProvisionCopy = {
	/**
	 * The composed Inbox subject: `Provisioning <repo>: <fragment>`
	 * (spec §6:511). `repo` and every fragment param travel in `values`.
	 */
	questionSubject(reason: AppProvisioningQuestionReason, values: AppProvisionCopyValues = {}): string {
		return resolveAppProvisionCopy(
			APP_PROVISION_QUESTION_SUBJECT_PREFIX + APP_PROVISION_QUESTION_SUBJECTS[reason],
			values
		);
	},

	/**
	 * The options for one question, in order, always ending with `stop`.
	 *
	 * `multiple-apps` offers one `choose:<n>` per candidate in
	 * `values.candidates` (a comma-separated list of names), capped so the total
	 * never exceeds `APP_PROVISION_LIMITS.optionsMax`.
	 */
	questionOptions(
		reason: AppProvisioningQuestionReason,
		values: AppProvisionCopyValues = {}
	): AppProvisioningQuestionOption[] {
		const options: AppProvisioningQuestionOption[] = [];

		if (reason === 'multiple-apps') {
			const candidates = String(values.candidates ?? '')
				.split(',')
				.map((candidate) => candidate.trim())
				.filter((candidate) => candidate.length > 0)
				.slice(0, MAX_CANDIDATE_OPTIONS);

			candidates.forEach((candidate, index) => {
				options.push({
					id: `choose:${index + 1}`,
					i18nKey: APP_PROVISIONING_OPTION_I18N_KEY.choose,
					label: resolveAppProvisionCopy(APP_PROVISION_OPTION_CHOOSE, { candidate }),
					candidate: index + 1
				});
			});
		}

		for (const id of OPTION_ORDER[reason]) {
			options.push({
				id,
				i18nKey: APP_PROVISIONING_OPTION_I18N_KEY[id],
				label: resolveAppProvisionCopy(optionLabel(reason, id), values)
			});
		}

		return options;
	},

	/** The failure text for the card's `Failed` headline (spec §6:485). */
	reasonText(failureReason: AppProvisioningFailureReason, values: AppProvisionCopyValues = {}): string {
		return resolveAppProvisionCopy(APP_PROVISION_REASON_TEXTS[failureReason], values);
	},

	/** The queued headline's reason clause, per `AppProvisioningView.queuedReason`. */
	queuedReason(queuedReason: AppProvisioningQueuedReason): string {
		return APP_PROVISION_QUEUED_REASON_TEXTS[queuedReason];
	},

	/** The six chat milestones, resolved on call. */
	chat: {
		started: (values: AppProvisionCopyValues = {}): string =>
			resolveAppProvisionCopy(APP_PROVISION_CHAT_STARTED, values),
		proposed: (values: AppProvisionCopyValues = {}): string =>
			resolveAppProvisionCopy(APP_PROVISION_CHAT_PROPOSED, values),
		attemptRed: (values: AppProvisionCopyValues = {}): string =>
			resolveAppProvisionCopy(APP_PROVISION_CHAT_ATTEMPT_RED, values),
		succeeded: (values: AppProvisionCopyValues = {}): string =>
			resolveAppProvisionCopy(APP_PROVISION_CHAT_SUCCEEDED, values),
		needsInput: (values: AppProvisionCopyValues = {}): string =>
			resolveAppProvisionCopy(APP_PROVISION_CHAT_NEEDS_INPUT, values),
		failed: (values: AppProvisionCopyValues = {}): string =>
			resolveAppProvisionCopy(APP_PROVISION_CHAT_FAILED, values)
	},

	/** The nine evidence-comment headings, by leaf. */
	evidence: {
		attempt: APP_PROVISION_EVIDENCE_ATTEMPT,
		step: APP_PROVISION_EVIDENCE_STEP,
		verdict: APP_PROVISION_EVIDENCE_VERDICT,
		duration: APP_PROVISION_EVIDENCE_DURATION,
		buildLog: APP_PROVISION_EVIDENCE_BUILD_LOG,
		imageDigest: APP_PROVISION_EVIDENCE_IMAGE_DIGEST,
		target: APP_PROVISION_EVIDENCE_TARGET,
		smoke: APP_PROVISION_EVIDENCE_SMOKE,
		spend: APP_PROVISION_EVIDENCE_SPEND
	},

	/** The 72-hour reminder (S20): title and body. */
	reminder: {
		title: APP_PROVISION_REMINDER_TITLE,
		body: (values: AppProvisionCopyValues = {}): string =>
			resolveAppProvisionCopy(APP_PROVISION_REMINDER_BODY, values)
	},

	/**
	 * The i18n leaf for a question reason — the same lookup the card makes, so
	 * the server's English and the viewer's locale cannot diverge on WHICH
	 * string they mean.
	 */
	reasonI18nKey(reason: AppProvisioningQuestionReason): string {
		return APP_PROVISIONING_QUESTION_REASON_I18N_KEY[reason];
	},

	/** The i18n leaf for a failure reason. */
	failureI18nKey(failureReason: AppProvisioningFailureReason): string {
		return APP_PROVISIONING_FAILURE_REASON_I18N_KEY[failureReason];
	},

	/** The i18n leaf for a queued reason. */
	queuedI18nKey(queuedReason: AppProvisioningQueuedReason): string {
		return APP_PROVISIONING_QUEUED_REASON_I18N_KEY[queuedReason];
	}
} as const;

/** The object's type, for the worker and the controller that inject it. */
export type AppProvisionCopy = typeof appProvisionCopy;
