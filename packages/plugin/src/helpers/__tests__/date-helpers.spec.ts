import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentDateString } from '../date-helpers.js';

describe('getCurrentDateString', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns a non-empty string', () => {
		const result = getCurrentDateString();
		expect(result.length).toBeGreaterThan(0);
	});

	it('matches the documented "Weekday, Month Year" shape', () => {
		const result = getCurrentDateString();
		expect(result).toMatch(/^[A-Za-z]+,\s[A-Za-z]+\s\d{4}$/);
	});

	it('uses the en-US weekday/month names for a fixed date', () => {
		// 2026-02-02 is a Monday (UTC). Pin both Date and Intl resolution.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-02-02T12:00:00Z'));

		const result = getCurrentDateString();

		expect(result).toContain('February');
		expect(result).toContain('2026');
		// Weekday must be one of the 7 long English names — locale is hard-coded
		// to en-US in the implementation regardless of the host locale.
		expect(result.split(',')[0]).toMatch(/^(Monday|Tuesday|Sunday)$/);
	});

	it('formats year with 4 digits', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2030-07-15T00:00:00Z'));

		const result = getCurrentDateString();

		expect(result).toMatch(/\b2030\b/);
		expect(result).toContain('July');
	});
});
