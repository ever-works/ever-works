import { describe, expect, it } from 'vitest';
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
