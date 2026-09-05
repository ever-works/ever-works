import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import { FleetJobClient } from './job-client';
import type { FetchLike } from './fleet-client';

const NODE_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';

function response(status: number, body: unknown): FetchLike {
	return async () => ({
		ok: status < 400,
		status,
		text: async () => JSON.stringify(body)
	});
}

function job(leaseExpiresAt: string): FleetJobView {
	return {
		id: 'job-1',
		kind: 'agent-task',
		status: 'running',
		nodeId: NODE_ID,
		requiredCapabilities: [],
		payload: null,
		leaseExpiresAt,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null
	};
}

describe('FleetJobClient heartbeat lease proof', () => {
	it('returns the exact server job view so the worker uses the wire lease expiry', async () => {
		const expected = job('2026-08-23T00:30:45.123Z');
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn: response(200, { ok: true, job: expected }),
			timeoutMs: 0
		});

		await expect(client.heartbeat('job-1', 30)).resolves.toEqual(expected);
	});

	it('returns null for a terminal or foreign lease without exposing the server body', async () => {
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn: response(401, { error: 'private detail' }),
			timeoutMs: 0
		});

		await expect(client.heartbeat('job-1', 30)).resolves.toBeNull();
	});
});

describe('FleetJobClient lease generation (suspend-safe leases)', () => {
	function capturing(status: number, body: unknown): { fetchFn: FetchLike; bodies: Array<Record<string, unknown>> } {
		const bodies: Array<Record<string, unknown>> = [];
		const fetchFn: FetchLike = async (_url, init) => {
			bodies.push(JSON.parse(init.body) as Record<string, unknown>);
			return { ok: status < 400, status, text: async () => JSON.stringify(body) };
		};
		return { fetchFn, bodies };
	}

	it('sends the generation on heartbeat and complete when the lease carried one', async () => {
		const { fetchFn, bodies } = capturing(200, { ok: true, job: job('2026-08-23T00:30:45.123Z') });
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn,
			timeoutMs: 0
		});

		await client.heartbeat('job-1', 30, 4);
		await client.complete('job-1', { success: true, result: { ok: true } }, 4);

		expect(bodies[0]).toMatchObject({ nodeId: NODE_ID, leaseTtlSec: 30, leaseGeneration: 4 });
		expect(bodies[1]).toMatchObject({ nodeId: NODE_ID, success: true, leaseGeneration: 4 });
	});

	it('omits the field entirely when the lease carried none (an older API would 400 an unknown field)', async () => {
		const { fetchFn, bodies } = capturing(200, { ok: true, job: job('2026-08-23T00:30:45.123Z') });
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn,
			timeoutMs: 0
		});

		await client.heartbeat('job-1', 30);
		await client.complete('job-1', { success: false, error: 'exit 1' });

		expect(bodies[0]).not.toHaveProperty('leaseGeneration');
		expect(bodies[1]).not.toHaveProperty('leaseGeneration');
	});

	it('THROWS stale-lease on a 409 from heartbeat rather than collapsing it to null', async () => {
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn: response(409, { statusCode: 409, reason: 'stale-lease', message: 'private detail' }),
			timeoutMs: 0
		});

		const error: unknown = await client.heartbeat('job-1', 30, 1).catch((e: unknown) => e);
		expect(error).toMatchObject({ name: 'FleetClientError', kind: 'stale-lease', status: 409 });
		// The posture holds: nothing the server wrote reaches the message.
		expect((error as Error).message).not.toContain('private detail');
	});

	it('THROWS stale-lease on a 409 from complete', async () => {
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn: response(409, { statusCode: 409, reason: 'stale-lease', message: 'private detail' }),
			timeoutMs: 0
		});

		await expect(client.complete('job-1', { success: true }, 1)).rejects.toMatchObject({
			kind: 'stale-lease',
			status: 409
		});
	});

	it('still maps every other 4xx to invalid-request', async () => {
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn: response(400, { message: ['leaseGeneration must be an integer'] }),
			timeoutMs: 0
		});

		await expect(client.heartbeat('job-1', 30, 1)).rejects.toMatchObject({ kind: 'invalid-request', status: 400 });
	});
});

describe('FleetJobClient lease cancellation', () => {
	it('composes the worker AbortSignal with the request timeout for a real lease fetch', async () => {
		let observedSignal: AbortSignal | undefined;
		const fetchFn: FetchLike = vi.fn(async (_url, init) => {
			observedSignal = init.signal;
			return new Promise<never>((_resolve, reject) => {
				init.signal?.addEventListener(
					'abort',
					() => reject(Object.assign(new Error('fetch aborted'), { name: 'AbortError' })),
					{ once: true }
				);
			});
		});
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn,
			timeoutMs: 60_000
		});
		const controller = new AbortController();
		const pending = client.lease({}, controller.signal);
		await expect.poll(() => observedSignal).toBeInstanceOf(AbortSignal);

		expect(observedSignal).not.toBe(controller.signal);
		controller.abort(new Error('worker stopping'));
		await expect(pending).rejects.toMatchObject({ kind: 'network' });
		expect(observedSignal?.aborted).toBe(true);
	});
});
