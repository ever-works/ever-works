import { describe, expect, it } from 'vitest';

import { isSafeLauncherUrl, safeLauncherUrl } from '../safe-url.js';

/**
 * T11 / spec FR-30, FR-31, FR-32 and ACC-11-08, ACC-11-23.
 *
 * The element re-checks every address before it opens one — the "belt and
 * braces" of plan §6.3 — and the one property that matters for ACC-11-23 is
 * that the accepted string is returned **unchanged**: `new URL(...).toString()`
 * would silently add a trailing slash, and "the address equals the stored
 * address exactly — no added query, fragment or token" is the acceptance
 * criterion.
 */
describe('safe-url', () => {
	describe('refuses what FR-32 does not allow', () => {
		it.each([
			['a javascript: address', 'javascript:alert(1)'],
			['a javascript: address with the case folded', 'JavaScript:alert(1)'],
			['an http: address', 'http://example.com'],
			['an http: address on a LAN host', 'http://10.0.0.7:8080/app'],
			['a data: address', 'data:text/html,<script>alert(1)</script>'],
			['a file: address', 'file:///etc/passwd'],
			['a blob: address', 'blob:https://example.com/abc'],
			['a protocol-relative address', '//example.com'],
			['a relative address', '/works/123'],
			['a bare host', 'example.com'],
			['an empty string', ''],
			['whitespace only', '   ']
		])('%s', (_title, value) => {
			expect(safeLauncherUrl(value)).toBeNull();
			expect(isSafeLauncherUrl(value)).toBe(false);
			// The local-development allowance changes nothing for these.
			expect(safeLauncherUrl(value, { allowLocalhost: true })).toBeNull();
		});

		it.each([
			['null', null],
			['undefined', undefined],
			['a number', 42],
			['an object', { href: 'https://example.com' }]
		])('%s', (_title, value) => {
			expect(safeLauncherUrl(value as unknown as string)).toBeNull();
			expect(isSafeLauncherUrl(value as unknown as string)).toBe(false);
		});

		it('refuses an address carrying credentials', () => {
			// FR-31/ACC-11-24: no credential ever travels in a launcher address.
			expect(safeLauncherUrl('https://user:secret@example.com')).toBeNull();
			expect(safeLauncherUrl('https://user@example.com')).toBeNull();
			expect(safeLauncherUrl('https://:secret@example.com')).toBeNull();
			expect(safeLauncherUrl('http://user:secret@localhost:3000', { allowLocalhost: true })).toBeNull();
		});

		it('refuses an address padded with whitespace rather than trimming it', () => {
			// Accepting it would mean returning a string other than the one the
			// registry stored, which ACC-11-23 forbids.
			expect(safeLauncherUrl(' https://example.com')).toBeNull();
			expect(safeLauncherUrl('https://example.com ')).toBeNull();
			expect(safeLauncherUrl('https://example.com\n')).toBeNull();
		});
	});

	describe('accepts https unchanged (ACC-11-23)', () => {
		it.each([
			'https://example.com',
			'https://example.com/',
			'https://cal.example.com/booking?ref=launcher#top',
			'https://EXAMPLE.com/Path/Case',
			'https://example.com:8443/app',
			'https://xn--bcher-kva.example/',
			'https://127.0.0.1:8443/app',
			'https://localhost:3000'
		])('%s is returned exactly as given', (url) => {
			expect(safeLauncherUrl(url)).toBe(url);
			expect(isSafeLauncherUrl(url)).toBe(true);
		});

		it('adds nothing — not even the trailing slash the URL parser would add', () => {
			const stored = 'https://cal.example.com';
			const opened = safeLauncherUrl(stored);
			expect(opened).toBe(stored);
			expect(opened).not.toBe('https://cal.example.com/');
			expect(opened).not.toContain('?');
			expect(opened).not.toContain('#');
		});

		it('accepts a scheme written in upper case', () => {
			expect(safeLauncherUrl('HTTPS://example.com')).toBe('HTTPS://example.com');
		});
	});

	describe('localhost over http needs the local-development allowance (FR-32)', () => {
		it.each(['http://localhost', 'http://localhost:3000', 'http://localhost:3000/app?x=1'])(
			'%s is refused without the allowance',
			(url) => {
				expect(safeLauncherUrl(url)).toBeNull();
				expect(isSafeLauncherUrl(url)).toBe(false);
			}
		);

		it.each(['http://localhost', 'http://localhost:3000', 'http://localhost:3000/app?x=1'])(
			'%s is accepted, unchanged, with the allowance',
			(url) => {
				expect(safeLauncherUrl(url, { allowLocalhost: true })).toBe(url);
				expect(isSafeLauncherUrl(url, { allowLocalhost: true })).toBe(true);
			}
		);

		it.each(['http://127.0.0.1', 'http://127.0.0.1:8080/health'])(
			'%s is accepted, unchanged, with the allowance',
			(url) => {
				expect(safeLauncherUrl(url, { allowLocalhost: true })).toBe(url);
			}
		);

		it('refuses 127.0.0.1 without the allowance', () => {
			expect(safeLauncherUrl('http://127.0.0.1:8080')).toBeNull();
		});

		it('refuses a host that only looks like localhost', () => {
			for (const url of [
				'http://localhost.example.com',
				'http://notlocalhost',
				'http://127.0.0.1.example.com',
				'http://[::1]:3000'
			]) {
				expect(safeLauncherUrl(url, { allowLocalhost: true })).toBeNull();
			}
		});
	});
});
