import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import { FleetJobClient } from './job-client';
import { FleetClientError, type FetchLike } from './fleet-client';
import { createLogger, REDACTED, type LogEntry } from './logger';

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

describe('FleetJobClient MCP run credentials (self-build slice Z)', () => {
	const TOKEN = 'ew_run_0123456789abcdef0123456789abcdef';

	/** Records the request so the credential body and path can be asserted. */
	function recording(status: number, body: unknown) {
		const calls: Array<{ url: string; body: unknown }> = [];
		const fetchFn: FetchLike = async (url, init) => {
			calls.push({ url, body: JSON.parse(init.body) });
			return { ok: status < 400, status, text: async () => JSON.stringify(body) };
		};
		return { calls, fetchFn };
	}

	it('mints with the node credential and returns the token to the caller', async () => {
		const { calls, fetchFn } = recording(200, {
			token: TOKEN,
			expiresAt: '2026-09-05T12:00:00.000Z',
			serverUrl: 'https://mcp.ever.works/mcp'
		});
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn,
			timeoutMs: 0
		});

		const credential = await client.mintMcpCredential('job-1');

		expect(credential.token).toBe(TOKEN);
		expect(credential.serverUrl).toBe('https://mcp.ever.works/mcp');
		expect(calls[0]?.url).toBe('https://api.ever.works/api/fleet/jobs/job-1/mcp-credential');
		// The node secret is the credential, exactly as on lease/complete.
		expect(calls[0]?.body).toEqual({ nodeId: NODE_ID, secret: SECRET });
	});

	it('protects the minted token in the logger before returning it', async () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({ sink: (entry) => entries.push(entry) });
		const { fetchFn } = recording(200, {
			token: TOKEN,
			expiresAt: '2026-09-05T12:00:00.000Z',
			serverUrl: 'https://mcp.ever.works/mcp'
		});
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn,
			logger,
			timeoutMs: 0
		});

		await client.mintMcpCredential('job-1');
		// From this instant the token cannot appear in ANY node log line,
		// including one written by code that never knew it was a secret.
		expect(logger.redact(`upstream said ${TOKEN}`)).toBe(`upstream said ${REDACTED}`);
	});

	it('refuses a response with no token rather than returning a hollow credential', async () => {
		const { fetchFn } = recording(200, { expiresAt: 'x', serverUrl: 'https://mcp.ever.works/mcp' });
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn,
			timeoutMs: 0
		});

		await expect(client.mintMcpCredential('job-1')).rejects.toBeInstanceOf(FleetClientError);
	});

	it('surfaces a refused mint as an error, never echoing the server body', async () => {
		const { fetchFn } = recording(401, { message: 'private detail' });
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn,
			timeoutMs: 0
		});

		await expect(client.mintMcpCredential('job-1')).rejects.toThrow();
		await expect(client.mintMcpCredential('job-1')).rejects.not.toThrow(/private detail/);
	});

	it('revokes through the job-scoped route and reports how many were dropped', async () => {
		const { calls, fetchFn } = recording(200, { ok: true, revoked: 2 });
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn,
			timeoutMs: 0
		});

		await expect(client.revokeMcpCredential('job-1')).resolves.toBe(2);
		expect(calls[0]?.url).toBe('https://api.ever.works/api/fleet/jobs/job-1/mcp-credential/revoke');
		expect(calls[0]?.body).toEqual({ nodeId: NODE_ID, secret: SECRET });
	});

	it('reads a revoke response with no count as zero rather than throwing', async () => {
		const { fetchFn } = recording(200, { ok: true });
		const client = new FleetJobClient({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			fetchFn,
			timeoutMs: 0
		});
		await expect(client.revokeMcpCredential('job-1')).resolves.toBe(0);
	});
});
