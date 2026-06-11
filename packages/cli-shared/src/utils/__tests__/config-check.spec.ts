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

	it('never returns an 8-char secret verbatim (no >50% leak)', () => {
		const secret = '12345678';
		const masked = maskSecret(secret);
		expect(masked).not.toBe(secret);
		expect(masked).toContain('*');
		expect(masked).toBe('****');
	});

	it('never returns a 9-char secret verbatim (no >50% leak)', () => {
		const secret = '123456789';
		const masked = maskSecret(secret);
		expect(masked).not.toBe(secret);
		expect(masked).toContain('*');
		expect(masked).toBe('****');
	});

	it('fully masks any secret shorter than 16 chars so the middle is never narrower than the edges', () => {
		// 15 chars: revealing first4+last4 would expose 8/15 (>50%) → fully masked.
		const secret = '123456789012345';
		const masked = maskSecret(secret);
		expect(masked).not.toBe(secret);
		expect(masked).toBe('****');
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
		const printed = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
		expect(printed).toMatch(/Configuration Error/);
		expect(printed).toMatch(/Auth key missing/);
	});

	it('prints each individual error in the errors[] list', () => {
		displayConfigurationError('Validation failed', ['err one', 'err two']);
		const printed = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
		expect(printed).toMatch(/err one/);
		expect(printed).toMatch(/err two/);
	});

	it('always points users at the setup command', () => {
		displayConfigurationError('msg');
		const printed = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
		expect(printed).toMatch(/ever-works config setup/);
	});

	it('skips the errors block when errors[] is empty or omitted', () => {
		displayConfigurationError('msg');
		const calls = logSpy.mock.calls.map((c: unknown[]) => c.join(' '));
		expect(calls.some((c: string) => /Errors:/.test(c))).toBe(false);

		logSpy.mockClear();
		displayConfigurationError('msg', []);
		const calls2 = logSpy.mock.calls.map((c: unknown[]) => c.join(' '));
		expect(calls2.some((c: string) => /Errors:/.test(c))).toBe(false);
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
		const printed = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
		expect(printed).toMatch(/Configuration Warnings/);
		expect(printed).toMatch(/outdated key/);
		expect(printed).toMatch(/deprecated provider/);
	});
});
