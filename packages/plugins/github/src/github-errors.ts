import { RequestError } from 'octokit';
import { GitProviderRequestError } from '@ever-works/plugin/git';
import type { GitProviderErrorDetails, GitProviderErrorReason } from '@ever-works/plugin/git';

/**
 * GitHub failure classification (APW-02 T16) — plan §4.2's signal table, in code.
 *
 * Every new fork-lifecycle plugin method reports a provider failure as ONE typed
 * error, `GitProviderRequestError`, so that no caller has to read GitHub's prose
 * to know whether to wait, to re-authorize or to give up. This module is the
 * single place that reads that prose: the HTTP status, the rate-limit headers and
 * the response body's `message`, mapped onto `GitProviderErrorReason`.
 *
 * Two limits of the table are deliberate and are stated rather than papered over:
 *
 * 1. It has no row for a 5xx, nor for a transport failure, and the contract's
 *    reason vocabulary has no "the provider broke" member. Those degrade to
 *    `unprocessable` with the REAL status preserved (`0` when no response ever
 *    arrived) — the one bucket that lies about nothing: it is neither a
 *    destructive `not_found` / `unauthorized` nor a rate limit a caller would
 *    sleep on, and `status` still tells a 500 from a genuine 422.
 * 2. A 403 whose body matches none of the four 403 rows (primary rate limit, SSO,
 *    OAuth App restrictions, missing permission) degrades to `unprocessable` too,
 *    instead of being guessed at: inventing `permission_missing` for an
 *    unfamiliar refusal would name a permission GitHub never named.
 */

/** `x-ratelimit-remaining: 0` — the primary budget is spent. */
const RATE_LIMIT_REMAINING_HEADER = 'x-ratelimit-remaining';

/** Unix SECONDS at which the primary budget refills (`x-ratelimit-reset`). */
const RATE_LIMIT_RESET_HEADER = 'x-ratelimit-reset';

/** SECONDS to wait — GitHub's answer to a secondary limit, when it gives one. */
const RETRY_AFTER_HEADER = 'retry-after';

// Body markers, each GitHub's own lowercased wording. Every marker is checked
// inside its own status row, so a marker that stops matching costs precision
// (the documented fallback) and can never produce a wrong row.
const SECONDARY_RATE_LIMIT_MARKER = 'secondary rate limit';
const TOO_QUICKLY_MARKER = 'too quickly';
const SAML_MARKER = 'saml';
const OAUTH_APP_RESTRICTIONS_MARKER = 'oauth app access restrictions';
const APP_PERMISSION_MARKER = 'resource not accessible by integration';
const PAT_PERMISSION_MARKER = 'resource not accessible by personal access token';

/**
 * One response header, by name, case-insensitively — Octokit lowercases the
 * names it hands over, but nothing guarantees a caller's error object does — as a
 * trimmed string.
 */
function headerValue(headers: unknown, name: string): string | undefined {
	if (!headers || typeof headers !== 'object') return undefined;
	for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
		if (key.toLowerCase() !== name) continue;
		if (typeof value === 'number') return String(value);
		if (typeof value === 'string' && value.trim() !== '') return value.trim();
	}
	return undefined;
}

/**
 * The provider's own words for the failure, lowercased: the response body's
 * `message` AND the error's message. Both are searched, because Octokit builds
 * the second from the first for an API error while a transport-level failure has
 * only the second. This string is never surfaced — only matched against.
 */
function providerMessage(err: unknown): string {
	if (!(err instanceof Error)) return '';
	const data = (err as { response?: { data?: unknown } }).response?.data;
	const body =
		data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
			? (data as { message: string }).message
			: '';
	return `${body} ${err.message}`.trim().toLowerCase();
}

/** An instant, as ISO-8601, or `undefined` when it is not a real one. */
function toIso(ms: number): string | undefined {
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** `x-ratelimit-reset` (Unix seconds) → the ISO-8601 instant the contract wants. */
function isoFromEpochSeconds(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	return toIso(seconds * 1000);
}

/**
 * `retry-after` → `now + that`, ISO-8601 (plan §4.2: `retryAt` = now +
 * `retry-after`).
 *
 * GitHub sends a number of SECONDS. RFC 9110 also permits an HTTP-date there, and
 * although GitHub never sends one, an absolute instant is exactly what `retryAt`
 * wants, so a date is honoured instead of being discarded. Anything else — a
 * missing header, a negative number, gibberish — is absent, never a guessed
 * delay.
 */
function isoFromRetryAfterSeconds(value: string | undefined, nowMs: number): string | undefined {
	if (value === undefined) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return toIso(nowMs + seconds * 1000);
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : toIso(parsed);
}

/**
 * Classify one provider failure, per plan §4.2.
 *
 * `permissionHint` is the permission the CALLING method needed. §4.2 attaches it
 * to the `permission_missing` row only, and that is exactly what happens here: a
 * refusal GitHub did not word as a permission failure is never upgraded into one
 * on the strength of the hint.
 *
 * Idempotent: an error that is already a `GitProviderRequestError` comes back
 * unchanged — re-classifying it would replace a named reason with the fallback
 * above, since a mapped error carries no HTTP status to map back — except that a
 * `permission_missing` without a permission is handed the hint.
 */
export function toGitProviderError(
	err: unknown,
	permissionHint?: GitProviderErrorDetails['permission']
): GitProviderRequestError {
	if (err instanceof GitProviderRequestError) {
		if (permissionHint !== undefined && err.reason === 'permission_missing' && !err.details.permission) {
			return new GitProviderRequestError(err.reason, err.status, { ...err.details, permission: permissionHint });
		}
		return err;
	}

	const nowMs = Date.now();
	// A non-`RequestError` (a socket failure, a DNS error, a bug in a caller) has
	// no status: `0` says "no response arrived" without pretending to be an HTTP
	// one.
	const status = err instanceof RequestError && typeof err.status === 'number' ? err.status : 0;
	const headers = (err as { response?: { headers?: unknown } } | null | undefined)?.response?.headers;
	const message = providerMessage(err);
	const retryAfter = headerValue(headers, RETRY_AFTER_HEADER);
	const budgetRemaining = headerValue(headers, RATE_LIMIT_REMAINING_HEADER);
	const resetAt = headerValue(headers, RATE_LIMIT_RESET_HEADER);

	const rateLimitedResponse = status === 403 || status === 429;
	const secondarySignal =
		(rateLimitedResponse && retryAfter !== undefined) ||
		((rateLimitedResponse || status === 422) && message.includes(SECONDARY_RATE_LIMIT_MARKER)) ||
		(status === 422 && message.includes(TOO_QUICKLY_MARKER));

	let reason: GitProviderErrorReason;
	let details: GitProviderErrorDetails = {};

	if (status === 401) {
		reason = 'unauthorized';
	} else if (rateLimitedResponse && budgetRemaining === '0') {
		// The primary budget, checked BEFORE the secondary row even though both can
		// be signalled at once: `x-ratelimit-remaining: 0` plus a reset time is the
		// stronger answer, and it is the row §4.2 lists first.
		reason = 'rate_limited';
		const retryAt = isoFromEpochSeconds(resetAt);
		// No reset header means no instant we can name; the caller falls back to its
		// own schedule rather than being handed an invented one.
		if (retryAt !== undefined) details = { retryAt };
	} else if (secondarySignal) {
		reason = 'secondary_rate_limited';
		// `retryAt` only when GitHub named a wait. A wording-only secondary limit
		// carries none, and the caller's backoff (FR-51: 60 s doubling to 1 h) owns
		// the delay.
		const retryAt = isoFromRetryAfterSeconds(retryAfter, nowMs);
		if (retryAt !== undefined) details = { retryAt };
	} else if (status === 403 && message.includes(SAML_MARKER)) {
		reason = 'sso_authorization_required';
	} else if (status === 403 && message.includes(OAUTH_APP_RESTRICTIONS_MARKER)) {
		reason = 'oauth_app_restricted';
	} else if (status === 403 && (message.includes(APP_PERMISSION_MARKER) || message.includes(PAT_PERMISSION_MARKER))) {
		reason = 'permission_missing';
		if (permissionHint !== undefined) details = { permission: permissionHint };
	} else if (status === 404) {
		reason = 'not_found';
	} else if (status === 409) {
		reason = 'conflict';
	} else {
		reason = 'unprocessable';
	}

	const mapped = new GitProviderRequestError(reason, status, details);
	// The original travels as `cause`: on the fallback rows its prose is the only
	// remaining clue to what actually happened.
	if (err instanceof Error) Object.assign(mapped, { cause: err });
	return mapped;
}
