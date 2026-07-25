import { describe, expect, it } from 'vitest';
import { checkHealthOnce, waitForHealthy } from './health';

describe('checkHealthOnce', () => {
	it('returns true for an ok response', async () => {
		expect(await checkHealthOnce('http://x/health', async () => ({ ok: true, status: 200 }))).toBe(true);
	});

	it('returns false for a non-ok response', async () => {
		expect(await checkHealthOnce('http://x/health', async () => ({ ok: false, status: 503 }))).toBe(false);
	});

	it('returns false when the request throws (service not up yet)', async () => {
		expect(
			await checkHealthOnce('http://x/health', async () => {
				throw new Error('ECONNREFUSED');
			})
		).toBe(false);
	});
});

describe('waitForHealthy', () => {
	it('polls until the endpoint reports healthy', async () => {
		let calls = 0;
		const healthy = await waitForHealthy('http://x/health', {
			fetchFn: async () => {
				calls += 1;
				return { ok: calls >= 3, status: calls >= 3 ? 200 : 503 };
			},
			intervalMs: 5,
			timeoutMs: 10_000,
			sleep: async () => {},
			now: () => 0
		});
		expect(healthy).toBe(true);
		expect(calls).toBe(3);
	});

	it('gives up once the timeout elapses', async () => {
		let clock = 0;
		let calls = 0;
		const healthy = await waitForHealthy('http://x/health', {
			fetchFn: async () => {
				calls += 1;
				return { ok: false, status: 503 };
			},
			intervalMs: 5,
			timeoutMs: 10,
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock
		});
		expect(healthy).toBe(false);
		expect(calls).toBe(3); // t=0, t=5, t=10 → timeout
	});
});
