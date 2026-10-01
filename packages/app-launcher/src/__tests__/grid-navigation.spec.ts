import { describe, expect, it } from 'vitest';

import {
	CONTROL_OPEN_KEYS,
	GRID_NAVIGATION_KEYS,
	isControlOpenKey,
	isGridNavigationKey,
	isTypeaheadKey,
	nextGridIndex,
	typeaheadIndex
} from '../grid-navigation.js';

/**
 * T11 / spec §6.6 — the keyboard model of the panel grid.
 *
 * The table the tests walk, at both column counts the element can have
 * (FR-3: 3 columns at ≥ 360 px, else 2):
 *
 * | Key             | Action              |
 * | --------------- | ------------------- |
 * | `←` `→`         | Previous / next     |
 * | `↑` `↓`         | Above / below (a row is `columns` tiles) |
 * | `Home` / `End`  | First / last tile   |
 * | a letter        | Next tile whose name starts with it (wrap-around) |
 *
 * The two deliberate asymmetries, both asserted below:
 *  - arrows **clamp** (the spec gives them no wrap-around);
 *  - typeahead **wraps** (T11: "typeahead wrap-around").
 */
describe('grid-navigation', () => {
	describe('spec §6.6 key table at 3 columns', () => {
		const columns = 3;
		const count = 8;

		it.each([
			['ArrowRight advances one tile', 'ArrowRight', 0, 1],
			['ArrowRight from the middle', 'ArrowRight', 2, 3],
			['ArrowRight clamps on the last tile', 'ArrowRight', 7, 7],
			['ArrowLeft retreats one tile', 'ArrowLeft', 3, 2],
			['ArrowLeft clamps on the first tile', 'ArrowLeft', 0, 0],
			['ArrowDown drops one row', 'ArrowDown', 0, 3],
			['ArrowDown clamps in a partial last row', 'ArrowDown', 6, 7],
			['ArrowUp climbs one row', 'ArrowUp', 7, 4],
			['ArrowUp clamps on the first row', 'ArrowUp', 1, 0],
			['Home jumps to the first tile', 'Home', 5, 0],
			['End jumps to the last tile', 'End', 5, 7]
		])('%s', (_title, key, index, expected) => {
			expect(nextGridIndex({ key, index, columns, count })).toBe(expected);
		});
	});

	describe('spec §6.6 key table at 2 columns', () => {
		const columns = 2;
		const count = 8;

		it.each([
			['ArrowRight advances one tile', 'ArrowRight', 0, 1],
			['ArrowRight clamps on the last tile', 'ArrowRight', 7, 7],
			['ArrowLeft retreats one tile', 'ArrowLeft', 4, 3],
			['ArrowLeft clamps on the first tile', 'ArrowLeft', 0, 0],
			['ArrowDown drops one row', 'ArrowDown', 0, 2],
			['ArrowDown clamps in a partial last row', 'ArrowDown', 7, 7],
			['ArrowUp climbs one row', 'ArrowUp', 7, 5],
			['ArrowUp clamps on the first row', 'ArrowUp', 1, 0],
			['Home jumps to the first tile', 'Home', 3, 0],
			['End jumps to the last tile', 'End', 3, 7]
		])('%s', (_title, key, index, expected) => {
			expect(nextGridIndex({ key, index, columns, count })).toBe(expected);
		});
	});

	describe('edges', () => {
		it('leaves every key on the only tile at index 0', () => {
			for (const key of GRID_NAVIGATION_KEYS) {
				expect(nextGridIndex({ key, index: 0, columns: 3, count: 1 })).toBe(0);
			}
		});

		it('answers null when there is nothing to navigate', () => {
			for (const key of GRID_NAVIGATION_KEYS) {
				expect(nextGridIndex({ key, index: 0, columns: 3, count: 0 })).toBeNull();
			}
		});

		it('answers null for a key it does not own', () => {
			// `Enter`, `Tab`, `Esc` and letters belong to the element, not here.
			for (const key of ['Enter', 'Tab', 'Escape', 'a', ' ', 'F5', 'PageDown']) {
				expect(nextGridIndex({ key, index: 0, columns: 3, count: 6 })).toBeNull();
			}
		});

		it('treats a non-positive column count as nothing to navigate', () => {
			expect(nextGridIndex({ key: 'ArrowDown', index: 0, columns: 0, count: 6 })).toBeNull();
			expect(nextGridIndex({ key: 'ArrowDown', index: 0, columns: -2, count: 6 })).toBeNull();
			expect(nextGridIndex({ key: 'ArrowRight', index: 0, columns: 0, count: 6 })).toBeNull();
		});

		it('still moves one tile at a time when a single column is reported', () => {
			expect(nextGridIndex({ key: 'ArrowDown', index: 0, columns: 1, count: 3 })).toBe(1);
			expect(nextGridIndex({ key: 'ArrowUp', index: 2, columns: 1, count: 3 })).toBe(1);
		});

		it('normalises an index outside the grid before moving', () => {
			expect(nextGridIndex({ key: 'ArrowRight', index: 99, columns: 3, count: 5 })).toBe(4);
			expect(nextGridIndex({ key: 'ArrowLeft', index: 99, columns: 3, count: 5 })).toBe(3);
			expect(nextGridIndex({ key: 'ArrowRight', index: -3, columns: 3, count: 5 })).toBe(1);
			expect(nextGridIndex({ key: 'Home', index: 99, columns: 3, count: 5 })).toBe(0);
		});

		it('treats an index that is not a finite number as the first tile', () => {
			expect(nextGridIndex({ key: 'ArrowRight', index: Number.NaN, columns: 3, count: 5 })).toBe(1);
			expect(nextGridIndex({ key: 'ArrowLeft', index: Number.POSITIVE_INFINITY, columns: 3, count: 5 })).toBe(0);
			expect(nextGridIndex({ key: 'End', index: Number.NEGATIVE_INFINITY, columns: 3, count: 5 })).toBe(4);
			expect(nextGridIndex({ key: 'ArrowRight', index: 1.7, columns: 3, count: 5 })).toBe(2);
		});
	});

	describe('key classification', () => {
		it('owns exactly the grid keys of §6.6', () => {
			expect([...GRID_NAVIGATION_KEYS]).toEqual([
				'ArrowLeft',
				'ArrowRight',
				'ArrowUp',
				'ArrowDown',
				'Home',
				'End'
			]);
			for (const key of GRID_NAVIGATION_KEYS) expect(isGridNavigationKey(key)).toBe(true);
			for (const key of ['Enter', ' ', 'Escape', 'Tab', 'a']) expect(isGridNavigationKey(key)).toBe(false);
		});

		it('opens the panel on Enter, Space and ArrowDown (the Control row)', () => {
			expect([...CONTROL_OPEN_KEYS]).toEqual(['Enter', ' ', 'Spacebar', 'ArrowDown']);
			expect(isControlOpenKey('Enter')).toBe(true);
			expect(isControlOpenKey(' ')).toBe(true);
			expect(isControlOpenKey('Spacebar')).toBe(true);
			expect(isControlOpenKey('ArrowDown')).toBe(true);
			expect(isControlOpenKey('ArrowUp')).toBe(false);
			expect(isControlOpenKey('Escape')).toBe(false);
			expect(isControlOpenKey('a')).toBe(false);
		});

		it('accepts one letter as a typeahead key and nothing else', () => {
			expect(isTypeaheadKey('a')).toBe(true);
			expect(isTypeaheadKey('Z')).toBe(true);
			expect(isTypeaheadKey('1')).toBe(false);
			expect(isTypeaheadKey('ab')).toBe(false);
			expect(isTypeaheadKey('')).toBe(false);
			expect(isTypeaheadKey(' ')).toBe(false);
			expect(isTypeaheadKey('ArrowDown')).toBe(false);
			expect(isTypeaheadKey('é')).toBe(false);
		});
	});

	describe('typeahead', () => {
		const names = ['Cal', 'Ever Gauzy', 'Ever Teams', 'Umami'];

		it('moves to the next tile whose name starts with the letter', () => {
			expect(typeaheadIndex(names, 0, 'e')).toBe(1);
			expect(typeaheadIndex(names, 1, 'e')).toBe(2);
			expect(typeaheadIndex(names, 0, 'u')).toBe(3);
		});

		it('matches without regard to case', () => {
			expect(typeaheadIndex(names, 0, 'E')).toBe(1);
			expect(typeaheadIndex(names, 3, 'c')).toBe(0);
		});

		it('wraps around the end of the grid', () => {
			expect(typeaheadIndex(names, 3, 'c')).toBe(0);
			expect(typeaheadIndex(names, 2, 'c')).toBe(0);
			expect(typeaheadIndex(names, 3, 'e')).toBe(1);
		});

		it('searches strictly after the current tile, so it never reports a no-op', () => {
			// `Cal` is the only match and it is the tile we are already on: the
			// wrapped search lands back on it, which is not a move.
			expect(typeaheadIndex(['Cal', 'Beta'], 0, 'c')).toBeNull();
		});

		it('answers null when nothing matches', () => {
			expect(typeaheadIndex(names, 0, 'z')).toBeNull();
			expect(typeaheadIndex([], 0, 'a')).toBeNull();
		});

		it('skips empty names and non-letter keys', () => {
			expect(typeaheadIndex(['', 'Cal'], 0, 'c')).toBe(1);
			expect(typeaheadIndex(['Cal', ''], 0, 'x')).toBeNull();
			expect(typeaheadIndex(names, 0, '1')).toBeNull();
			expect(typeaheadIndex(names, 0, 'ArrowRight')).toBeNull();
		});

		it('normalises a current index outside the grid', () => {
			expect(typeaheadIndex(names, 99, 'c')).toBe(0);
			expect(typeaheadIndex(names, -1, 'e')).toBe(1);
		});

		it('has nowhere to go on a single tile', () => {
			expect(typeaheadIndex(['Cal'], 0, 'c')).toBeNull();
			expect(typeaheadIndex(['Cal'], 0, 'z')).toBeNull();
		});
	});
});
