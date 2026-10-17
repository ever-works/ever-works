import { describe, expect, it } from 'vitest';

import {
	activeFleetNodeModelThrottles,
	clampRetryAfterMs,
	detectFleetModelUsageLimit,
	FLEET_JOB_FAILURE_KIND_MODEL_USAGE_LIMIT,
	FLEET_MODEL_USAGE_LIMIT_FALLBACK_MS,
	FLEET_MODEL_USAGE_LIMIT_MAX_MS,
	FLEET_MODEL_USAGE_LIMIT_MIN_MS,
	readFleetJobModelUsageLimit
} from '../fleet-model-usage-limit.types.js';

/** The instant the prod failure was observed (2026-10-17 15:27Z). */
const NOW = Date.parse('2026-10-17T15:27:00Z');

describe('detectFleetModelUsageLimit', () => {
	it("reads the prod sentence: Claude Code's weekly limit, reset in the stated zone", () => {
		const limit = detectFleetModelUsageLimit("You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)", {
			provider: 'claude-code',
			now: NOW
		});
		expect(limit).toEqual({
			provider: 'claude-code',
			window: 'weekly',
			// 03:00 CEST (UTC+2 until the last Sunday of October) is 01:00Z.
			resetsAt: '2026-10-19T01:00:00.000Z',
			retryAfter: '2026-10-19T01:01:00.000Z',
			message: "You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)"
		});
	});

	it('reads a 5-hour limit with a bare time as the NEXT occurrence, in the node zone', () => {
		const limit = detectFleetModelUsageLimit('5-hour limit reached ∙ resets 3pm', {
			now: NOW,
			timeZone: 'Europe/Paris'
		});
		// 15:27Z is 17:27 in Paris, so "3pm" is tomorrow's 15:00 CEST = 13:00Z.
		expect(limit?.window).toBe('session');
		expect(limit?.resetsAt).toBe('2026-10-18T13:00:00.000Z');
	});

	it('reads "will reset at" with minutes, later today', () => {
		const limit = detectFleetModelUsageLimit(
			'Claude usage limit reached. Your limit will reset at 7:30pm (Europe/Paris).',
			{ now: NOW }
		);
		expect(limit?.window).toBe('usage');
		expect(limit?.resetsAt).toBe('2026-10-17T17:30:00.000Z');
	});

	it('reads the older epoch form', () => {
		const limit = detectFleetModelUsageLimit('Claude AI usage limit reached|1792292400', { now: NOW });
		expect(limit?.resetsAt).toBe(new Date(1792292400 * 1000).toISOString());
	});

	it('reads Codex relative resets', () => {
		const limit = detectFleetModelUsageLimit(
			"You've hit your usage limit. Upgrade to Pro or try again in 2 days 3 hours 5 minutes.",
			{ provider: 'codex', now: NOW }
		);
		expect(limit?.provider).toBe('codex');
		expect(Date.parse(limit!.resetsAt!)).toBe(NOW + ((2 * 24 + 3) * 60 + 5) * 60_000);
		expect(
			Date.parse(detectFleetModelUsageLimit('usage limit reached, try again in 4h 12m', { now: NOW })!.resetsAt!)
		).toBe(NOW + (4 * 60 + 12) * 60_000);
	});

	it('treats a 429 with no reset as a rate limit retried after the fallback', () => {
		const limit = detectFleetModelUsageLimit(
			'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
			{ now: NOW }
		);
		expect(limit?.window).toBe('rate');
		expect(limit?.resetsAt).toBeNull();
		expect(Date.parse(limit!.retryAfter)).toBe(NOW + FLEET_MODEL_USAGE_LIMIT_FALLBACK_MS);
		expect(
			detectFleetModelUsageLimit('stream error: exceeded retry limit, last status: 429 Too Many Requests', {
				provider: 'codex',
				now: NOW
			})?.window
		).toBe('rate');
	});

	it('does not read ordinary failures — or the model talking about rate limits in strict mode', () => {
		expect(detectFleetModelUsageLimit('blew up', { now: NOW })).toBeNull();
		expect(
			detectFleetModelUsageLimit('TypeError: cannot read property limit of undefined', { now: NOW })
		).toBeNull();
		expect(detectFleetModelUsageLimit('', { now: NOW })).toBeNull();
		expect(detectFleetModelUsageLimit(null, { now: NOW })).toBeNull();
		expect(
			detectFleetModelUsageLimit('I implemented the middleware; the rate limit is exceeded after 10 calls', {
				now: NOW,
				strict: true
			})
		).toBeNull();
	});

	it('falls back when the stated reset is in the past, and clamps a far one', () => {
		const stale = detectFleetModelUsageLimit('Claude AI usage limit reached|1000000000', { now: NOW });
		expect(stale?.resetsAt).toBeNull();
		expect(Date.parse(stale!.retryAfter)).toBe(NOW + FLEET_MODEL_USAGE_LIMIT_FALLBACK_MS);
		const far = detectFleetModelUsageLimit("You've hit your usage limit, try again in 40 days", { now: NOW });
		expect(Date.parse(far!.retryAfter)).toBe(NOW + FLEET_MODEL_USAGE_LIMIT_MAX_MS);
	});
});

describe('clampRetryAfterMs', () => {
	it('keeps a retry within [now + 1 min, now + 8 days]', () => {
		expect(clampRetryAfterMs(NOW - 5_000, NOW)).toBe(NOW + FLEET_MODEL_USAGE_LIMIT_MIN_MS);
		expect(clampRetryAfterMs(NOW + 365 * 86_400_000, NOW)).toBe(NOW + FLEET_MODEL_USAGE_LIMIT_MAX_MS);
		expect(clampRetryAfterMs(Number.NaN, NOW)).toBe(NOW + FLEET_MODEL_USAGE_LIMIT_FALLBACK_MS);
	});
});

describe('readFleetJobModelUsageLimit', () => {
	it("trusts a current node's explicit outcome, re-clamping its retryAfter", () => {
		const limit = readFleetJobModelUsageLimit(
			{
				status: 'failed',
				failureKind: FLEET_JOB_FAILURE_KIND_MODEL_USAGE_LIMIT,
				modelUsageLimit: {
					provider: 'codex',
					window: 'weekly',
					resetsAt: '2026-10-19T01:00:00.000Z',
					retryAfter: '2027-10-19T01:01:00.000Z',
					message: "You've hit your usage limit"
				}
			},
			{ now: NOW }
		);
		expect(limit?.provider).toBe('codex');
		expect(limit?.window).toBe('weekly');
		expect(Date.parse(limit!.retryAfter)).toBe(NOW + FLEET_MODEL_USAGE_LIMIT_MAX_MS);
	});

	it("recognises an OLDER node's plain failed result from the model summary", () => {
		const limit = readFleetJobModelUsageLimit(
			{
				status: 'failed',
				failureReason:
					"claude-code reported an error: You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)",
				model: {
					provider: 'claude-code',
					status: 'failed',
					summary: "You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)"
				}
			},
			{ now: NOW }
		);
		expect(limit?.resetsAt).toBe('2026-10-19T01:00:00.000Z');
	});

	it("does not park an older node's run on a generic rate-limit phrase in the model's own words", () => {
		expect(
			readFleetJobModelUsageLimit(
				{
					status: 'failed',
					model: {
						provider: 'claude-code',
						status: 'failed',
						summary: 'Stopped: the GitHub API rate limit exceeded while listing issues'
					}
				},
				{ now: NOW }
			)
		).toBeNull();
	});

	it('ignores succeeded runs, red gates and non-model failures', () => {
		expect(
			readFleetJobModelUsageLimit(
				{ status: 'succeeded', model: { status: 'succeeded', summary: "You've hit your weekly limit" } },
				{ now: NOW }
			)
		).toBeNull();
		expect(
			readFleetJobModelUsageLimit(
				{
					status: 'failed',
					failureReason: 'a required acceptance check did not pass',
					model: { status: 'succeeded', summary: 'done' }
				},
				{ now: NOW }
			)
		).toBeNull();
		expect(
			readFleetJobModelUsageLimit({ status: 'failed', failureReason: 'git finalize failed' }, { now: NOW })
		).toBeNull();
		expect(readFleetJobModelUsageLimit(null)).toBeNull();
	});
});

describe('activeFleetNodeModelThrottles', () => {
	it('returns only unexpired entries, the latest window per CLI', () => {
		const active = activeFleetNodeModelThrottles(
			[
				{
					provider: 'claude-code',
					window: 'session',
					until: '2026-10-17T16:00:00.000Z',
					reason: 'a',
					since: '2026-10-17T11:00:00.000Z'
				},
				{
					provider: 'claude-code',
					window: 'weekly',
					until: '2026-10-19T01:01:00.000Z',
					reason: 'b',
					since: '2026-10-17T15:27:00.000Z'
				},
				{
					provider: 'codex',
					window: 'usage',
					until: '2026-10-17T15:00:00.000Z',
					reason: 'expired',
					since: '2026-10-17T14:00:00.000Z'
				},
				'junk',
				{ provider: '', until: 'never' }
			],
			NOW
		);
		expect(active).toEqual([
			{
				provider: 'claude-code',
				window: 'weekly',
				until: '2026-10-19T01:01:00.000Z',
				reason: 'b',
				since: '2026-10-17T15:27:00.000Z'
			}
		]);
		expect(activeFleetNodeModelThrottles(null, NOW)).toEqual([]);
	});
});
