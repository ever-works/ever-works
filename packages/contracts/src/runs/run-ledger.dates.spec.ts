import { describe, expect, it } from 'vitest';
import { isRunLedgerCalendarDate } from './run-ledger.dates.js';

describe('isRunLedgerCalendarDate', () => {
	it('accepts real calendar days, including a leap day and every month end', () => {
		for (const date of ['2026-09-13', '2028-02-29', '2000-02-29', '2026-01-31', '2026-04-30', '2026-12-31']) {
			expect(isRunLedgerCalendarDate(date)).toBe(true);
		}
	});

	it('rejects a well-shaped date that names no real day', () => {
		for (const date of [
			'2026-02-31',
			'2026-02-29',
			'1900-02-29',
			'2026-04-31',
			'2026-13-01',
			'2026-00-10',
			'2026-09-00'
		]) {
			expect(isRunLedgerCalendarDate(date)).toBe(false);
		}
	});

	it('rejects anything that is not a YYYY-MM-DD string', () => {
		for (const value of [
			'8/9/2026',
			'2026-9-13',
			'2026-09-13T00:00:00Z',
			' 2026-09-13',
			'',
			null,
			undefined,
			20260913
		]) {
			expect(isRunLedgerCalendarDate(value)).toBe(false);
		}
	});

	it('keeps a two-digit year literal rather than mapping it into the 1900s', () => {
		expect(isRunLedgerCalendarDate('0050-01-01')).toBe(true);
		expect(isRunLedgerCalendarDate('0050-02-29')).toBe(false);
	});
});
