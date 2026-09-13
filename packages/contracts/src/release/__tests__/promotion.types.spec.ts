import { describe, expect, it } from 'vitest';

import {
	PROMOTION_LANE_OPEN,
	PROMOTION_RUNGS,
	PROMOTION_STATES,
	PROMOTION_TASK_LABEL,
	RELEASE_BRANCH_MAX_LENGTH,
	isPromotionRung,
	isPromotionTask,
	promotionLaneKey,
	promotionRungFromLabels,
	promotionRungLabel,
	promotionTaskLabels,
	resolvePromotionBranches,
	sanitizeReleaseLadder,
	type PromotionState
} from '../promotion.types.js';

const LADDER = { integration: 'develop', staging: 'stage', production: 'main' };

describe('the ladder is not a cascade', () => {
	it('lists the rungs in reading order without offering a successor', async () => {
		expect(PROMOTION_RUNGS).toEqual(['develop-to-stage', 'stage-to-main']);
		// THE load-bearing absence. Nothing in the release surface maps a
		// finished rung onto the next one — no `nextRung`, no `advance`, no
		// `cascade`. If a future edit adds one, this fails and the author
		// has to argue for automating a promotion the founder performs
		// deliberately, per batch, after reading the end-to-end verdict.
		const surface = Object.keys(await import('../index.js'));
		expect(surface.filter((name) => /next|advance|cascade|chain|succeed/i.test(name))).toEqual([]);
	});

	it('has no develop-to-main rung', () => {
		expect(isPromotionRung('develop-to-main')).toBe(false);
	});
});

describe('isPromotionRung', () => {
	it('accepts the two real rungs', () => {
		expect(isPromotionRung('develop-to-stage')).toBe(true);
		expect(isPromotionRung('stage-to-main')).toBe(true);
	});

	it.each([['', null, undefined, 42, {}, 'DEVELOP-TO-STAGE', ' stage-to-main ']].flat())('refuses %p', (value) => {
		expect(isPromotionRung(value)).toBe(false);
	});
});

describe('sanitizeReleaseLadder', () => {
	it('accepts a well-formed ladder and trims it', () => {
		expect(sanitizeReleaseLadder({ integration: ' develop ', staging: 'stage', production: 'main' })).toEqual(
			LADDER
		);
	});

	it.each([
		['null', null],
		['undefined', undefined],
		['an array', ['develop', 'stage', 'main']],
		['a string', 'develop,stage,main'],
		['a partial ladder', { integration: 'develop', staging: 'stage' }],
		['an empty branch', { integration: 'develop', staging: '', production: 'main' }],
		['a non-string branch', { integration: 'develop', staging: 7, production: 'main' }]
	])('refuses %s', (_label, value) => {
		expect(sanitizeReleaseLadder(value)).toBeNull();
	});

	it('refuses a ladder whose rungs are not three distinct branches', () => {
		// `develop -> develop` is not a promotion, and `stage === main`
		// would ask a human to approve a production merge that does nothing.
		expect(sanitizeReleaseLadder({ integration: 'develop', staging: 'develop', production: 'main' })).toBeNull();
		expect(sanitizeReleaseLadder({ integration: 'develop', staging: 'main', production: 'main' })).toBeNull();
	});

	it.each([
		['a path escape', '../main'],
		['a leading dash so it cannot be read as an option', '--force'],
		['a leading slash', '/main'],
		['whitespace', 'release main'],
		['a refspec character', 'main:main'],
		['a glob', 'rele*se'],
		['a caret', 'main^'],
		['a tilde', 'main~1'],
		['a trailing slash', 'release/'],
		['a lock name', 'main.lock'],
		['a doubled slash', 'release//main']
	])('refuses %s in a branch name', (_label, branch) => {
		expect(sanitizeReleaseLadder({ ...LADDER, staging: branch })).toBeNull();
	});

	it('refuses a branch longer than the column can hold', () => {
		const tooLong = 'b'.repeat(RELEASE_BRANCH_MAX_LENGTH + 1);
		expect(sanitizeReleaseLadder({ ...LADDER, staging: tooLong })).toBeNull();
		expect(sanitizeReleaseLadder({ ...LADDER, staging: 'b'.repeat(RELEASE_BRANCH_MAX_LENGTH) })).not.toBeNull();
	});
});

describe('resolvePromotionBranches', () => {
	it('resolves each rung off the ladder, never off the caller', () => {
		expect(resolvePromotionBranches(LADDER, 'develop-to-stage')).toEqual({ head: 'develop', base: 'stage' });
		expect(resolvePromotionBranches(LADDER, 'stage-to-main')).toEqual({ head: 'stage', base: 'main' });
	});

	it('honours a non-default ladder', () => {
		const custom = { integration: 'trunk', staging: 'preprod', production: 'release' };
		expect(resolvePromotionBranches(custom, 'develop-to-stage')).toEqual({ head: 'trunk', base: 'preprod' });
		expect(resolvePromotionBranches(custom, 'stage-to-main')).toEqual({ head: 'preprod', base: 'release' });
	});

	it('returns null rather than a half-resolved pair when the ladder is unusable', () => {
		expect(resolvePromotionBranches(null, 'stage-to-main')).toBeNull();
		expect(resolvePromotionBranches(undefined, 'develop-to-stage')).toBeNull();
		expect(
			resolvePromotionBranches({ integration: 'develop', staging: '', production: 'main' }, 'develop-to-stage')
		).toBeNull();
	});

	it('returns null for a rung that is not one', () => {
		expect(resolvePromotionBranches(LADDER, 'develop-to-main' as never)).toBeNull();
	});
});

describe('promotion Task labels', () => {
	it('files both the generic and the per-rung label', () => {
		expect(promotionTaskLabels('stage-to-main')).toEqual([PROMOTION_TASK_LABEL, 'release:promotion:stage-to-main']);
	});

	it('recognises a promotion Task off the generic label alone', () => {
		// The merge gate reads this to fail CLOSED when the promotion
		// service is not bound, so it must not need the per-rung label.
		expect(isPromotionTask([PROMOTION_TASK_LABEL])).toBe(true);
		expect(isPromotionTask(['chore', PROMOTION_TASK_LABEL])).toBe(true);
	});

	it.each([
		['no labels', null],
		['undefined labels', undefined],
		['an empty list', []],
		['an unrelated label', ['chore']],
		['a near miss', ['release:promotions']],
		['only the per-rung label', [promotionRungLabel('stage-to-main')]]
	])('does not treat %s as a promotion', (_label, labels) => {
		expect(isPromotionTask(labels as string[] | null | undefined)).toBe(false);
	});

	it('reads the rung back off the labels', () => {
		expect(promotionRungFromLabels(promotionTaskLabels('develop-to-stage'))).toBe('develop-to-stage');
		expect(promotionRungFromLabels(promotionTaskLabels('stage-to-main'))).toBe('stage-to-main');
	});

	it('returns null when the rung label is missing or the Task is not a promotion', () => {
		expect(promotionRungFromLabels([PROMOTION_TASK_LABEL])).toBeNull();
		expect(promotionRungFromLabels(['chore'])).toBeNull();
	});
});

describe('promotionLaneKey — the portable partial-unique index', () => {
	it('gives every OPEN promotion the same colliding value', () => {
		expect(promotionLaneKey('open', 'p-1')).toBe(PROMOTION_LANE_OPEN);
		expect(promotionLaneKey('open', 'p-2')).toBe(PROMOTION_LANE_OPEN);
	});

	it('gives every TERMINAL promotion a value unique to itself', () => {
		const terminal = PROMOTION_STATES.filter((state) => state !== 'open');
		const keys = terminal.flatMap((state: PromotionState) => [
			promotionLaneKey(state, 'p-1'),
			promotionLaneKey(state, 'p-2')
		]);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).not.toContain(PROMOTION_LANE_OPEN);
	});

	it('refuses to free the lane without a row id', () => {
		// Writing `'open'` would hold the lane forever; writing a constant
		// would collide with the next terminal row. Neither is silent.
		expect(() => promotionLaneKey('merged', '')).toThrow(/row id/i);
		expect(() => promotionLaneKey('closed', '   ')).toThrow(/row id/i);
	});
});
