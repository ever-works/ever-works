import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GitProviderErrorReason } from '@ever-works/plugin/git';
import { GitProviderRequestError } from '@ever-works/plugin/git';

/**
 * APW-02 T16 — every row of plan §4.2's GitHub error table (ACC-02-16).
 *
 * The table is the whole specification of this file: 401, the primary rate limit
 * (`x-ratelimit-remaining: 0` + its reset instant), the secondary rate limit
 * (`retry-after`, or GitHub's own wording, and the 422 "too quickly" variant),
 * the two organization-policy refusals (SAML, OAuth App restrictions), the
 * missing-permission refusal, and the plain 404 / 409 / 422. Two rows the table
 * does NOT have — a 5xx and a transport failure — are pinned here as well, so the
 * documented fallback cannot drift into a destructive reason unnoticed.
 *
 * Octokit is mocked, exactly as the sibling `github-api.service.*.spec.ts` suites
 * do, so nothing here can reach the network.
 */

vi.mock('octokit', () => {
	class FakeRequestError extends Error {
		status: number;
		response?: { data?: unknown; headers?: Record<string, string | number> };

		constructor(
			message: string,
			status: number,
			response?: { data?: unknown; headers?: Record<string, string | number> }
		) {
			super(message);
			this.status = status;
			this.response = response;
		}
	}

	return {
		Octokit: class FakeOctokit {},
		RequestError: FakeRequestError
	};
});

const { RequestError } = await import('octokit');
const { toGitProviderError } = await import('../github-errors.js');

/** 2026-09-17T12:00:00.000Z — one fixed instant for every `retryAt` assertion. */
const NOW_MS = 1789646400 * 1000;

type ErrorHeaders = Record<string, string | number>;

/**
 * A `RequestError` shaped the way Octokit actually raises one: an HTTP status, a
 * body carrying `message`, and the response headers. `bodyMessage` defaults to the
 * error message, which is what Octokit does for an API error.
 */
function apiError(status: number, message: string, headers: ErrorHeaders = {}, bodyMessage = message): Error {
	const ctor = RequestError as unknown as new (
		message: string,
		status: number,
		response: { data: unknown; headers: ErrorHeaders }
	) => Error;
	return new ctor(message, status, { data: { message: bodyMessage }, headers });
}

/** Classify and assert the row; returns the mapped error for detail assertions. */
function classify(error: unknown, permissionHint?: Parameters<typeof toGitProviderError>[1]) {
	const mapped = toGitProviderError(error, permissionHint);
	expect(mapped).toBeInstanceOf(GitProviderRequestError);
	expect(mapped).toBeInstanceOf(Error);
	return mapped;
}

function expectReason(error: unknown, reason: GitProviderErrorReason, status: number) {
	const mapped = classify(error);
	expect(mapped.reason).toBe(reason);
	expect(mapped.status).toBe(status);
	return mapped;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW_MS));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('APW-02 T16 — plan §4.2 row: 401 unauthorized', () => {
	it('maps a 401 to unauthorized, with no invented details', () => {
		const mapped = expectReason(apiError(401, 'Bad credentials'), 'unauthorized', 401);

		expect(mapped.details).toEqual({});
	});
});

describe('APW-02 T16 — plan §4.2 row: primary rate limit (`x-ratelimit-remaining: 0`)', () => {
	it('maps a 403 with a spent budget to rate_limited at the reset instant', () => {
		const mapped = expectReason(
			apiError(403, 'API rate limit exceeded', {
				'x-ratelimit-remaining': '0',
				'x-ratelimit-reset': '1789647300'
			}),
			'rate_limited',
			403
		);

		// The provider's own reset instant — NOT `now + 60 s` (ACC-02-16).
		expect(mapped.details.retryAt).toBe('2026-09-17T12:15:00.000Z');
	});

	it('maps a 429 with a spent budget the same way', () => {
		const mapped = expectReason(
			apiError(429, 'API rate limit exceeded', {
				'x-ratelimit-remaining': '0',
				'x-ratelimit-reset': '1767225600'
			}),
			'rate_limited',
			429
		);

		expect(mapped.details.retryAt).toBe('2026-01-01T00:00:00.000Z');
	});

	it('stays rate_limited (with no retryAt) when the reset header is missing or unusable', () => {
		for (const headers of [
			{ 'x-ratelimit-remaining': '0' },
			{ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'not-a-number' },
			{ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' }
		] satisfies ErrorHeaders[]) {
			const mapped = expectReason(apiError(403, 'API rate limit exceeded', headers), 'rate_limited', 403);

			// An absent reset is reported as absent, never as a guessed delay.
			expect(mapped.details).toEqual({});
		}
	});

	it('reads the headers case-insensitively', () => {
		const mapped = expectReason(
			apiError(403, 'API rate limit exceeded', {
				'X-RateLimit-Remaining': '0',
				'X-RateLimit-Reset': '1767225600'
			}),
			'rate_limited',
			403
		);

		expect(mapped.details.retryAt).toBe('2026-01-01T00:00:00.000Z');
	});

	it('prefers the primary row when a 403 signals both limits at once', () => {
		const mapped = expectReason(
			apiError(403, 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.', {
				'x-ratelimit-remaining': '0',
				'x-ratelimit-reset': '1789647300',
				'retry-after': '60'
			}),
			'rate_limited',
			403
		);

		// The reset instant, not now + retry-after: the primary budget is the
		// stronger answer and the row §4.2 lists first.
		expect(mapped.details.retryAt).toBe('2026-09-17T12:15:00.000Z');
	});
});

describe('APW-02 T16 — plan §4.2 row: secondary rate limit', () => {
	it('maps a 403 carrying retry-after to secondary_rate_limited at now + retry-after', () => {
		const mapped = expectReason(apiError(403, 'Forbidden', { 'retry-after': '60' }), 'secondary_rate_limited', 403);

		expect(mapped.details.retryAt).toBe('2026-09-17T12:01:00.000Z');
	});

	it('maps a 429 carrying retry-after the same way', () => {
		const mapped = expectReason(
			apiError(429, 'Too many requests', { 'retry-after': '30' }),
			'secondary_rate_limited',
			429
		);

		expect(mapped.details.retryAt).toBe('2026-09-17T12:00:30.000Z');
	});

	it('maps GitHub’s own wording with no retry-after to secondary_rate_limited with NO retryAt', () => {
		const mapped = expectReason(
			apiError(403, 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'),
			'secondary_rate_limited',
			403
		);

		// FR-51 owns the delay when GitHub names none (60 s doubling) — inventing
		// one here would hide that fallback.
		expect(mapped.details).toEqual({});
	});

	it('maps a 422 "too quickly" refusal to secondary_rate_limited', () => {
		const mapped = expectReason(
			apiError(422, 'You are creating repositories too quickly. Please wait a moment before trying again.'),
			'secondary_rate_limited',
			422
		);

		expect(mapped.status).toBe(422);
	});

	it('maps a 422 mentioning the secondary rate limit to secondary_rate_limited', () => {
		const mapped = expectReason(
			apiError(422, 'You have exceeded a secondary rate limit and have been temporarily blocked.'),
			'secondary_rate_limited',
			422
		);

		expect(mapped.reason).toBe('secondary_rate_limited');
	});
});

describe('APW-02 T16 — plan §4.2 row: organization policy refusals', () => {
	it('maps a 403 SAML refusal to sso_authorization_required', () => {
		const mapped = expectReason(
			apiError(
				403,
				'Resource protected by organization SAML enforcement. You must grant your personal access token access to this organization.'
			),
			'sso_authorization_required',
			403
		);

		expect(mapped.details).toEqual({});
	});

	it('maps a 403 OAuth App restriction to oauth_app_restricted', () => {
		expectReason(
			apiError(
				403,
				'Although you appear to have the correct authorization credentials, the `ever-works` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.'
			),
			'oauth_app_restricted',
			403
		);
	});

	it('keeps the two policy refusals apart — they are different operator actions', () => {
		const saml = toGitProviderError(apiError(403, 'Resource protected by organization SAML enforcement.'));
		const oauth = toGitProviderError(apiError(403, 'This organization has enabled OAuth App access restrictions.'));

		expect(saml.reason).not.toBe(oauth.reason);
	});
});

describe('APW-02 T16 — plan §4.2 row: missing permission', () => {
	it('maps an App-installation refusal to permission_missing with the permission the call needed', () => {
		const mapped = classify(apiError(403, 'Resource not accessible by integration'), 'actions');

		expect(mapped.reason).toBe('permission_missing');
		expect(mapped.status).toBe(403);
		expect(mapped.details).toEqual({ permission: 'actions' });
	});

	it('maps a fine-grained PAT refusal the same way', () => {
		const mapped = classify(apiError(403, 'Resource not accessible by personal access token'), 'administration');

		expect(mapped.reason).toBe('permission_missing');
		expect(mapped.details).toEqual({ permission: 'administration' });
	});

	it('names no permission when the calling method named none', () => {
		const mapped = expectReason(apiError(403, 'Resource not accessible by integration'), 'permission_missing', 403);

		expect(mapped.details).toEqual({});
	});

	it('never upgrades an unfamiliar 403 into permission_missing on the strength of a hint', () => {
		// The hint names what the CALLER needed; it is not evidence that this
		// refusal was about that permission.
		const mapped = expectReason(apiError(403, 'Forbidden'), 'unprocessable', 403);

		expect(mapped.details).toEqual({});
	});
});

describe('APW-02 T16 — plan §4.2 row: plain statuses', () => {
	it('maps 404 / 409 / 422 to not_found / conflict / unprocessable', () => {
		expectReason(apiError(404, 'Not Found'), 'not_found', 404);
		expectReason(apiError(409, 'Git Repository is empty.'), 'conflict', 409);
		expectReason(apiError(422, 'Validation Failed'), 'unprocessable', 422);
	});

	it('keeps the provider status on the mapped error, so `err.status` checks keep working', () => {
		for (const status of [401, 403, 404, 409, 422, 429]) {
			expect(toGitProviderError(apiError(status, `HTTP ${status}`)).status).toBe(status);
		}
	});
});

describe('APW-02 T16 — the rows plan §4.2 does not have', () => {
	it('degrades a 5xx to unprocessable WITH the real status, never to not_found or unauthorized', () => {
		for (const status of [500, 502, 503]) {
			const mapped = expectReason(apiError(status, 'Server Error'), 'unprocessable', status);

			expect(mapped.details).toEqual({});
		}
	});

	it('degrades a transport failure to unprocessable with status 0 and keeps the original as cause', () => {
		const original = new TypeError('fetch failed');

		const mapped = classify(original);

		expect(mapped.reason).toBe('unprocessable');
		expect(mapped.status).toBe(0);
		expect((mapped as Error & { cause?: unknown }).cause).toBe(original);
	});

	it('never throws, whatever it is handed', () => {
		for (const value of [undefined, null, 'boom', 42, {}, new Error('plain')]) {
			const mapped = toGitProviderError(value);

			expect(mapped).toBeInstanceOf(GitProviderRequestError);
			expect(mapped.status).toBe(0);
			expect(mapped.reason).toBe('unprocessable');
		}
	});

	it('keeps the original provider error as cause on a mapped row too', () => {
		const original = apiError(404, 'Not Found');

		const mapped = classify(original);

		expect((mapped as Error & { cause?: unknown }).cause).toBe(original);
	});
});

describe('APW-02 T16 — a mapped error is not re-classified', () => {
	it('returns an already-mapped error unchanged', () => {
		const first = toGitProviderError(apiError(429, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' }));

		const second = toGitProviderError(first);

		expect(second).toBe(first);
		expect(second.reason).toBe('rate_limited');
	});

	it('fills in a missing permission on an already-mapped permission_missing', () => {
		const first = toGitProviderError(apiError(403, 'Resource not accessible by integration'));

		const second = toGitProviderError(first, 'webhooks');

		expect(second.reason).toBe('permission_missing');
		expect(second.status).toBe(403);
		expect(second.details).toEqual({ permission: 'webhooks' });
	});

	it('leaves details that are already there alone', () => {
		const first = new GitProviderRequestError('permission_missing', 403, { permission: 'contents' });

		expect(toGitProviderError(first, 'actions')).toBe(first);
	});
});
