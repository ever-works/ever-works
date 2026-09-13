/**
 * Post-deploy verification and revert (self-build slice AJ, EW-809) — the
 * half of the release lane that says whether the release WORKED.
 *
 * ## What this file is
 *
 * Slice AI opens the promotion pull request and reads the promotion gate.
 * The gate judges the CODE at a commit; it says nothing about whether that
 * code ever reached a running environment, and nothing at all about
 * whether the environment still serves pages afterwards. On 2026-09-06 a
 * whole batch was cascaded `develop → stage → main` and nothing on the
 * platform confirmed the result. The prod build lane is measured at
 * 215–243 minutes, so an unverified bad deploy is a multi-hour outage.
 *
 * These are the zero-dependency pieces every half of the verification lane
 * must agree on byte-for-byte: which environment a rung deploys, where
 * that environment lives, WHICH probe is run in which state, and what a
 * verdict is allowed to mean. Two implementations of
 * {@link resolveReleaseVerificationTarget} is how a `develop → stage`
 * promotion gets verified against production.
 *
 * ## What this file deliberately is NOT
 *
 * It is not a revert. Nothing here reverts, merges, deploys or rolls back,
 * and there is no function that turns a verdict into an action. A failed
 * verification produces an OFFER a human reads and decides; undoing a
 * promotion is the same class of act as making one, and slice AI's whole
 * argument — the founder performs each rung deliberately — applies at
 * least as strongly in reverse. {@link isReleaseVerifyRevertOffered} tells
 * you an offer was FILED. Nothing tells you one was taken, because the
 * platform never takes one.
 *
 * ## The vocabulary is deliberately not boolean
 *
 * "Did the deploy work" has three answers, not two, and collapsing the
 * third into either of the others is the whole bug class this slice
 * exists for. `passed` means we watched the promoted build serve and then
 * watched the app render. `failed` means we watched the promoted build
 * serve and then watched the app NOT render, repeatedly, with the serving
 * re-confirmed afterwards. Everything else — the rollout never arrived,
 * the fleet had no browser to check with, nobody configured a URL for this
 * environment — is `inconclusive` or `unsupported`, which are NOT passes
 * and are NOT grounds for offering a revert either. You cannot responsibly
 * offer to undo a release on the strength of a measurement you failed to
 * take.
 */

import { PROMOTION_RUNGS, type PromotionRung } from './promotion.types.js';

// ── Which environment a rung deploys ─────────────────────────────────

/**
 * The environment a promotion's BASE branch is deployed as.
 *
 * The base, never the head: merging `develop → stage` deploys STAGE. A
 * verification that checked the head's environment would check the one
 * that was already running before the promotion, pass, and prove nothing
 * — the "wrong URL" hazard in its most plausible form.
 */
export type ReleaseEnvironment = 'staging' | 'production';

export const RELEASE_ENVIRONMENTS = ['staging', 'production'] as const satisfies readonly ReleaseEnvironment[];

/**
 * THE rung → environment mapping. One function, so the enqueue side and
 * the operator surface cannot disagree about what was deployed.
 */
export function releaseEnvironmentForRung(rung: PromotionRung): ReleaseEnvironment | null {
	switch (rung) {
		case 'develop-to-stage':
			return 'staging';
		case 'stage-to-main':
			return 'production';
		default:
			// An unknown rung has no environment. Refusing beats guessing
			// `production`, which is the one guess that could point a check
			// — and therefore a revert offer — at the wrong deployment.
			return null;
	}
}

// ── Where an environment lives, as PLATFORM STATE ────────────────────

/** Longest URL accepted into a verification target. */
export const RELEASE_VERIFY_URL_MAX_LENGTH = 512;

/** Longest DOM expectation accepted into a verification target. */
export const RELEASE_VERIFY_EXPECT_MAX_LENGTH = 200;

/**
 * Shortest DOM expectation accepted.
 *
 * A short expectation is satisfied by almost any HTML document, including
 * a provider's own error page, so it is not an expectation — it is a check
 * that always passes. Refused rather than accepted-and-warned.
 *
 * REVISED UPWARDS from 3 during the slice-AJ review, because 3 did not
 * achieve what its own comment claimed. The node matches with a raw
 * `dom.includes(expectText)` against the serialized document
 * (`apps/node/src/core/executors/browser-check.ts`), and `div`, `htm`,
 * `<ht`, `ody` and `</p` appear in essentially every rendered page —
 * including Chrome's own network-error page and a CDN 502 interstitial,
 * both of which exit 0 under `--dump-dom` and produce a NON-EMPTY
 * document, so the executor's empty-document guard does not catch them
 * either. Eight characters plus {@link isPageBoilerplate} below is the
 * pair that makes the guarantee real.
 */
export const RELEASE_VERIFY_EXPECT_MIN_LENGTH = 8;

/**
 * Fragments of a bare HTML document, which every rendered page contains.
 *
 * An expectation that is a substring of this corpus asserts only "the
 * browser produced a document", which is what the empty-document guard
 * already covers — so accepting one would be accepting a check that
 * passes when nothing was checked. Deliberately a CORPUS rather than a
 * blocklist of tokens: `<div`, `div>`, `<body`, `y></bod` and every other
 * slice of a skeleton page are all refused by the one rule.
 */
const PAGE_BOILERPLATE = [
	'<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>',
	'<html lang="en"><body class="">',
	'<div></div><p></p><span></span><br><hr><a href="#"></a><ul><li></li></ul><h1></h1>'
];

function isPageBoilerplate(value: string): boolean {
	const lowered = value.toLowerCase();
	return PAGE_BOILERPLATE.some((skeleton) => skeleton.includes(lowered));
}

/**
 * Where ONE deployed environment can be observed from outside.
 *
 * Both URLs are absolute `https://` and both come from the Work row. A
 * caller never supplies either: a request that could name the URL a
 * verification checks could point a green verdict at a page it controls,
 * and the verdict is what stands between a bad release and a human being
 * told everything is fine.
 */
export interface ReleaseVerificationTarget {
	/**
	 * A URL whose rendered DOM contains the deployed commit sha.
	 *
	 * THE artefact-identity probe, and the reason this lane can claim to
	 * have checked the build that was just promoted rather than the one
	 * that happened to be running. For this platform that is the API's
	 * `/api/version`, which serves `gitSha` stamped into the image at build
	 * time (`GIT_SHA=${{ github.sha }}` in `docker-build-publish-prod.yml`).
	 *
	 * A plain health endpoint is NOT a substitute: `apps/web`'s
	 * `/api/health` answers a fixed `{"status":"OK"}` with no version in
	 * it, so it returns 200 for the OLD build throughout a rollout and for
	 * a rollout that never happened at all.
	 */
	readonly versionUrl: string;
	/** The human-facing page that must actually render once the rollout lands. */
	readonly appUrl: string;
	/**
	 * Text that must appear in {@link appUrl}'s DOM.
	 *
	 * Required, not optional. A browser check with no expectation passes on
	 * any document the browser managed to render — including a CDN error
	 * page and a provider's "application failed to respond" — which is
	 * precisely the check-that-passes-when-nothing-was-checked this lane
	 * exists to prevent.
	 */
	readonly appExpectText: string;
}

/** Per-environment verification targets, stored on the Work. */
export interface ReleaseVerificationTargets {
	readonly staging?: ReleaseVerificationTarget | null;
	readonly production?: ReleaseVerificationTarget | null;
}

/**
 * Hostnames a verification target may name.
 *
 * Deliberately narrow: at least two dot-separated DNS labels with an
 * alphabetic last label. That refuses every IP literal (`169.254.169.254`,
 * `10.0.0.1`), every bracketed IPv6 form, and every single-label name
 * (`localhost`, `metadata`, a Kubernetes service name).
 *
 * The check runs a real browser on an enrolled fleet node — somebody's
 * actual PC, inside their actual network — so a target that could name a
 * link-local or private address would be an SSRF primitive pointed at the
 * node operator rather than at the server. The column holding these is
 * `simple-json` and therefore contains whatever was last written to it,
 * which is why this is enforced on READ and not only at write time.
 */
const PROBE_HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function isPublicDnsHostname(hostname: string): boolean {
	if (!hostname || hostname.length > 253) return false;
	// `new URL()` renders an IPv6 host bracketed; no DNS label can contain
	// a bracket or a colon, so the label test below would refuse it anyway.
	// Checked explicitly so the reason is stated rather than incidental.
	if (hostname.includes(':') || hostname.startsWith('[')) return false;
	const labels = hostname.toLowerCase().split('.');
	if (labels.length < 2) return false;
	if (!labels.every((label) => PROBE_HOST_LABEL.test(label))) return false;
	// An all-numeric last label means a dotted IP literal, which the label
	// pattern happily accepts.
	return /^[a-z]{2,}$/.test(labels[labels.length - 1]!);
}

function normalizeProbeUrl(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > RELEASE_VERIFY_URL_MAX_LENGTH) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	// https ONLY. Over plaintext http anything on the path between the node
	// and the environment can serve the expected commit sha, and a verdict
	// that can be forged in transit is worse than no verdict — it is a
	// green one.
	if (parsed.protocol !== 'https:') return null;
	// Credentials never belong in platform state, and `user:pass@host` is
	// also the classic way to make a URL LOOK like it points somewhere else.
	if (parsed.username || parsed.password) return null;
	// A fragment is never sent to the server; carrying one can only mislead
	// the human reading the target back.
	if (parsed.hash) return null;
	if (!isPublicDnsHostname(parsed.hostname)) return null;
	return parsed.toString();
}

function normalizeExpectText(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (trimmed.length < RELEASE_VERIFY_EXPECT_MIN_LENGTH) return null;
	if (trimmed.length > RELEASE_VERIFY_EXPECT_MAX_LENGTH) return null;
	// Length alone is not enough: `<html><head` is eleven characters and
	// still appears in every page ever served.
	if (isPageBoilerplate(trimmed)) return null;
	return trimmed;
}

/**
 * The registrable-ish site of a hostname: its last two DNS labels.
 *
 * An approximation of the public-suffix boundary, on purpose — this
 * package has no dependencies and will not carry a PSL. It is used for
 * ONE narrow question (below), where the cost of the approximation is a
 * slightly weaker refusal and never a false pass.
 */
function siteOf(hostname: string): string {
	return hostname.toLowerCase().split('.').slice(-2).join('.');
}

function normalizeTarget(raw: unknown): ReleaseVerificationTarget | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const candidate = raw as Record<string, unknown>;
	const versionUrl = normalizeProbeUrl(candidate.versionUrl);
	const appUrl = normalizeProbeUrl(candidate.appUrl);
	const appExpectText = normalizeExpectText(candidate.appExpectText);
	// All three or nothing. A target with a version URL and no app URL
	// would silently verify half of a deployment and report it as a pass.
	if (!versionUrl || !appUrl || !appExpectText) return null;
	// SAME SITE, added during the slice-AJ review.
	//
	// `confirming-failure` re-probes `versionUrl` to tell "the app is
	// broken" apart from "this node lost the internet", and that argument
	// only holds while the two URLs are about the same deployment. With
	// unrelated hosts the confirmation answers "can this node reach a
	// DIFFERENT hostname", which is not the question: an app host behind a
	// bot interstitial, an HTTP Basic wall or a DNS block would fail three
	// app probes, be "confirmed" by a healthy version host, and produce a
	// `failed` verdict — a revert offer against a release serving every
	// user correctly.
	//
	// The last two labels, not the full host: `api.ever.works` and
	// `app.ever.works` are the intended production pair and must keep
	// working. This does not make the two origins equivalent — a
	// per-subdomain WAF still defeats it — so the `failed` narration names
	// BOTH hosts and says so. It refuses the unrelated-host case outright,
	// which is the one this cannot reason about at all.
	if (siteOf(new URL(versionUrl).hostname) !== siteOf(new URL(appUrl).hostname)) return null;
	return { versionUrl, appUrl, appExpectText };
}

/**
 * Read a stored verification-target map, or `null` when it is not one.
 *
 * FAILS CLOSED per environment: an unusable `production` entry leaves
 * production with no target, which makes a production promotion
 * `unsupported` — reported to a human as NOT VERIFIED — rather than
 * verified against a half-configured URL.
 */
export function sanitizeReleaseVerificationTargets(raw: unknown): ReleaseVerificationTargets | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const candidate = raw as Record<string, unknown>;
	const staging = normalizeTarget(candidate.staging);
	const production = normalizeTarget(candidate.production);
	if (!staging && !production) return null;
	const result: { staging?: ReleaseVerificationTarget; production?: ReleaseVerificationTarget } = {};
	if (staging) result.staging = staging;
	if (production) result.production = production;
	return result;
}

/**
 * THE target resolution. One function, so nothing can verify a rung
 * against an environment it did not deploy.
 *
 * `null` when the Work has no usable target for the environment this rung
 * deploys — which is a legitimate, common state (most Works are not
 * deployed by this platform at all) and is reported as `unsupported`,
 * never as a pass.
 */
export function resolveReleaseVerificationTarget(
	targets: ReleaseVerificationTargets | null | undefined,
	rung: PromotionRung
): ReleaseVerificationTarget | null {
	const safe = sanitizeReleaseVerificationTargets(targets);
	if (!safe) return null;
	const environment = releaseEnvironmentForRung(rung);
	if (!environment) return null;
	return (environment === 'staging' ? safe.staging : safe.production) ?? null;
}

// ── The verdict vocabulary ───────────────────────────────────────────

/**
 * Where one promotion's post-deploy verification has got to.
 *
 * The three live states are also the three PROBES: which check runs is a
 * pure function of this value (see {@link releaseVerificationProbe}), so
 * there is no separate phase field that could disagree with the state.
 */
export type ReleaseVerifyState =
	/** Watching for the promoted commit to become the one being served. */
	| 'awaiting-rollout'
	/** The promoted commit IS being served; watching the app render. */
	| 'checking-app'
	/**
	 * The app check has failed enough times in a row to mean something.
	 * Re-reading the version endpoint before saying so, because "the app is
	 * broken" and "this node briefly lost the internet" are the same
	 * browser result, and only one of them is about the release.
	 */
	| 'confirming-failure'
	/** The promoted build served AND the app rendered. */
	| 'passed'
	/** The promoted build served AND the app did not, twice confirmed. */
	| 'failed'
	/**
	 * We did not find out. The rollout never arrived inside the budget, no
	 * node could run the check, the git provider would not name the
	 * deployed commit. NOT a pass, and NOT grounds for a revert offer.
	 */
	| 'inconclusive'
	/**
	 * Nothing to check against: this Work has no verification target for
	 * the environment this rung deploys. Recorded and reported rather than
	 * left blank, so "we did not verify" is a fact on the row instead of an
	 * absence somebody reads as fine.
	 */
	| 'unsupported';

export const RELEASE_VERIFY_STATES = [
	'awaiting-rollout',
	'checking-app',
	'confirming-failure',
	'passed',
	'failed',
	'inconclusive',
	'unsupported'
] as const satisfies readonly ReleaseVerifyState[];

export function isReleaseVerifyState(value: unknown): value is ReleaseVerifyState {
	return typeof value === 'string' && (RELEASE_VERIFY_STATES as readonly string[]).includes(value);
}

/** Is this verification over? */
export function isReleaseVerifyTerminal(state: ReleaseVerifyState | null | undefined): boolean {
	return state === 'passed' || state === 'failed' || state === 'inconclusive' || state === 'unsupported';
}

/**
 * Did the deployment verify?
 *
 * Written as an equality, exactly like `isPromotionGatePass`, so a state
 * added later is a not-a-pass by default and has to be argued INTO the
 * pass set by somebody editing this line.
 */
export function isReleaseVerifyPass(state: ReleaseVerifyState | null | undefined): boolean {
	return state === 'passed';
}

/**
 * May a revert be OFFERED for this verdict?
 *
 * `failed` and nothing else. In particular NOT `inconclusive`: offering to
 * undo a production release on the strength of a measurement that did not
 * happen is how a flapping check reverts a good release, and it is the
 * hazard this predicate exists to make unreachable. An operator who wants
 * to revert an inconclusive release can still do so by hand — they just
 * do not get told by the platform that they should.
 *
 * This answers "may we FILE an offer", never "may we revert". Nothing in
 * this platform reverts.
 */
export function isReleaseVerifyRevertOffered(state: ReleaseVerifyState | null | undefined): boolean {
	return state === 'failed';
}

// ── The probe ────────────────────────────────────────────────────────

/** Which check the current state runs. */
export interface ReleaseVerificationProbe {
	/** `rollout` reads the version endpoint; `app` reads the app page. */
	readonly phase: 'rollout' | 'app';
	readonly url: string;
	readonly expectText: string;
}

/**
 * Shortest commit sha accepted as a DOM expectation.
 *
 * A short sha is a substring match against a whole rendered document, and
 * the shorter it is the likelier it is to appear by accident. Twelve hex
 * characters is what the promotion lane already prints to humans and is
 * far past the point where a collision inside one page is plausible.
 */
export const RELEASE_VERIFY_SHA_EXPECT_LENGTH = 12;

/**
 * THE probe selection: which URL is loaded, and what must be in it.
 *
 * One function, taking the state and the target, so "the URL for the
 * environment that was actually promoted" has exactly one implementation
 * and the enqueue side cannot pick a different one from the operator
 * surface.
 *
 * `null` for every terminal state — a settled verification enqueues
 * nothing, which is half of why this lane cannot loop — and `null` for a
 * missing or malformed expected commit, because a probe with an empty
 * `expectText` asserts nothing and would return `ok: true` for any page
 * at all.
 */
export function releaseVerificationProbe(
	state: ReleaseVerifyState | null | undefined,
	target: ReleaseVerificationTarget | null | undefined,
	expectedSha: string | null | undefined
): ReleaseVerificationProbe | null {
	if (!target) return null;
	const sha = typeof expectedSha === 'string' ? expectedSha.trim().toLowerCase() : '';
	if (!/^[0-9a-f]{7,64}$/.test(sha)) return null;
	const shaExpect = sha.slice(0, RELEASE_VERIFY_SHA_EXPECT_LENGTH);
	switch (state) {
		case 'awaiting-rollout':
		// The failure confirmation re-runs the ROLLOUT probe on purpose.
		// The question it asks is not "is the app still broken" — we
		// already know that — but "can this node reach the environment at
		// all, and is the environment still serving the commit we
		// promoted". A `no` there means the evidence is about the network
		// or the node, not about the release.
		case 'confirming-failure':
			return { phase: 'rollout', url: target.versionUrl, expectText: shaExpect };
		case 'checking-app':
			return { phase: 'app', url: target.appUrl, expectText: target.appExpectText };
		default:
			return null;
	}
}

// ── Bounds. Every one of them is a stop, not a tuning knob. ──────────

/**
 * Consecutive rollout probes that must find the promoted commit before the
 * rollout counts as landed.
 *
 * ArgoCD replaces pods gradually, so immediately after a deploy the
 * version endpoint alternates between the old and the new commit depending
 * on which pod answers — sampling once is a coin flip. This is the same
 * discipline `.github/workflows/smoke-deployed.yml` already encodes for
 * the CI smoke lane ("5 consecutive samples"), at a much longer spacing.
 */
export const RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS = 3;

/**
 * Consecutive app-probe failures before the lane will even CONSIDER
 * calling a release broken — and it still re-confirms the rollout after
 * these before saying so.
 *
 * One failed page load is a transient. Filing a revert offer on one is the
 * "flapping check reverting a good release" failure this number exists to
 * prevent.
 */
export const RELEASE_VERIFY_FAILURE_CONFIRMATIONS = 3;

/** Spacing between probes. */
export const RELEASE_VERIFY_ATTEMPT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Hard cap on probes per promotion, whatever the clock says.
 *
 * The FIRST of the two bounds to be reached ends the verification, and
 * both of them end it as `inconclusive`. A cap counted in attempts
 * survives a clock that jumps; a deadline survives a sweep that runs far
 * more often than intended. Neither alone is enough, so there are two.
 */
export const RELEASE_VERIFY_MAX_ATTEMPTS = 48;

/**
 * Wall-clock budget from the moment the promotion merged.
 *
 * The production build lane (`k8s-build.yml`) is measured at 215–243
 * minutes on `main`, and ArgoCD's sync follows it, so anything under about
 * five hours would time out every real production release and report
 * `inconclusive` forever. Eight hours is that plus room, and it lines up
 * with {@link RELEASE_VERIFY_MAX_ATTEMPTS} at
 * {@link RELEASE_VERIFY_ATTEMPT_INTERVAL_MS} spacing so neither bound is
 * decorative.
 */
export const RELEASE_VERIFY_BUDGET_MS = 8 * 60 * 60 * 1000;

/** Per-probe navigation budget handed to the node. Clamped node-side to 300. */
export const RELEASE_VERIFY_PROBE_TIMEOUT_SEC = 60;

/**
 * Has this verification run out of road?
 *
 * FAILS CLOSED ON AN UNUSABLE CLOCK in the direction that keeps the lane
 * bounded: a deadline that cannot be read is treated as REACHED, so a row
 * with a corrupt timestamp settles `inconclusive` instead of probing for
 * ever. That is the opposite of `isPromotionGateDecisionOverdue`, which
 * fails closed by NOT filing a notice — and the difference is deliberate:
 * there, an unreadable clock must not produce a false alarm; here, it must
 * not produce an unbounded loop.
 */
export function isReleaseVerifyExhausted(
	attempts: number | null | undefined,
	deadlineAt: Date | string | number | null | undefined,
	now: Date
): boolean {
	const used = typeof attempts === 'number' && Number.isFinite(attempts) ? attempts : 0;
	if (used >= RELEASE_VERIFY_MAX_ATTEMPTS) return true;
	if (deadlineAt === null || deadlineAt === undefined) return true;
	const deadline = new Date(deadlineAt).getTime();
	if (!Number.isFinite(deadline)) return true;
	const at = now.getTime();
	if (!Number.isFinite(at)) return true;
	return at >= deadline;
}

// ── Enqueue identity ─────────────────────────────────────────────────

/**
 * The fleet job's idempotency key for one attempt.
 *
 * Deterministic in (promotion, attempt number) so that a sweep which dies
 * between enqueuing the job and recording its id re-enqueues the SAME key
 * on the following pass and is handed the same row back, rather than
 * putting a second browser on the same environment. `FleetJobService`
 * short-circuits on the key before it creates anything.
 *
 * It embeds a uuid, which matters: `FleetJobRepository.findByIdempotencyKey`
 * is not owner-scoped, so a guessable key would be a way to read back
 * somebody else's job. A promotion id is not guessable.
 */
export function releaseVerifyIdempotencyKey(promotionId: string, attempt: number): string {
	return `release-verify:${promotionId}:${attempt}`;
}

// ── The revert OFFER ─────────────────────────────────────────────────

/**
 * Present on every Task this lane files to offer a revert.
 *
 * A label, matching how a promotion Task is marked, and for the same
 * reason: the Task entity has no discriminator column and adding one for
 * two rows a week would touch every Task read in the product.
 *
 * A revert Task is deliberately an ORDINARY Task. It carries no
 * `release:promotion` label, so `ReleasePromotionService` answers
 * `not-a-promotion` for it, the promotion merge guard leaves it to the
 * ordinary path, and nothing about it can open a promotion — which is
 * what stops "a revert triggers a promotion that triggers another check"
 * from being a cycle. Landing whatever pull request it eventually produces
 * still needs the same `merge_pull_request` Inbox approval as everything
 * else.
 */
export const RELEASE_REVERT_TASK_LABEL = 'release:revert';

/** Per-rung revert label, e.g. `release:revert:stage-to-main`. */
export function releaseRevertRungLabel(rung: PromotionRung): string {
	return `${RELEASE_REVERT_TASK_LABEL}:${rung}`;
}

/** The labels a revert-offer Task is filed with. */
export function releaseRevertTaskLabels(rung: PromotionRung): string[] {
	return [RELEASE_REVERT_TASK_LABEL, releaseRevertRungLabel(rung)];
}

/** Is this Task a revert offer? */
export function isReleaseRevertTask(labels: readonly string[] | null | undefined): boolean {
	return Array.isArray(labels) && labels.includes(RELEASE_REVERT_TASK_LABEL);
}

/**
 * Which rung a revert Task undoes, or `null` if it is not a revert Task.
 *
 * Added during the slice-AJ review, and it is an AUTHORIZATION input, not
 * a display value. A revert Task's pull request lands on the branch the
 * promotion landed on — `stage` or `main` — while every other Task pull
 * request on this platform targets the Work's `taskIsolationBaseBranch`.
 * The merge gate needs the rung to resolve the real base from the Work's
 * ladder, because that base is (a) what the protected-branch rule is
 * evaluated against and (b) the branch named in the sentence the
 * approving human reads. Computed from the Task's own labels so the
 * answer does not depend on the promotion row still being readable.
 */
export function releaseRevertRungFromLabels(labels: readonly string[] | null | undefined): PromotionRung | null {
	if (!isReleaseRevertTask(labels)) return null;
	// `PROMOTION_RUNGS` rather than a restated list, so a rung added to
	// the ladder cannot become a revert the merge gate silently fails to
	// recognise — which would fall back to the Work's isolation base.
	for (const rung of PROMOTION_RUNGS) {
		if (labels!.includes(releaseRevertRungLabel(rung))) return rung;
	}
	return null;
}

// ── What a PASS is entitled to claim ─────────────────────────────────

/**
 * How much a green app probe actually proves about the promoted artefact.
 *
 *   - `artefact` — the app expectation contains the promoted commit, so a
 *     pass means the NEW build rendered.
 *   - `liveness` — the app expectation is a fixed string (the shipped
 *     `"status":"OK"` health probe is one), so a pass means the app
 *     answered. An old bundle that never rolled out answers it
 *     identically.
 *
 * Added during the slice-AJ review because the verdict overclaimed: the
 * artefact identity is established at `versionUrl` only, the app phase
 * then reads a DIFFERENT url with a static expectation, and nothing
 * requires the two deployments to roll out together. The API image can
 * publish while the web deployment fails its rollout entirely, and the
 * lane would still have filed "Deployment VERIFIED … Nothing further is
 * required". It now says which of the two it measured.
 */
export type ReleaseVerifyAppProof = 'artefact' | 'liveness';

export function releaseVerifyAppProof(
	target: ReleaseVerificationTarget | null | undefined,
	expectedSha: string | null | undefined
): ReleaseVerifyAppProof {
	if (!target) return 'liveness';
	const sha = typeof expectedSha === 'string' ? expectedSha.trim().toLowerCase() : '';
	if (!/^[0-9a-f]{7,64}$/.test(sha)) return 'liveness';
	const shaExpect = sha.slice(0, RELEASE_VERIFY_SHA_EXPECT_LENGTH);
	return target.appExpectText.toLowerCase().includes(shaExpect) ? 'artefact' : 'liveness';
}

// ── Reading one browser check back ───────────────────────────────────

/**
 * Did a `browser-check` PASS?
 *
 * THE trust boundary, and deliberately one function: the completion
 * listener and the sweep's own reconciliation of an in-flight job both
 * ask it, and a lane where those two disagreed could report a check green
 * on one path and red on the other for the same row.
 *
 * `result` is whatever a node PUT on the completion endpoint — untrusted
 * data from somebody's PC — so this narrows to a strict `=== true` on a
 * `done` job and nothing else is allowed to mean "pass": a `failed` job,
 * a cancelled one, a lease the reclaim sweep exhausted, a queue-SLA
 * expiry, a result with no `ok`, `ok: "true"`, `ok: 1`, `ok: {}`. Every
 * ambiguity resolves to "not a pass", because a false negative at worst
 * settles a verification `inconclusive` — which offers nothing and
 * reverts nothing — while a false positive tells a human that a broken
 * production deployment is healthy.
 */
export function isReleaseVerifyCheckPass(status: unknown, result: unknown): boolean {
	if (status !== 'done') return false;
	if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
	return (result as { ok?: unknown }).ok === true;
}
