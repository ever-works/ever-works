import { computeNextHeartbeat } from '../heartbeat-cron';

describe('computeNextHeartbeat', () => {
	it('returns null for null / manual cadence', () => {
		expect(computeNextHeartbeat(null)).toBeNull();
		expect(computeNextHeartbeat('manual')).toBeNull();
	});

	it('returns null for unparseable cadence', () => {
		expect(computeNextHeartbeat('not a cron')).toBeNull();
		expect(computeNextHeartbeat('* * *')).toBeNull();
		expect(computeNextHeartbeat('60 * * * *')).toBeNull();
	});

	it('rounds "from" UP to the next whole minute and then matches the cron', () => {
		// "from" is 2026-05-26 12:34:17 UTC — next match for "*/5" is 12:35
		const from = new Date(Date.UTC(2026, 4, 26, 12, 34, 17));
		const next = computeNextHeartbeat('*/5 * * * *', from);
		expect(next?.toISOString()).toBe('2026-05-26T12:35:00.000Z');
	});

	it('never returns a value at or before "from" (advances even when "from" is exactly on the minute)', () => {
		const from = new Date(Date.UTC(2026, 4, 26, 12, 30, 0));
		const next = computeNextHeartbeat('*/15 * * * *', from);
		// 12:30 itself would match — but we must advance, so next is 12:45
		expect(next?.toISOString()).toBe('2026-05-26T12:45:00.000Z');
	});

	it('handles per-hour cadence ("0 * * * *")', () => {
		const from = new Date(Date.UTC(2026, 4, 26, 12, 0, 30));
		const next = computeNextHeartbeat('0 * * * *', from);
		expect(next?.toISOString()).toBe('2026-05-26T13:00:00.000Z');
	});

	it('handles daily cadence ("0 9 * * *")', () => {
		const from = new Date(Date.UTC(2026, 4, 26, 9, 0, 1));
		const next = computeNextHeartbeat('0 9 * * *', from);
		expect(next?.toISOString()).toBe('2026-05-27T09:00:00.000Z');
	});

	it('handles weekday cadence ("0 9 * * 1" = Monday 09:00 UTC)', () => {
		// 2026-05-26 is a Tuesday → next Monday 09:00 UTC is 2026-06-01
		const from = new Date(Date.UTC(2026, 4, 26, 12, 0, 0));
		const next = computeNextHeartbeat('0 9 * * 1', from);
		expect(next?.toISOString()).toBe('2026-06-01T09:00:00.000Z');
	});
});
