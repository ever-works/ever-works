import { describe, expect, it } from 'vitest';
import {
	INBOX_ITEM_KINDS,
	INBOX_ITEM_SOURCE_TYPES,
	INBOX_ITEM_STATUSES,
	INBOX_MAX_OPTIONS,
	INBOX_MAX_OPTION_ID_CHARS,
	INBOX_MAX_OPTION_LABEL_CHARS,
	normalizeInboxOptions
} from '../inbox.types.js';

/**
 * `normalizeInboxOptions` is the trust boundary for the one field a
 * MODEL controls end to end: an `ask_human` option list arrives as raw
 * tool arguments and is rendered as clickable buttons whose id comes
 * back as the recorded answer. Everything unanswerable or unbounded has
 * to die here, before it reaches the column.
 */
describe('normalizeInboxOptions', () => {
	it('returns null for non-arrays, empty arrays and all-garbage arrays', () => {
		expect(normalizeInboxOptions(undefined)).toBeNull();
		expect(normalizeInboxOptions(null)).toBeNull();
		expect(normalizeInboxOptions('approve')).toBeNull();
		expect(normalizeInboxOptions([])).toBeNull();
		expect(normalizeInboxOptions([1, 'x', null, []])).toBeNull();
	});

	it('keeps id + label and trims both', () => {
		expect(normalizeInboxOptions([{ id: '  a  ', label: '  Ship it  ' }])).toEqual([{ id: 'a', label: 'Ship it' }]);
	});

	it('drops options with no usable id or label', () => {
		expect(
			normalizeInboxOptions([
				{ id: 'a', label: 'Keep' },
				{ id: '   ', label: 'No id' },
				{ id: 'b' },
				{ label: 'No id at all' },
				{ id: 'c', label: 42 }
			])
		).toEqual([{ id: 'a', label: 'Keep' }]);
	});

	it('drops duplicate ids rather than letting the answer be ambiguous', () => {
		expect(
			normalizeInboxOptions([
				{ id: 'a', label: 'First' },
				{ id: 'a', label: 'Second' }
			])
		).toEqual([{ id: 'a', label: 'First' }]);
	});

	it('carries description and recommended only when they are usable', () => {
		expect(
			normalizeInboxOptions([
				{ id: 'a', label: 'A', description: '  why  ', recommended: true },
				{ id: 'b', label: 'B', description: '   ', recommended: 'yes' }
			])
		).toEqual([
			{ id: 'a', label: 'A', description: 'why', recommended: true },
			{ id: 'b', label: 'B' }
		]);
	});

	it('caps the option count and every string length', () => {
		const many = Array.from({ length: INBOX_MAX_OPTIONS + 5 }, (_, index) => ({
			id: `id-${index}`,
			label: `Label ${index}`
		}));
		expect(normalizeInboxOptions(many)).toHaveLength(INBOX_MAX_OPTIONS);

		const [long] = normalizeInboxOptions([
			{
				id: 'x'.repeat(INBOX_MAX_OPTION_ID_CHARS + 50),
				label: 'y'.repeat(INBOX_MAX_OPTION_LABEL_CHARS + 50),
				description: 'z'.repeat(INBOX_MAX_OPTION_LABEL_CHARS + 50)
			}
		])!;
		expect(long.id).toHaveLength(INBOX_MAX_OPTION_ID_CHARS);
		expect(long.label).toHaveLength(INBOX_MAX_OPTION_LABEL_CHARS);
		expect(long.description).toHaveLength(INBOX_MAX_OPTION_LABEL_CHARS);
	});

	it('is idempotent — normalizing its own output changes nothing', () => {
		const once = normalizeInboxOptions([
			{ id: 'a', label: 'A', recommended: true },
			{ id: 'b', label: 'B' }
		]);
		expect(normalizeInboxOptions(once)).toEqual(once);
	});
});

describe('closed value sets', () => {
	it('has no duplicates and matches the entity column widths', () => {
		for (const set of [INBOX_ITEM_KINDS, INBOX_ITEM_STATUSES, INBOX_ITEM_SOURCE_TYPES]) {
			expect(new Set(set).size).toBe(set.length);
		}
		// `kind` / `status` are varchar(16), `sourceType` is varchar(24).
		expect(Math.max(...INBOX_ITEM_KINDS.map((v) => v.length))).toBeLessThanOrEqual(16);
		expect(Math.max(...INBOX_ITEM_STATUSES.map((v) => v.length))).toBeLessThanOrEqual(16);
		expect(Math.max(...INBOX_ITEM_SOURCE_TYPES.map((v) => v.length))).toBeLessThanOrEqual(24);
	});
});
