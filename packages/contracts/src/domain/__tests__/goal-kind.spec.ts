import { describe, it, expect } from 'vitest';
import { DEFAULT_GOAL_KIND, GOAL_KINDS, isDeliveryGoalKind, isGoalKind, normalizeGoalKind } from '../index.js';

/**
 * Goal kind vocabulary (self-build slice AG, EW-795).
 *
 * The list is shared by the API DTO, the service, the MCP schema and the
 * web form; pinning its members here means adding a kind is a deliberate
 * multi-surface change rather than a silent widening.
 */
describe('GOAL_KINDS', () => {
	it('exposes exactly the two kinds the platform completes differently', () => {
		expect([...GOAL_KINDS]).toEqual(['metric', 'delivery']);
	});

	it('defaults to metric — what every pre-existing Goal row is', () => {
		expect(DEFAULT_GOAL_KIND).toBe('metric');
	});
});

describe('isGoalKind (write paths — fail closed)', () => {
	it.each(['metric', 'delivery'])('accepts %s', (value) => {
		expect(isGoalKind(value)).toBe(true);
	});

	it.each(['Metric', ' delivery ', 'outcome', '', null, undefined, 42, {}])(
		'rejects %j without coercing',
		(value) => {
			expect(isGoalKind(value)).toBe(false);
		}
	);
});

describe('normalizeGoalKind (read paths — never throws)', () => {
	it('returns the canonical kind for loose spellings', () => {
		expect(normalizeGoalKind('delivery')).toBe('delivery');
		expect(normalizeGoalKind(' Delivery ')).toBe('delivery');
		expect(normalizeGoalKind('METRIC')).toBe('metric');
	});

	it('falls back to metric for unknown, empty or missing values', () => {
		expect(normalizeGoalKind('outcome')).toBe('metric');
		expect(normalizeGoalKind('')).toBe('metric');
		expect(normalizeGoalKind(null)).toBe('metric');
		expect(normalizeGoalKind(undefined)).toBe('metric');
	});
});

describe('isDeliveryGoalKind', () => {
	it('is true only for the delivery kind', () => {
		expect(isDeliveryGoalKind('delivery')).toBe(true);
		expect(isDeliveryGoalKind('metric')).toBe(false);
		expect(isDeliveryGoalKind(undefined)).toBe(false);
	});
});
