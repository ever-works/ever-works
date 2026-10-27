import { describe, expect, it } from 'vitest';

import {
	UPSTREAM_ACTIVE_STATES as UPSTREAM_ACTIVE_STATES_FROM_ROOT,
	effectiveUpstreamMaxOpen as effectiveUpstreamMaxOpenFromRoot
} from '../../index.js';
import {
	UPSTREAM_ACTIVE_STATES,
	UPSTREAM_ERROR_CODES,
	UPSTREAM_LIMITS,
	UPSTREAM_PR_ACTIVITY_ACTION_TYPE,
	UPSTREAM_PR_ACTIVITY_EVENTS,
	UPSTREAM_PULL_REQUEST_ORIGINS,
	UPSTREAM_PULL_REQUEST_STATES,
	UPSTREAM_RATE_LIMIT_KEYS,
	UPSTREAM_REFUSAL_CODES,
	UPSTREAM_TERMINAL_STATES,
	UPSTREAM_TIMEOUTS,
	UPSTREAM_WITHDRAWABLE_STATES,
	effectiveUpstreamMaxOpen,
	isUpstreamActiveState
} from '../upstream-pull-request.types.js';

/**
 * APW-09 T6 — the shared vocabulary is pinned value by value, so an append is a
 * deliberate change and a removal or reorder (R-26) fails here first.
 */
describe('APW-09 upstream pull request contracts', () => {
	it('reaches the package root through apps/index.ts', () => {
		expect(UPSTREAM_ACTIVE_STATES_FROM_ROOT).toBe(UPSTREAM_ACTIVE_STATES);
		expect(effectiveUpstreamMaxOpenFromRoot).toBe(effectiveUpstreamMaxOpen);
	});

	it('pins the eleven states in order (FR-28)', () => {
		expect(UPSTREAM_PULL_REQUEST_STATES).toEqual([
			'preparing',
			'needs_signature',
			'awaiting_approval',
			'opening',
			'open',
			'merged',
			'closed',
			'refused',
			'failed',
			'expired',
			'withdrawn'
		]);
	});

	it('splits every state into exactly one of active / terminal', () => {
		const active = new Set<string>(UPSTREAM_ACTIVE_STATES);
		const terminal = new Set<string>(UPSTREAM_TERMINAL_STATES);
		for (const state of UPSTREAM_PULL_REQUEST_STATES) {
			expect(active.has(state) !== terminal.has(state)).toBe(true);
		}
		expect(UPSTREAM_ACTIVE_STATES).toEqual([
			'preparing',
			'needs_signature',
			'awaiting_approval',
			'opening',
			'open'
		]);
	});

	it('only lets a member withdraw before the pull request exists (FR-33)', () => {
		expect(UPSTREAM_WITHDRAWABLE_STATES).toEqual(['preparing', 'needs_signature', 'awaiting_approval']);
		expect(UPSTREAM_WITHDRAWABLE_STATES).not.toContain('open');
		expect(UPSTREAM_WITHDRAWABLE_STATES).not.toContain('opening');
	});

	it('recognises an active state and nothing else', () => {
		expect(isUpstreamActiveState('open')).toBe(true);
		expect(isUpstreamActiveState('merged')).toBe(false);
		expect(isUpstreamActiveState(undefined)).toBe(false);
		expect(isUpstreamActiveState('OPEN')).toBe(false);
	});

	it('pins all 30 refusal codes, the seven 2026-09-17 additions last', () => {
		expect(UPSTREAM_REFUSAL_CODES).toHaveLength(30);
		expect(UPSTREAM_REFUSAL_CODES.slice(-7)).toEqual([
			'publishingOff',
			'pullRequestsDisabled',
			'outsideContributorCap',
			'platformCapReached',
			'maintainerOptOut',
			'deniedUpstream',
			'reportInvalid'
		]);
		expect(new Set(UPSTREAM_REFUSAL_CODES).size).toBe(30);
		// Every refusal code fits the `refusalCode varchar(32)` column.
		for (const code of UPSTREAM_REFUSAL_CODES) expect(code.length).toBeLessThanOrEqual(32);
		expect(UPSTREAM_ERROR_CODES).toEqual(['activeProposal']);
	});

	it('pins the FR-26 / FR-39 defaults (CL-39 / APW09-G24 defaults: 1 per project per day, 3 overall)', () => {
		expect(UPSTREAM_LIMITS).toEqual({
			openedPerUpstreamPer24h: 1,
			openPerUpstreamCeiling: 10,
			openedOverallPer24h: 3,
			preparationsPer24h: 10,
			runningPreparationsPerWork: 1,
			pushesPerPrPer24h: 5,
			suggestionsPerWorkPer7d: 3,
			platformOpenedPerUpstreamPer24h: 5
		});
		expect(UPSTREAM_LIMITS.platformOpenedPerUpstreamPer24h).toBeGreaterThan(0);
		expect(UPSTREAM_TIMEOUTS.approvalTtlMs).toBe(72 * 3_600_000);
	});

	it('names openPerUpstream (the spec cap) as a limit key, never the ceiling', () => {
		expect(UPSTREAM_RATE_LIMIT_KEYS).toContain('openPerUpstream');
		expect(UPSTREAM_RATE_LIMIT_KEYS).not.toContain('openPerUpstreamCeiling');
		expect(UPSTREAM_RATE_LIMIT_KEYS).toContain('platformOpenedPerUpstreamPer24h');
	});

	it('clamps the App spec maxOpen to [1, 10] and defaults it to 3 (FR-26, G15)', () => {
		expect(effectiveUpstreamMaxOpen(undefined)).toBe(3);
		expect(effectiveUpstreamMaxOpen(null)).toBe(3);
		expect(effectiveUpstreamMaxOpen('5')).toBe(3);
		expect(effectiveUpstreamMaxOpen(1.5)).toBe(3);
		expect(effectiveUpstreamMaxOpen(1)).toBe(1);
		expect(effectiveUpstreamMaxOpen(10)).toBe(10);
		expect(effectiveUpstreamMaxOpen(25)).toBe(10);
		expect(effectiveUpstreamMaxOpen(0)).toBe(1);
	});

	it('pins the Activity family and its events (R-2, plan §3.4)', () => {
		expect(UPSTREAM_PR_ACTIVITY_ACTION_TYPE).toBe('app_upstream_pr');
		expect(UPSTREAM_PR_ACTIVITY_EVENTS).toHaveLength(13);
		for (const event of UPSTREAM_PR_ACTIVITY_EVENTS) expect(event).toMatch(/^app\.upstream_pr\.[a-z_]+$/);
		expect(UPSTREAM_PR_ACTIVITY_EVENTS).toContain('app.upstream_pr.opened');
	});

	it('pins the two record origins', () => {
		expect(UPSTREAM_PULL_REQUEST_ORIGINS).toEqual(['proposal', 'direct']);
	});
});
