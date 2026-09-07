import { describe, expect, it } from 'vitest';

import {
	RELEASE_ENVIRONMENTS,
	RELEASE_REVERT_TASK_LABEL,
	RELEASE_VERIFY_ATTEMPT_INTERVAL_MS,
	RELEASE_VERIFY_BUDGET_MS,
	RELEASE_VERIFY_EXPECT_MIN_LENGTH,
	RELEASE_VERIFY_FAILURE_CONFIRMATIONS,
	RELEASE_VERIFY_MAX_ATTEMPTS,
	RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS,
	RELEASE_VERIFY_SHA_EXPECT_LENGTH,
	RELEASE_VERIFY_STATES,
	isReleaseRevertTask,
	isReleaseVerifyCheckPass,
	isReleaseVerifyExhausted,
	isReleaseVerifyPass,
	isReleaseVerifyRevertOffered,
	isReleaseVerifyState,
	isReleaseVerifyTerminal,
	releaseEnvironmentForRung,
	releaseRevertRungFromLabels,
	releaseRevertTaskLabels,
	releaseVerificationProbe,
	releaseVerifyAppProof,
	releaseVerifyIdempotencyKey,
	resolveReleaseVerificationTarget,
	sanitizeReleaseVerificationTargets,
	type ReleaseVerifyState
} from '../deployment-verification.types.js';
import { PROMOTION_TASK_LABEL } from '../promotion.types.js';

const STAGING = {
	versionUrl: 'https://apistage.ever.works/api/version',
	appUrl: 'https://appstage.ever.works/api/health',
	appExpectText: '"status":"OK"'
};
const PRODUCTION = {
	versionUrl: 'https://api.ever.works/api/version',
	appUrl: 'https://app.ever.works/api/health',
	appExpectText: '"status":"OK"'
};
const TARGETS = { staging: STAGING, production: PRODUCTION };
const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

describe('releaseEnvironmentForRung — the rung deploys its BASE', () => {
	it('maps develop-to-stage onto staging, not production', () => {
		// THE mistake this mapping exists to make impossible: merging
		// `develop -> stage` deploys STAGE. A check pointed at production
		// would pass against a deployment the promotion never touched.
		expect(releaseEnvironmentForRung('develop-to-stage')).toBe('staging');
	});

	it('maps stage-to-main onto production', () => {
		expect(releaseEnvironmentForRung('stage-to-main')).toBe('production');
	});

	it('refuses an unknown rung rather than guessing production', () => {
		expect(releaseEnvironmentForRung('develop-to-main' as never)).toBeNull();
	});

	it('covers every declared environment', () => {
		expect(RELEASE_ENVIRONMENTS).toEqual(['staging', 'production']);
	});
});

describe('sanitizeReleaseVerificationTargets', () => {
	it('accepts a well-formed map', () => {
		expect(sanitizeReleaseVerificationTargets(TARGETS)).toEqual(TARGETS);
	});

	it.each([
		['null', null],
		['undefined', undefined],
		['an array', [STAGING]],
		['a string', 'https://app.ever.works'],
		['an empty object', {}]
	])('refuses %s', (_label, value) => {
		expect(sanitizeReleaseVerificationTargets(value)).toBeNull();
	});

	it('drops ONE unusable environment without poisoning the other', () => {
		// Fail closed PER ENVIRONMENT: a broken production entry must not
		// take staging down with it, and must not survive as a half-target.
		const result = sanitizeReleaseVerificationTargets({
			staging: STAGING,
			production: { ...PRODUCTION, appUrl: 'http://app.ever.works' }
		});
		expect(result).toEqual({ staging: STAGING });
		expect(result?.production).toBeUndefined();
	});

	describe('URL refusals', () => {
		it.each([
			['plain http — a verdict forgeable in transit', 'http://api.ever.works/api/version'],
			['embedded credentials', 'https://user:pass@api.ever.works/api/version'],
			['an IPv4 literal', 'https://169.254.169.254/api/version'],
			['a private IPv4 literal', 'https://10.0.0.1/api/version'],
			['bracketed IPv6', 'https://[::1]/api/version'],
			['a single-label host', 'https://localhost/api/version'],
			['a bare service name', 'https://metadata/api/version'],
			['a file URL', 'file:///etc/passwd'],
			['a fragment', 'https://api.ever.works/api/version#x'],
			['nonsense', 'not-a-url']
		])('refuses %s', (_label, versionUrl) => {
			expect(sanitizeReleaseVerificationTargets({ production: { ...PRODUCTION, versionUrl } })).toBeNull();
		});
	});

	describe('expectation refusals', () => {
		it('refuses an expectation shorter than the minimum', () => {
			// A short expectation is satisfied by almost any HTML document,
			// including a provider error page.
			expect(
				sanitizeReleaseVerificationTargets({ production: { ...PRODUCTION, appExpectText: 'O' } })
			).toBeNull();
			expect(RELEASE_VERIFY_EXPECT_MIN_LENGTH).toBeGreaterThan(1);
		});

		it.each([
			['div', 'the commonest tag name in HTML'],
			['<html>', 'the document element'],
			['<html><head', 'eleven characters, and in every page ever served'],
			['<!doctype', 'the prologue'],
			['</body></html>', 'the end of every document'],
			['<span></span>', 'an empty inline element'],
			['DIV></DIV', 'the same, shouted']
		])('refuses %s — %s', (appExpectText) => {
			// THE guard the minimum length was documented as providing and
			// did not. The node matches with a raw `dom.includes(expectText)`
			// against the serialized document, so any slice of a bare page
			// skeleton is a check that always passes — including against
			// Chrome's own network-error page and a CDN 502 interstitial,
			// both of which exit 0 under `--dump-dom` with a NON-empty
			// document, so the executor's empty-document guard misses them
			// too. Three characters (the old minimum) refused none of these.
			expect(sanitizeReleaseVerificationTargets({ production: { ...PRODUCTION, appExpectText } })).toBeNull();
		});

		it('accepts an expectation that says something about THIS app', () => {
			// The negative control: the guard must not refuse real
			// expectations. Both of these are configurations the runbook
			// recommends.
			for (const appExpectText of ['"status":"OK"', 'a1b2c3d4e5f6', 'Ever Works directory']) {
				expect(
					sanitizeReleaseVerificationTargets({ production: { ...PRODUCTION, appExpectText } })
				).not.toBeNull();
			}
		});

		it('refuses a missing expectation rather than checking nothing', () => {
			expect(
				sanitizeReleaseVerificationTargets({
					production: { versionUrl: PRODUCTION.versionUrl, appUrl: PRODUCTION.appUrl }
				})
			).toBeNull();
		});

		it('refuses an over-long expectation', () => {
			expect(
				sanitizeReleaseVerificationTargets({ production: { ...PRODUCTION, appExpectText: 'x'.repeat(201) } })
			).toBeNull();
		});
	});

	describe('the two URLs must be about the same deployment', () => {
		it('refuses a target whose app and version URLs are unrelated hosts', () => {
			// `confirming-failure` re-probes `versionUrl` to tell "the app is
			// broken" apart from "this node lost the internet" — and that
			// argument only holds while the two URLs are about the same
			// deployment. With unrelated hosts the confirmation answers "can
			// this node reach a DIFFERENT hostname", which is not the
			// question: an app host behind a bot interstitial, an HTTP Basic
			// wall or a DNS block fails three app probes, is "confirmed" by a
			// healthy version host, and produces a `failed` verdict — a
			// revert offer against a release serving every user correctly.
			expect(
				sanitizeReleaseVerificationTargets({
					production: { ...PRODUCTION, appUrl: 'https://status.example.com/health' }
				})
			).toBeNull();
		});

		it('accepts the intended production pair, which differ only by subdomain', () => {
			// `api.ever.works` + `app.ever.works`, and the staging pair. The
			// rule must not break the configuration the runbook recommends.
			expect(sanitizeReleaseVerificationTargets(TARGETS)).toEqual(TARGETS);
		});

		it('fails CLOSED per environment, so one unrelated pair does not verify anything', () => {
			const result = sanitizeReleaseVerificationTargets({
				staging: STAGING,
				production: { ...PRODUCTION, appUrl: 'https://elsewhere.example.com/health' }
			});
			expect(result).toEqual({ staging: STAGING });
		});
	});

	it('refuses a target missing its app URL — half a deployment is not a pass', () => {
		expect(
			sanitizeReleaseVerificationTargets({
				production: { versionUrl: PRODUCTION.versionUrl, appExpectText: '"status":"OK"' }
			})
		).toBeNull();
	});
});

describe('resolveReleaseVerificationTarget', () => {
	it('resolves the environment the rung actually deployed', () => {
		expect(resolveReleaseVerificationTarget(TARGETS, 'develop-to-stage')).toEqual(STAGING);
		expect(resolveReleaseVerificationTarget(TARGETS, 'stage-to-main')).toEqual(PRODUCTION);
	});

	it('answers null when the rung’s environment has no target', () => {
		expect(resolveReleaseVerificationTarget({ staging: STAGING }, 'stage-to-main')).toBeNull();
	});

	it.each([
		['no targets at all', null],
		['an unusable blob', { production: 'https://app.ever.works' }]
	])('answers null for %s', (_label, targets) => {
		expect(resolveReleaseVerificationTarget(targets as never, 'stage-to-main')).toBeNull();
	});
});

describe('the verdict vocabulary', () => {
	it('pins the seven states', () => {
		expect(RELEASE_VERIFY_STATES).toEqual([
			'awaiting-rollout',
			'checking-app',
			'confirming-failure',
			'passed',
			'failed',
			'inconclusive',
			'unsupported'
		]);
	});

	it('treats only `passed` as a pass', () => {
		// Written as an equality so a state added later is a not-a-pass by
		// default. Every other state, INCLUDING the ones that sound benign,
		// must be false here.
		for (const state of RELEASE_VERIFY_STATES) {
			expect(isReleaseVerifyPass(state)).toBe(state === 'passed');
		}
		expect(isReleaseVerifyPass(null)).toBe(false);
		expect(isReleaseVerifyPass(undefined)).toBe(false);
		expect(isReleaseVerifyPass('unsupported')).toBe(false);
		expect(isReleaseVerifyPass('inconclusive')).toBe(false);
	});

	it('offers a revert for `failed` and for NOTHING else', () => {
		// THE constraint. An inconclusive verdict is not a pass and is not a
		// revert either: you cannot responsibly offer to undo a release on
		// the strength of a measurement you failed to take.
		for (const state of RELEASE_VERIFY_STATES) {
			expect(isReleaseVerifyRevertOffered(state)).toBe(state === 'failed');
		}
		expect(isReleaseVerifyRevertOffered(null)).toBe(false);
	});

	it('knows which states are over', () => {
		const terminal: ReleaseVerifyState[] = ['passed', 'failed', 'inconclusive', 'unsupported'];
		for (const state of RELEASE_VERIFY_STATES) {
			expect(isReleaseVerifyTerminal(state)).toBe(terminal.includes(state));
		}
		expect(isReleaseVerifyTerminal(null)).toBe(false);
	});

	it('narrows a value off a column', () => {
		expect(isReleaseVerifyState('passed')).toBe(true);
		expect(isReleaseVerifyState('PASSED')).toBe(false);
		expect(isReleaseVerifyState(null)).toBe(false);
		expect(isReleaseVerifyState('green')).toBe(false);
	});
});

describe('releaseVerificationProbe — THE URL selection', () => {
	it('probes the version endpoint for the promoted commit while awaiting rollout', () => {
		expect(releaseVerificationProbe('awaiting-rollout', PRODUCTION, SHA)).toEqual({
			phase: 'rollout',
			url: PRODUCTION.versionUrl,
			expectText: SHA.slice(0, RELEASE_VERIFY_SHA_EXPECT_LENGTH)
		});
	});

	it('probes the app page once the rollout is confirmed', () => {
		expect(releaseVerificationProbe('checking-app', PRODUCTION, SHA)).toEqual({
			phase: 'app',
			url: PRODUCTION.appUrl,
			expectText: PRODUCTION.appExpectText
		});
	});

	it('re-probes the VERSION endpoint when confirming a failure', () => {
		// The confirmation asks "can this node still reach the environment,
		// and is it still serving what we promoted" — not "is the app still
		// broken". A node that lost its network answers no here, and that is
		// evidence about the node, not about the release.
		expect(releaseVerificationProbe('confirming-failure', PRODUCTION, SHA)?.phase).toBe('rollout');
	});

	it.each(['passed', 'failed', 'inconclusive', 'unsupported'] as const)(
		'enqueues nothing in the terminal state %s',
		(state) => {
			expect(releaseVerificationProbe(state, PRODUCTION, SHA)).toBeNull();
		}
	);

	it('refuses to probe with no target', () => {
		expect(releaseVerificationProbe('awaiting-rollout', null, SHA)).toBeNull();
	});

	it.each([
		['a missing commit', null],
		['an empty commit', '   '],
		['a non-hex commit', 'zzzzzzzzzzzz'],
		['a commit too short to be one', 'a1b2c3']
	])('refuses to probe with %s — an empty expectation asserts nothing', (_label, sha) => {
		expect(releaseVerificationProbe('awaiting-rollout', PRODUCTION, sha)).toBeNull();
	});

	it('shortens the commit rather than demanding the whole 40 characters', () => {
		// The rendered document carries whatever length the service stamped;
		// a fixed 12-character prefix is what both ends agree to look for.
		const probe = releaseVerificationProbe('awaiting-rollout', PRODUCTION, SHA.toUpperCase());
		expect(probe?.expectText).toBe(SHA.slice(0, 12));
	});
});

describe('isReleaseVerifyExhausted — the two independent stops', () => {
	const now = new Date('2026-09-06T12:00:00.000Z');
	const future = new Date('2026-09-06T20:00:00.000Z');

	it('keeps going inside both bounds', () => {
		expect(isReleaseVerifyExhausted(1, future, now)).toBe(false);
	});

	it('stops on the attempt cap even with time left', () => {
		expect(isReleaseVerifyExhausted(RELEASE_VERIFY_MAX_ATTEMPTS, future, now)).toBe(true);
	});

	it('stops on the deadline even with attempts left', () => {
		expect(isReleaseVerifyExhausted(1, new Date('2026-09-06T11:59:59.000Z'), now)).toBe(true);
	});

	it.each([
		['a missing deadline', null],
		['an undefined deadline', undefined],
		['an unparseable deadline', 'not-a-date']
	])('treats %s as exhausted, so an unusable clock cannot loop for ever', (_label, deadline) => {
		expect(isReleaseVerifyExhausted(1, deadline as never, now)).toBe(true);
	});

	it('treats an unusable NOW as exhausted too', () => {
		expect(isReleaseVerifyExhausted(1, future, new Date(Number.NaN))).toBe(true);
	});

	it('lines the two bounds up so neither is decorative', () => {
		expect(RELEASE_VERIFY_MAX_ATTEMPTS * RELEASE_VERIFY_ATTEMPT_INTERVAL_MS).toBe(RELEASE_VERIFY_BUDGET_MS);
	});

	it('leaves room for the measured production build lane', () => {
		// `k8s-build.yml` is measured at 215–243 minutes on `main`, and
		// ArgoCD's sync follows it. A budget under that would report
		// `inconclusive` for every real production release.
		expect(RELEASE_VERIFY_BUDGET_MS).toBeGreaterThan(243 * 60 * 1000);
	});
});

describe('the confirmation counts', () => {
	it('requires more than one rollout sample, because pods roll gradually', () => {
		expect(RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS).toBeGreaterThan(1);
	});

	it('requires more than one failure before even considering a revert offer', () => {
		expect(RELEASE_VERIFY_FAILURE_CONFIRMATIONS).toBeGreaterThan(1);
	});
});

describe('releaseVerifyIdempotencyKey', () => {
	it('is deterministic in (promotion, attempt)', () => {
		expect(releaseVerifyIdempotencyKey('p-1', 3)).toBe('release-verify:p-1:3');
		expect(releaseVerifyIdempotencyKey('p-1', 3)).toBe(releaseVerifyIdempotencyKey('p-1', 3));
	});

	it('separates attempts, so a retry is a NEW job and not a silent no-op', () => {
		expect(releaseVerifyIdempotencyKey('p-1', 3)).not.toBe(releaseVerifyIdempotencyKey('p-1', 4));
	});

	it('separates promotions', () => {
		expect(releaseVerifyIdempotencyKey('p-1', 3)).not.toBe(releaseVerifyIdempotencyKey('p-2', 3));
	});
});

describe('the revert offer is an ordinary Task', () => {
	it('labels it as a revert', () => {
		expect(releaseRevertTaskLabels('stage-to-main')).toEqual(['release:revert', 'release:revert:stage-to-main']);
		expect(isReleaseRevertTask(releaseRevertTaskLabels('stage-to-main'))).toBe(true);
	});

	it('does NOT label it a promotion — that is what stops the cycle', () => {
		// A revert Task that carried `release:promotion` would be picked up
		// by the promotion refresh and the promotion merge guard, and a
		// revert that opened a promotion would trigger another verification
		// which could offer another revert.
		expect(releaseRevertTaskLabels('stage-to-main')).not.toContain(PROMOTION_TASK_LABEL);
		expect(RELEASE_REVERT_TASK_LABEL).not.toBe(PROMOTION_TASK_LABEL);
		expect(RELEASE_REVERT_TASK_LABEL.startsWith(PROMOTION_TASK_LABEL)).toBe(false);
	});

	it.each([
		['no labels', null],
		['empty labels', []],
		['a promotion Task', [PROMOTION_TASK_LABEL]]
	])('does not recognise %s as a revert offer', (_label, labels) => {
		expect(isReleaseRevertTask(labels as never)).toBe(false);
	});
});

describe('releaseRevertRungFromLabels — which release a revert undoes', () => {
	it('reads the rung a revert Task was filed with', () => {
		// An AUTHORIZATION input, not a display value: the merge gate
		// resolves the revert's base branch from this plus the Work's
		// ladder, and that base is what the protected-branch rule is
		// evaluated against and what the approving human reads.
		expect(releaseRevertRungFromLabels(releaseRevertTaskLabels('stage-to-main'))).toBe('stage-to-main');
		expect(releaseRevertRungFromLabels(releaseRevertTaskLabels('develop-to-stage'))).toBe('develop-to-stage');
	});

	it.each([
		['a promotion Task', [PROMOTION_TASK_LABEL, 'release:promotion:stage-to-main']],
		['an ordinary Task', ['chore']],
		['a revert Task whose rung label was lost', [RELEASE_REVERT_TASK_LABEL]],
		['no labels', null]
	])('answers null for %s, so the caller must refuse rather than guess', (_label, labels) => {
		expect(releaseRevertRungFromLabels(labels as never)).toBeNull();
	});
});

describe('releaseVerifyAppProof — what a green app probe is entitled to claim', () => {
	it('is `liveness` for a fixed health string, which an OLD build answers identically', () => {
		// The shipped recommendation. The artefact identity is established
		// at `versionUrl`; this expectation carries no commit, so a web
		// deployment that never rolled out satisfies it.
		expect(releaseVerifyAppProof(PRODUCTION, SHA)).toBe('liveness');
	});

	it('is `artefact` when the app expectation carries the promoted commit', () => {
		expect(releaseVerifyAppProof({ ...PRODUCTION, appExpectText: SHA.slice(0, 12) }, SHA)).toBe('artefact');
		expect(releaseVerifyAppProof({ ...PRODUCTION, appExpectText: `build ${SHA.slice(0, 12)} live` }, SHA)).toBe(
			'artefact'
		);
	});

	it.each([
		['no target', null, SHA],
		['no expected commit', PRODUCTION, null],
		['an expected commit that is not one', PRODUCTION, 'not-a-sha'],
		['a DIFFERENT commit in the expectation', { ...PRODUCTION, appExpectText: 'ffffffffffff' }, SHA]
	])('claims the weaker thing for %s', (_label, target, sha) => {
		expect(releaseVerifyAppProof(target as never, sha as never)).toBe('liveness');
	});
});

describe('isReleaseVerifyCheckPass — the trust boundary, in ONE place', () => {
	it('passes only a done job with an explicit ok: true', () => {
		expect(isReleaseVerifyCheckPass('done', { ok: true })).toBe(true);
	});

	it.each([
		['a failed job that reported ok', 'failed', { ok: true }],
		['a queued job', 'queued', { ok: true }],
		['a leased job', 'leased', { ok: true }],
		['a done job with no result', 'done', null],
		['a done job with an undefined result', 'done', undefined],
		['ok as the STRING true', 'done', { ok: 'true' }],
		['ok as 1', 'done', { ok: 1 }],
		['ok as an object', 'done', { ok: {} }],
		['a result that is an array', 'done', [{ ok: true }]],
		['a result that is a string', 'done', 'ok'],
		['no status at all', undefined, { ok: true }]
	])('does not pass %s', (_label, status, result) => {
		// Every ambiguity resolves to "not a pass". A false negative at
		// worst settles a verification `inconclusive`, which offers nothing
		// and reverts nothing; a false positive tells a human that a broken
		// production deployment is healthy.
		expect(isReleaseVerifyCheckPass(status, result)).toBe(false);
	});
});

describe('the surface offers no way to revert', () => {
	it('exports nothing that performs, merges or applies a revert', async () => {
		// THE load-bearing absence, in the same shape as slice AI's
		// no-cascade guard. A revert is an OFFER a human reads. If a future
		// edit adds `applyRevert`, `performRevert` or `mergeRevert` here,
		// this fails and the author has to argue for a platform that can
		// undo production on its own.
		const surface = Object.keys(await import('../index.js'));
		const actors = surface.filter((name) =>
			/^(apply|perform|execute|do|run|trigger|merge|deploy|rollback)/i.test(name)
		);
		expect(actors).toEqual([]);
		expect(surface.filter((name) => /revert/i.test(name)).sort()).toEqual([
			'RELEASE_REVERT_TASK_LABEL',
			'isReleaseRevertTask',
			'isReleaseVerifyRevertOffered',
			'releaseRevertRungFromLabels',
			'releaseRevertRungLabel',
			'releaseRevertTaskLabels'
		]);
	});
});
