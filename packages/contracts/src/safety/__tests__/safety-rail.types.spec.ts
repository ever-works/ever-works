import { describe, expect, it } from 'vitest';

import {
	SAFETY_ALLOW,
	SAFETY_RAIL_ORDER,
	SAFETY_REASON_CODES,
	isSafetyRailId,
	isSafetyReasonCode
} from '../safety-rail.types.js';
import {
	HELD_ACTION_EXPIRY_DAYS,
	HELD_ACTION_WARN_DAYS,
	RAIL_REFUSAL_COLLAPSE_THRESHOLD,
	RAIL_REFUSAL_PAGE_SIZE,
	RAIL_REFUSAL_RETENTION_DAYS,
	RAIL_REFUSAL_SUMMARY_MAX,
	READINESS_MIN_APPROVAL_RATE,
	READINESS_MIN_DECISIONS,
	READINESS_WINDOW_DAYS,
	RESUME_BATCH_INTERVAL_MS,
	RESUME_BATCH_SIZE,
	SAFETY_CACHE_TTL_MS,
	PAUSE_INFLIGHT_GRACE_MS,
	STALE_PRICE_DELTA,
	UNCLASSIFIED_ACTION_POLICY,
	WORKSPACE_PAUSE_REASON_MAX
} from '../limits.js';

/**
 * The order is a published product promise (FR-19), which is why it lives in
 * an array rather than in control flow: an `if` ladder cannot be asserted, and
 * a reordering of one would silently change which refusal an owner is shown.
 */
describe('SAFETY_RAIL_ORDER', () => {
	it('is the seven rails, in the published order', () => {
		expect([...SAFETY_RAIL_ORDER]).toEqual([
			'platform-stop',
			'workspace-pause',
			'scope-pause',
			'grants',
			'ladder',
			'caps',
			'rules'
		]);
	});

	it('puts every stop ahead of every policy check', () => {
		// A stopped platform must spend no query it does not have to.
		const ladderAt = SAFETY_RAIL_ORDER.indexOf('ladder');
		expect(SAFETY_RAIL_ORDER.indexOf('platform-stop')).toBeLessThan(ladderAt);
		expect(SAFETY_RAIL_ORDER.indexOf('workspace-pause')).toBeLessThan(ladderAt);
		expect(SAFETY_RAIL_ORDER.indexOf('scope-pause')).toBeLessThan(ladderAt);
	});

	it('checks grants before the ladder, and caps and rules last', () => {
		expect(SAFETY_RAIL_ORDER.indexOf('grants')).toBeLessThan(SAFETY_RAIL_ORDER.indexOf('ladder'));
		expect(SAFETY_RAIL_ORDER.indexOf('caps')).toBeGreaterThan(SAFETY_RAIL_ORDER.indexOf('ladder'));
		expect(SAFETY_RAIL_ORDER[SAFETY_RAIL_ORDER.length - 1]).toBe('rules');
	});

	it('does not contain the classifier', () => {
		// `taxonomy` names the classifier so an unclassified action can be
		// recorded against something. It is not a rail and never runs in order.
		expect(SAFETY_RAIL_ORDER).not.toContain('taxonomy');
		expect(isSafetyRailId('taxonomy')).toBe(true);
	});

	it('is frozen and duplicate-free', () => {
		expect(Object.isFrozen(SAFETY_RAIL_ORDER)).toBe(true);
		expect(new Set(SAFETY_RAIL_ORDER).size).toBe(SAFETY_RAIL_ORDER.length);
	});
});

describe('SAFETY_REASON_CODES', () => {
	it('is the fourteen shipped codes', () => {
		expect([...SAFETY_REASON_CODES]).toEqual([
			'platform-stopped',
			'workspace-paused',
			'scope-paused',
			'rung-off',
			'rung-held',
			'ceiling-refused',
			'cap-reached',
			'grant-denied',
			'rule-blocked',
			'policy-refused',
			'unclassified-action',
			'instruction-widening-attempt',
			'non-human-actor',
			'safe-mode'
		]);
	});

	it('is closed', () => {
		expect(isSafetyReasonCode('rung-held')).toBe(true);
		expect(isSafetyReasonCode('because-i-said-so')).toBe(false);
		expect(isSafetyReasonCode(undefined)).toBe(false);
	});

	it('names an instruction that tried to widen a rung as its own code', () => {
		// U1 — a skill body or memory fact asserting standing permission is a
		// signal worth reading, not just another refusal.
		expect(SAFETY_REASON_CODES).toContain('instruction-widening-attempt');
	});
});

describe('SAFETY_ALLOW', () => {
	it('carries no rail, category, rung or reason', () => {
		expect(SAFETY_ALLOW.decision).toBe('allow');
		expect(SAFETY_ALLOW.railId).toBeNull();
		expect(SAFETY_ALLOW.category).toBeNull();
		expect(SAFETY_ALLOW.rung).toBeNull();
		expect(SAFETY_ALLOW.reasonCode).toBeNull();
	});

	it('is frozen, so a rail cannot mutate the shared allow verdict', () => {
		expect(Object.isFrozen(SAFETY_ALLOW)).toBe(true);
	});
});

describe('the numbers behind the sentences', () => {
	it('holds an action for 14 days and warns at 7', () => {
		expect(HELD_ACTION_EXPIRY_DAYS).toBe(14);
		expect(HELD_ACTION_WARN_DAYS).toBe(7);
		expect(HELD_ACTION_WARN_DAYS).toBeLessThan(HELD_ACTION_EXPIRY_DAYS);
	});

	it('refreshes rung and pause state at most every 10 seconds', () => {
		expect(SAFETY_CACHE_TTL_MS).toBe(10_000);
	});

	it('gives an in-flight run 30 seconds to reach a boundary', () => {
		expect(PAUSE_INFLIGHT_GRACE_MS).toBe(30_000);
	});

	it('resumes 50 parked items per 10 seconds', () => {
		expect(RESUME_BATCH_SIZE).toBe(50);
		expect(RESUME_BATCH_INTERVAL_MS).toBe(10_000);
	});

	it('pages refusals at 50, keeps them 90 days and collapses above 50 a day', () => {
		expect(RAIL_REFUSAL_PAGE_SIZE).toBe(50);
		expect(RAIL_REFUSAL_RETENTION_DAYS).toBe(90);
		expect(RAIL_REFUSAL_COLLAPSE_THRESHOLD).toBe(50);
	});

	it('caps a refusal summary and a pause reason at 500 characters', () => {
		expect(RAIL_REFUSAL_SUMMARY_MAX).toBe(500);
		expect(WORKSPACE_PAUSE_REASON_MAX).toBe(500);
	});

	it('computes readiness over 30 days, 20 decisions and a 95% approval rate', () => {
		expect(READINESS_WINDOW_DAYS).toBe(30);
		expect(READINESS_MIN_DECISIONS).toBe(20);
		expect(READINESS_MIN_APPROVAL_RATE).toBeCloseTo(0.95, 10);
	});

	it('marks a priced action stale at a 10% move', () => {
		expect(STALE_PRICE_DELTA).toBeCloseTo(0.1, 10);
	});

	it('still only WARNS about an action nobody classified', () => {
		// P1 ships `warn`: the bundled plugins have not declared their
		// categories yet, and refusing everything they expose would take
		// working installs down on the day this lands. P3 flips it.
		expect(UNCLASSIFIED_ACTION_POLICY).toBe('warn');
	});
});
