import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { maskSecret, displayConfigurationError, displayConfigurationWarnings } from '../config-check.js';

describe('maskSecret', () => {
	it('returns **** for short or empty values', () => {
		expect(maskSecret('')).toBe('****');
		expect(maskSecret('short')).toBe('****');
		expect(maskSecret('1234567')).toBe('****');
	});

	it('shows first and last 4 characters of long secrets', () => {
		const secret = 'abcdef1234567890';
		const masked = maskSecret(secret);
		expect(masked.startsWith('abcd')).toBe(true);
		expect(masked.endsWith('7890')).toBe(true);
		expect(masked).toBe('abcd' + '*'.repeat(8) + '7890');
		expect(masked.length).toBe(secret.length);
	});

	it('handles the boundary value (exactly 8 chars) by returning input unchanged', () => {
		// length === MIN_SECRET_LENGTH: not short, but length-MIN=0 → no middle stars
		// so first4 + '' + last4 reconstructs the original.
		expect(maskSecret('12345678')).toBe('12345678');
	});

	it('handles a 9-character secret with one masked middle char', () => {
		const masked = maskSecret('123456789');
		expect(masked.length).toBe(9);
		expect(masked.startsWith('1234')).toBe(true);
		expect(masked.endsWith('6789')).toBe(true);
		expect(masked.charAt(4)).toBe('*');
	});
});

describe('displayConfigurationError', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('prints the error header and message', () => {
		displayConfigurationError('Auth key missing');
		const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(printed).toMatch(/Configuration Error/);
		expect(printed).toMatch(/Auth key missing/);
	});

	it('prints each individual error in the errors[] list', () => {
		displayConfigurationError('Validation failed', ['err one', 'err two']);
		const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(printed).toMatch(/err one/);
		expect(printed).toMatch(/err two/);
	});

	it('always points users at the setup command', () => {
		displayConfigurationError('msg');
		const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(printed).toMatch(/ever-works config setup/);
	});

	it('skips the errors block when errors[] is empty or omitted', () => {
		displayConfigurationError('msg');
		const calls = logSpy.mock.calls.map((c) => c.join(' '));
		expect(calls.some((c) => /Errors:/.test(c))).toBe(false);

		logSpy.mockClear();
		displayConfigurationError('msg', []);
		const calls2 = logSpy.mock.calls.map((c) => c.join(' '));
		expect(calls2.some((c) => /Errors:/.test(c))).toBe(false);
	});
});

describe('displayConfigurationWarnings', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('prints nothing when warnings[] is empty', () => {
		displayConfigurationWarnings([]);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it('prints the warning header and each warning when non-empty', () => {
		displayConfigurationWarnings(['outdated key', 'deprecated provider']);
		const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(printed).toMatch(/Configuration Warnings/);
		expect(printed).toMatch(/outdated key/);
		expect(printed).toMatch(/deprecated provider/);
	});
});
