import { describe, expect, it } from 'vitest';

import {
	TRUST_RUNG_ORDER,
	compareRung,
	isTrustRung,
	maxRung,
	minRung,
	nextRungUp,
	offeredRungs,
	rungIndex,
	type TrustRung
} from '../trust-rung.types.js';

/**
 * The ORDER is the whole type: narrow-only is `minRung`, one-rung-at-a-time is
 * a ±1 index step, and a ceiling is an upper bound on the index. Every rule in
 * the epic is expressed against this array, so an inverted or re-ordered array
 * would quietly invert the safety model rather than break a build.
 */
describe('TRUST_RUNG_ORDER', () => {
	it('ascends in autonomy: off, draft, ask, auto', () => {
		expect([...TRUST_RUNG_ORDER]).toEqual(['off', 'draft', 'ask', 'auto']);
	});

	it('is frozen', () => {
		expect(Object.isFrozen(TRUST_RUNG_ORDER)).toBe(true);
	});
});

describe('rungIndex', () => {
	it('answers the position in the order', () => {
		expect(rungIndex('off')).toBe(0);
		expect(rungIndex('draft')).toBe(1);
		expect(rungIndex('ask')).toBe(2);
		expect(rungIndex('auto')).toBe(3);
	});

	it('answers -1 for a rung this build does not know, rather than throwing', () => {
		// A stored row carrying an unknown rung must not be able to crash a read
		// path, and -1 sorts below `off`, which is the fail-closed reading.
		expect(rungIndex('supervised' as TrustRung)).toBe(-1);
	});
});

describe('compareRung', () => {
	it('is negative when the left grants less', () => {
		expect(compareRung('off', 'auto')).toBeLessThan(0);
		expect(compareRung('draft', 'ask')).toBeLessThan(0);
	});

	it('is zero for equal rungs', () => {
		expect(compareRung('ask', 'ask')).toBe(0);
	});

	it('is positive when the left grants more', () => {
		expect(compareRung('auto', 'draft')).toBeGreaterThan(0);
	});
});

describe('minRung — the narrow-only merge', () => {
	it('takes the stricter of the two', () => {
		expect(minRung('auto', 'ask')).toBe('ask');
		expect(minRung('draft', 'off')).toBe('off');
		expect(minRung('ask', 'ask')).toBe('ask');
	});

	it('is commutative, so a caller cannot invert the merge by argument order', () => {
		for (const a of TRUST_RUNG_ORDER) {
			for (const b of TRUST_RUNG_ORDER) {
				expect(minRung(a, b)).toBe(minRung(b, a));
			}
		}
	});

	it('never returns something more permissive than either input', () => {
		for (const a of TRUST_RUNG_ORDER) {
			for (const b of TRUST_RUNG_ORDER) {
				const merged = minRung(a, b);
				expect(compareRung(merged, a)).toBeLessThanOrEqual(0);
				expect(compareRung(merged, b)).toBeLessThanOrEqual(0);
			}
		}
	});
});

describe('maxRung', () => {
	it('takes the more permissive — used only to describe, never to grant', () => {
		expect(maxRung('off', 'draft')).toBe('draft');
		expect(maxRung('auto', 'ask')).toBe('auto');
	});
});

describe('nextRungUp — one rung at a time', () => {
	it('walks off -> draft -> ask -> auto where Draft is offered', () => {
		expect(nextRungUp('off', true)).toBe('draft');
		expect(nextRungUp('draft', true)).toBe('ask');
		expect(nextRungUp('ask', true)).toBe('auto');
	});

	it('skips Draft where the category does not offer it', () => {
		expect(nextRungUp('off', false)).toBe('ask');
		expect(nextRungUp('ask', false)).toBe('auto');
	});

	it('answers null at the top of the ladder', () => {
		expect(nextRungUp('auto', true)).toBeNull();
		expect(nextRungUp('auto', false)).toBeNull();
	});

	it('answers null for a rung that is not on the offered ladder at all', () => {
		// `draft` on a non-draftable category: the row should never hold it, and
		// if one does, there is no promotion to offer.
		expect(nextRungUp('draft', false)).toBeNull();
	});
});

describe('offeredRungs', () => {
	it('offers all four when Draft is available', () => {
		expect([...offeredRungs(true)]).toEqual(['off', 'draft', 'ask', 'auto']);
	});

	it('offers three otherwise', () => {
		expect([...offeredRungs(false)]).toEqual(['off', 'ask', 'auto']);
	});
});

describe('isTrustRung', () => {
	it('accepts the four', () => {
		for (const rung of TRUST_RUNG_ORDER) expect(isTrustRung(rung)).toBe(true);
	});

	it('refuses everything else', () => {
		for (const value of [undefined, null, 0, 3, true, ['auto'], '', 'AUTO', 'autonomous'])
			expect(isTrustRung(value)).toBe(false);
	});
});
