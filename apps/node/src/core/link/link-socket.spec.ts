import { describe, expect, it } from 'vitest';
import { isSecureLegOrigin, toComputerWsUrl } from '../screen/node-leg';
import { isSecureLinkOrigin, LinkBackoff, linkCloseCode, linkMessageBytes, toLinkWsUrl } from './link-socket';

describe('isSecureLinkOrigin', () => {
	it('allows https anywhere and plain http only to this machine’s loopback (FR-6)', () => {
		expect(isSecureLinkOrigin('https://api.ever.works')).toBe(true);
		expect(isSecureLinkOrigin('http://localhost:3100')).toBe(true);
		expect(isSecureLinkOrigin('http://127.0.0.1:3100')).toBe(true);
		expect(isSecureLinkOrigin('http://[::1]:3100')).toBe(true);
		expect(isSecureLinkOrigin('http://api.ever.works')).toBe(false);
		expect(isSecureLinkOrigin('http://localhost.example.com')).toBe(false);
		expect(isSecureLinkOrigin('ws://api.ever.works')).toBe(false);
		expect(isSecureLinkOrigin('nonsense')).toBe(false);
	});

	it('is the very rule the computer-session leg applies', () => {
		for (const origin of [
			'https://api.ever.works',
			'http://localhost:3100',
			'http://10.0.0.5:3100',
			'ftp://x',
			'not a url'
		]) {
			expect(isSecureLegOrigin(origin)).toBe(isSecureLinkOrigin(origin));
		}
		expect(toComputerWsUrl('https://api.ever.works/api', '/ws/computer/x')).toBe(
			toLinkWsUrl('https://api.ever.works/api', '/ws/computer/x')
		);
	});
});

describe('toLinkWsUrl', () => {
	it('keeps the origin, swaps the scheme and never adds a query string', () => {
		expect(toLinkWsUrl('https://api.ever.works/api', '/ws/fleet/link')).toBe('wss://api.ever.works/ws/fleet/link');
		expect(toLinkWsUrl('http://localhost:3100', 'ws/fleet/link')).toBe('ws://localhost:3100/ws/fleet/link');
	});
});

describe('LinkBackoff', () => {
	it('climbs 1 s → 30 s and stays at the ceiling (CONTRACTS §3.1)', () => {
		const backoff = new LinkBackoff({ jitter: 0 });
		expect(Array.from({ length: 8 }, () => backoff.next())).toEqual([
			1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000
		]);
	});

	it('spreads each wait by the jitter but never below the base or above the ceiling', () => {
		const low = new LinkBackoff({ jitter: 0.2, random: () => 0 });
		const high = new LinkBackoff({ jitter: 0.2, random: () => 1 });
		const lows = Array.from({ length: 7 }, () => low.next());
		const highs = Array.from({ length: 7 }, () => high.next());
		expect(lows).toEqual([1_000, 1_600, 3_200, 6_400, 12_800, 24_000, 24_000]);
		expect(highs).toEqual([1_200, 2_400, 4_800, 9_600, 19_200, 30_000, 30_000]);
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const random = new LinkBackoff({ random: Math.random });
			for (let i = 0; i <= attempt % 10; i += 1) {
				const wait = random.next();
				expect(wait).toBeGreaterThanOrEqual(1_000);
				expect(wait).toBeLessThanOrEqual(30_000);
			}
		}
	});

	it('starts over only when reset (an accepted link)', () => {
		const backoff = new LinkBackoff({ jitter: 0 });
		backoff.next();
		backoff.next();
		backoff.next();
		expect(backoff.attempts).toBe(3);
		expect(backoff.next()).toBe(8_000);
		backoff.reset();
		expect(backoff.next()).toBe(1_000);
	});
});

describe('socket helpers', () => {
	it('reads binary messages only and the close code when present', () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(linkMessageBytes(bytes)).toBe(bytes);
		expect([...linkMessageBytes(bytes.buffer)!]).toEqual([1, 2, 3]);
		expect(linkMessageBytes('text')).toBeNull();
		expect(linkMessageBytes(null)).toBeNull();
		expect(linkCloseCode({ code: 4003 })).toBe(4003);
		expect(linkCloseCode({})).toBeNull();
		expect(linkCloseCode(undefined)).toBeNull();
	});
});
