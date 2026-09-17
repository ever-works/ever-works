import { describe, expect, it } from 'vitest';
import {
	HOME_BLOCK_IDS,
	HOME_SCHEDULE_KINDS,
	homeCapTone,
	homeRunChip,
	homeWaitingTone,
	isHomeBlockId,
	isHomeDecisionOverdue,
	isHomeTimezone,
	parseHomeBlockIds,
	truncateHomeText
} from '../home.types.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * The Home thresholds are read by the API (which computes the numbers) and the
 * web (which colours them). Pinning them here keeps both sides on one rule.
 */
describe('home contract', () => {
	it('lists the six read blocks in default display order', () => {
		expect(HOME_BLOCK_IDS).toEqual(['needsYou', 'glance', 'today', 'thisWeek', 'workingNow', 'recentActivity']);
	});

	it('names every one of the seven schedule kinds', () => {
		expect(HOME_SCHEDULE_KINDS).toHaveLength(7);
		expect(new Set(HOME_SCHEDULE_KINDS).size).toBe(7);
	});

	describe('parseHomeBlockIds', () => {
		it('accepts a CSV and returns ids in display order without duplicates', () => {
			expect(parseHomeBlockIds('today, needsYou,today')).toEqual(['needsYou', 'today']);
		});

		it('accepts an array', () => {
			expect(parseHomeBlockIds(['recentActivity', 'glance'])).toEqual(['glance', 'recentActivity']);
		});

		it('refuses an unknown id rather than dropping it', () => {
			expect(parseHomeBlockIds('today,tomorrow')).toBeNull();
			expect(parseHomeBlockIds([1])).toBeNull();
			expect(parseHomeBlockIds(42)).toBeNull();
		});

		it('reads an empty selection as no blocks', () => {
			expect(parseHomeBlockIds('')).toEqual([]);
		});

		it('guards block ids', () => {
			expect(isHomeBlockId('thisWeek')).toBe(true);
			expect(isHomeBlockId('ThisWeek')).toBe(false);
		});
	});

	it('accepts timezones the runtime can compute a day in, including UTC and current names', () => {
		for (const zone of ['UTC', 'GMT', 'Europe/Kyiv', 'America/New_York', 'Pacific/Kiritimati']) {
			expect(isHomeTimezone(zone)).toBe(true);
		}
		for (const zone of ['', 'Mars/Olympus_Mons', 'x'.repeat(65), 42, null]) {
			expect(isHomeTimezone(zone)).toBe(false);
		}
	});

	describe('truncateHomeText', () => {
		it('keeps text at the limit untouched', () => {
			expect(truncateHomeText('a'.repeat(120), 120)).toBe('a'.repeat(120));
		});

		it('cuts one character past the limit to exactly the limit, ending in an ellipsis', () => {
			const cut = truncateHomeText('a'.repeat(121), 120);
			expect(cut).toHaveLength(120);
			expect(cut?.endsWith('…')).toBe(true);
		});

		it('collapses whitespace to a single line and returns null for blank input', () => {
			expect(truncateHomeText('  two\n\nlines  ', 60)).toBe('two lines');
			expect(truncateHomeText('   ', 60)).toBeNull();
			expect(truncateHomeText(null, 60)).toBeNull();
		});
	});

	describe('waiting chip', () => {
		it('is neutral under 24 hours, amber from 24 hours and danger from 72 hours', () => {
			expect(homeWaitingTone(24 * HOUR - 1)).toBe('neutral');
			expect(homeWaitingTone(24 * HOUR)).toBe('warning');
			expect(homeWaitingTone(72 * HOUR - 1)).toBe('warning');
			expect(homeWaitingTone(72 * HOUR)).toBe('danger');
		});

		it('counts a decision as overdue from exactly 72 hours', () => {
			expect(isHomeDecisionOverdue(72 * HOUR - 1)).toBe(false);
			expect(isHomeDecisionOverdue(72 * HOUR)).toBe(true);
		});
	});

	it('marks a long run from 30 minutes and a still-going run from 120 minutes', () => {
		expect(homeRunChip(30 * MINUTE - 1)).toBeNull();
		expect(homeRunChip(30 * MINUTE)).toBe('longRun');
		expect(homeRunChip(120 * MINUTE - 1)).toBe('longRun');
		expect(homeRunChip(120 * MINUTE)).toBe('stillGoing');
	});

	it('tones the cap bar neutral below 80 %, amber from 80 % and danger from 100 %', () => {
		expect(homeCapTone(79.9)).toBe('neutral');
		expect(homeCapTone(80)).toBe('warning');
		expect(homeCapTone(99.9)).toBe('warning');
		expect(homeCapTone(100)).toBe('danger');
	});
});
