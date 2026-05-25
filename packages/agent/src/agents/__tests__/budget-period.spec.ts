import {
	getCurrentPeriodStart,
	getNextPeriodStart,
	isWithinCurrentPeriod,
} from '../budget-period';

describe('budget-period (Phase 7.6 — N6 override)', () => {
	describe('hour', () => {
		it('current period anchor is start of the UTC hour', () => {
			const now = new Date(Date.UTC(2026, 4, 26, 14, 37, 22));
			const start = getCurrentPeriodStart('hour', now);
			expect(start.toISOString()).toBe('2026-05-26T14:00:00.000Z');
		});
		it('next period is +1 hour', () => {
			const now = new Date(Date.UTC(2026, 4, 26, 14, 37, 22));
			expect(getNextPeriodStart('hour', now).toISOString()).toBe('2026-05-26T15:00:00.000Z');
		});
		it('intervalCount=6 buckets into 6h slots', () => {
			const now = new Date(Date.UTC(2026, 4, 26, 14, 0, 0));
			const start = getCurrentPeriodStart('hour', now, 6);
			expect(start.getUTCHours() % 6).toBe(0);
			const next = getNextPeriodStart('hour', now, 6);
			expect(next.getTime() - start.getTime()).toBe(6 * 3_600_000);
		});
	});

	describe('day', () => {
		it('current period anchor is start of UTC day', () => {
			const now = new Date(Date.UTC(2026, 4, 26, 14, 37, 22));
			expect(getCurrentPeriodStart('day', now).toISOString()).toBe('2026-05-26T00:00:00.000Z');
			expect(getNextPeriodStart('day', now).toISOString()).toBe('2026-05-27T00:00:00.000Z');
		});
	});

	describe('week', () => {
		it('current period anchor is Monday 00:00 UTC (ISO-8601)', () => {
			// 2026-05-26 is a Tuesday — Monday is the 25th
			const now = new Date(Date.UTC(2026, 4, 26, 14, 0, 0));
			expect(getCurrentPeriodStart('week', now).toISOString()).toBe('2026-05-25T00:00:00.000Z');
		});
		it('handles Sunday correctly (Sunday belongs to the preceding week)', () => {
			// 2026-05-31 is a Sunday — same week as Monday 2026-05-25
			const now = new Date(Date.UTC(2026, 4, 31, 23, 59, 59));
			expect(getCurrentPeriodStart('week', now).toISOString()).toBe('2026-05-25T00:00:00.000Z');
		});
		it('next period is +7 days', () => {
			const now = new Date(Date.UTC(2026, 4, 26, 14, 0, 0));
			expect(getNextPeriodStart('week', now).toISOString()).toBe('2026-06-01T00:00:00.000Z');
		});
	});

	describe('month', () => {
		it('current period anchor is the 1st of the UTC month', () => {
			const now = new Date(Date.UTC(2026, 4, 26, 14, 37, 22));
			expect(getCurrentPeriodStart('month', now).toISOString()).toBe('2026-05-01T00:00:00.000Z');
		});
		it('next period rolls to the 1st of the next month', () => {
			const now = new Date(Date.UTC(2026, 4, 26));
			expect(getNextPeriodStart('month', now).toISOString()).toBe('2026-06-01T00:00:00.000Z');
		});
		it('handles December → January rollover', () => {
			const now = new Date(Date.UTC(2026, 11, 15));
			expect(getNextPeriodStart('month', now).toISOString()).toBe('2027-01-01T00:00:00.000Z');
		});
		it('intervalCount=3 buckets into quarters from epoch', () => {
			// epoch month index for 2026-05 is (2026-1970)*12 + 4 = 676
			// 676 / 3 = 225.33 → slot 225 → epoch year 1970 + 225/12 = +18y9m = 1988? Not user-friendly.
			// We assert the property, not the absolute value: bucket size is 3 months.
			const a = getCurrentPeriodStart('month', new Date(Date.UTC(2026, 4, 26)), 3);
			const b = getNextPeriodStart('month', new Date(Date.UTC(2026, 4, 26)), 3);
			expect(b.getUTCMonth() - a.getUTCMonth() + (b.getUTCFullYear() - a.getUTCFullYear()) * 12).toBe(3);
		});
	});

	describe('unlimited', () => {
		it('start is epoch 0; next is "max representable Date" (effectively +Infinity)', () => {
			const start = getCurrentPeriodStart('unlimited');
			const next = getNextPeriodStart('unlimited');
			expect(start.getTime()).toBe(0);
			expect(next.getTime()).toBeGreaterThan(Date.now() * 1000);
		});
	});

	describe('isWithinCurrentPeriod', () => {
		it('true for a Date inside the current hour, false for the previous hour', () => {
			const now = new Date(Date.UTC(2026, 4, 26, 14, 30, 0));
			expect(isWithinCurrentPeriod('hour', new Date(Date.UTC(2026, 4, 26, 14, 5, 0)), now)).toBe(true);
			expect(isWithinCurrentPeriod('hour', new Date(Date.UTC(2026, 4, 26, 13, 59, 59)), now)).toBe(false);
		});
		it('true for a Date inside the current week', () => {
			const now = new Date(Date.UTC(2026, 4, 26, 14, 0, 0));
			expect(isWithinCurrentPeriod('week', new Date(Date.UTC(2026, 4, 25, 0, 0, 0)), now)).toBe(true);
			expect(isWithinCurrentPeriod('week', new Date(Date.UTC(2026, 4, 31, 23, 0, 0)), now)).toBe(true);
			expect(isWithinCurrentPeriod('week', new Date(Date.UTC(2026, 4, 24, 23, 59, 59)), now)).toBe(false);
		});
		it('unlimited always returns true', () => {
			expect(isWithinCurrentPeriod('unlimited', new Date(0))).toBe(true);
			expect(isWithinCurrentPeriod('unlimited', new Date('2099-12-31'))).toBe(true);
		});
	});
});
