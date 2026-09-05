import { describe, expect, it } from 'vitest';
import {
	FleetClient,
	FleetClientError,
	joinUrl,
	normalizeApiUrl,
	type FetchLike,
	type FetchRequestInit
} from './fleet-client';
import { createLogger, REDACTED, type LogEntry } from './logger';
import type { FleetNodeView } from './types';

const TOKEN = 'ZmFrZS1lbnJvbGxtZW50LXRva2VuLWZvci10ZXN0aW5n';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const NODE_ID = '11111111-2222-4333-8444-555555555555';

const nodeView: FleetNodeView = {
	id: NODE_ID,
	name: 'build-box-01',
	kind: 'node',
	status: 'online',
	platform: 'linux/x64',
	version: '0.1.0',
	capabilities: ['os:linux', 'docker'],
	lastHeartbeatAt: '2026-07-25T10:00:00.000Z',
	createdAt: '2026-07-25T09:00:00.000Z',
	persisted: true
};

interface Call {
	url: string;
	init: FetchRequestInit;
}

/** Fake fetch that records calls and replays a scripted response. */
function fakeFetch(respond: (call: Call) => { ok?: boolean; status?: number; body?: unknown; raw?: string } | Error): {
	fetchFn: FetchLike;
	calls: Call[];
} {
	const calls: Call[] = [];
	const fetchFn: FetchLike = async (url, init) => {
		calls.push({ url, init });
		const result = respond({ url, init });
		if (result instanceof Error) {
			throw result;
		}
		const status = result.status ?? 200;
		return {
			ok: result.ok ?? status < 400,
			status,
			text: async () => result.raw ?? JSON.stringify(result.body ?? {})
		};
	};
	return { fetchFn, calls };
}

function loggerCapture() {
	const entries: LogEntry[] = [];
	return { entries, logger: createLogger({ sink: (entry) => entries.push(entry) }) };
}

function client(fetchFn: FetchLike, apiUrl = 'https://api.ever.works') {
	return new FleetClient({ apiUrl, fetchFn, userAgent: 'ever-works-node/0.1.0', timeoutMs: 0 });
}

describe('normalizeApiUrl / joinUrl', () => {
	it('canonicalizes an origin and strips trailing slashes', () => {
		expect(normalizeApiUrl('https://api.ever.works/')).toBe('https://api.ever.works');
		expect(normalizeApiUrl('  http://localhost:3100  ')).toBe('http://localhost:3100');
		expect(normalizeApiUrl('https://host/base/')).toBe('https://host/base');
	});

	it('rejects empty, malformed and non-http(s) URLs as invalid-request', () => {
		for (const bad of ['', '   ', 'not a url', 'ftp://host', 'file:///etc/passwd']) {
			expect(() => normalizeApiUrl(bad)).toThrowError(FleetClientError);
		}
		expect(joinUrl('https://h/', '/api/fleet/enroll')).toBe('https://h/api/fleet/enroll');
	});
});

describe('enroll', () => {
	it('posts the documented body to /api/fleet/enroll and returns the credential', async () => {
		const { fetchFn, calls } = fakeFetch(() => ({
			status: 201,
			body: { nodeId: NODE_ID, secret: SECRET, node: nodeView }
		}));

		const result = await client(fetchFn).enroll({
			token: TOKEN,
			platform: 'linux/x64',
			version: '0.1.0',
			capabilities: ['os:linux', 'docker']
		});

		expect(result).toEqual({ nodeId: NODE_ID, secret: SECRET, node: nodeView });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.ever.works/api/fleet/enroll');
		expect(calls[0].init.method).toBe('POST');
		expect(JSON.parse(calls[0].init.body)).toEqual({
			token: TOKEN,
			platform: 'linux/x64',
			version: '0.1.0',
			capabilities: ['os:linux', 'docker']
		});
	});

	it('sends a real User-Agent — the production API edge 403s default agents', async () => {
		const { fetchFn, calls } = fakeFetch(() => ({
			status: 201,
			body: { nodeId: NODE_ID, secret: SECRET, node: nodeView }
		}));
		await client(fetchFn).enroll({ token: TOKEN });

		expect(calls[0].init.headers['User-Agent']).toBe('ever-works-node/0.1.0');
		expect(calls[0].init.headers['Content-Type']).toBe('application/json');
		// Absent self-description fields are omitted, not sent as undefined.
		expect(JSON.parse(calls[0].init.body)).toEqual({ token: TOKEN });
	});

	it('carries the runner telemetry fields onto the wire', async () => {
		// REGRESSION: `selfDescription` is an explicit whitelist, and it
		// named only platform/version/capabilities. The probes computed
		// `cliVersion` + `diskFreeBytes` on every enroll and beat and the
		// client dropped them, so the columns, the settings table and the
		// runner popover stayed empty forever on a fully-updated fleet.
		const { fetchFn, calls } = fakeFetch(() => ({
			status: 201,
			body: { nodeId: NODE_ID, secret: SECRET, node: nodeView }
		}));

		await client(fetchFn).enroll({
			token: TOKEN,
			platform: 'linux/x64',
			version: '0.1.0',
			capabilities: ['os:linux'],
			cliVersion: 'claude 1.4.2',
			diskFreeBytes: 900_000_000
		});

		expect(JSON.parse(calls[0].init.body)).toEqual({
			token: TOKEN,
			platform: 'linux/x64',
			version: '0.1.0',
			capabilities: ['os:linux'],
			cliVersion: 'claude 1.4.2',
			diskFreeBytes: 900_000_000
		});
	});

	it('surfaces an invalid/expired/used token as a single undifferentiated unauthorized error', async () => {
		const { fetchFn } = fakeFetch(() => ({
			status: 401,
			body: { message: 'Invalid or expired enrollment token' }
		}));

		const error = await client(fetchFn)
			.enroll({ token: TOKEN })
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(FleetClientError);
		expect((error as FleetClientError).kind).toBe('unauthorized');
		expect((error as FleetClientError).status).toBe(401);
		expect((error as FleetClientError).message).toContain('unknown, already used, or expired');
	});

	it('rejects a token that cannot possibly be valid before it leaves the machine', async () => {
		const { fetchFn, calls } = fakeFetch(() => ({ status: 201, body: {} }));
		await expect(client(fetchFn).enroll({ token: 'too-short' })).rejects.toMatchObject({
			kind: 'invalid-request'
		});
		expect(calls).toHaveLength(0);
	});

	it('maps 403 to a proxy/edge hint, 429 to rate-limited and 5xx to server', async () => {
		for (const [status, kind] of [
			[403, 'forbidden'],
			[429, 'rate-limited'],
			[500, 'server'],
			[502, 'server']
		] as const) {
			const { fetchFn } = fakeFetch(() => ({ status }));
			await expect(client(fetchFn).enroll({ token: TOKEN })).rejects.toMatchObject({ kind, status });
		}
	});

	it('classifies transport failures as network and malformed payloads as malformed', async () => {
		const offline = fakeFetch(() => new Error('getaddrinfo ENOTFOUND api.ever.works'));
		await expect(client(offline.fetchFn).enroll({ token: TOKEN })).rejects.toMatchObject({ kind: 'network' });

		const garbage = fakeFetch(() => ({ status: 201, raw: '<html>gateway</html>' }));
		await expect(client(garbage.fetchFn).enroll({ token: TOKEN })).rejects.toMatchObject({ kind: 'malformed' });

		const incomplete = fakeFetch(() => ({ status: 201, body: { nodeId: NODE_ID, node: nodeView } }));
		await expect(client(incomplete.fetchFn).enroll({ token: TOKEN })).rejects.toMatchObject({ kind: 'malformed' });
	});

	it('protects the token and the returned secret so neither can ever be logged', async () => {
		const { entries, logger } = loggerCapture();
		const { fetchFn } = fakeFetch(() => ({
			status: 201,
			body: { nodeId: NODE_ID, secret: SECRET, node: nodeView }
		}));
		const withLogger = new FleetClient({
			apiUrl: 'https://api.ever.works',
			fetchFn,
			logger,
			timeoutMs: 0
		});

		await withLogger.enroll({ token: TOKEN });
		logger.info(`token=${TOKEN} secret=${SECRET}`);

		const text = entries.map((entry) => entry.message).join('\n');
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(SECRET);
		expect(text).toContain(REDACTED);
	});
});

describe('heartbeat', () => {
	it('posts nodeId + secret + refreshed description and returns the node view', async () => {
		const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, node: nodeView } }));

		const result = await client(fetchFn).heartbeat({
			nodeId: NODE_ID,
			secret: SECRET,
			platform: 'linux/x64',
			version: '0.1.0',
			capabilities: ['os:linux', 'git']
		});

		expect(result).toEqual({ ok: true, node: nodeView });
		expect(calls[0].url).toBe('https://api.ever.works/api/fleet/heartbeat');
		expect(JSON.parse(calls[0].init.body)).toMatchObject({
			nodeId: NODE_ID,
			secret: SECRET,
			capabilities: ['os:linux', 'git']
		});
	});

	it('refreshes the runner telemetry, and OMITS what the probes could not read', async () => {
		// Omission is load-bearing on this path: the server treats an
		// absent telemetry field as "leave the stored reading alone", so a
		// beat whose disk probe failed must not blank a good value — and a
		// beat whose probe DID answer must actually send it.
		const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, node: nodeView } }));

		await client(fetchFn).heartbeat({
			nodeId: NODE_ID,
			secret: SECRET,
			platform: 'linux/x64',
			cliVersion: 'codex 0.9.1'
		});

		const body = JSON.parse(calls[0].init.body);
		expect(body.cliVersion).toBe('codex 0.9.1');
		expect(body).not.toHaveProperty('diskFreeBytes');
	});

	it('carries the model identity onto the wire, and omits it when the probe had no answer', async () => {
		// Fleet cost accounting (EW-777): `selfDescription` is an explicit
		// whitelist, so a field it does not name is computed, logged and
		// never sent — the exact way `cliVersion` was once lost.
		const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, node: nodeView } }));

		await client(fetchFn).heartbeat({
			nodeId: NODE_ID,
			secret: SECRET,
			modelIdentity: 'claude-code: ops@example.com (Acme, max)'
		});
		expect(JSON.parse(calls[0].init.body).modelIdentity).toBe('claude-code: ops@example.com (Acme, max)');

		await client(fetchFn).heartbeat({ nodeId: NODE_ID, secret: SECRET });
		expect(JSON.parse(calls[1].init.body)).not.toHaveProperty('modelIdentity');
	});

	it('carries the worker state and reason, and omits both when absent', async () => {
		// Fleet health signals (EW-776), same whitelist trap as above: a
		// worker state the loop computes and the client never sends is a
		// quarantined machine that still reads healthy in Fleet — the
		// precise defect this slice exists to close.
		const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, node: nodeView } }));

		await client(fetchFn).heartbeat({
			nodeId: NODE_ID,
			secret: SECRET,
			workerState: 'quarantined',
			workerStateReason: 'process tree for job 42 could not be proven terminated'
		});
		const body = JSON.parse(calls[0].init.body);
		expect(body.workerState).toBe('quarantined');
		expect(body.workerStateReason).toBe('process tree for job 42 could not be proven terminated');

		await client(fetchFn).heartbeat({ nodeId: NODE_ID, secret: SECRET });
		expect(JSON.parse(calls[1].init.body)).not.toHaveProperty('workerState');
		expect(JSON.parse(calls[1].init.body)).not.toHaveProperty('workerStateReason');
	});

	it('sends a state without a reason when there is nothing to explain', async () => {
		const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, node: nodeView } }));

		await client(fetchFn).heartbeat({ nodeId: NODE_ID, secret: SECRET, workerState: 'idle' });

		const body = JSON.parse(calls[0].init.body);
		expect(body.workerState).toBe('idle');
		expect(body).not.toHaveProperty('workerStateReason');
	});

	it('reports a revoked/disabled node as unauthorized with an actionable message', async () => {
		const { fetchFn } = fakeFetch(() => ({ status: 401 }));
		const error = await client(fetchFn)
			.heartbeat({ nodeId: NODE_ID, secret: SECRET })
			.catch((caught: unknown) => caught);

		expect((error as FleetClientError).kind).toBe('unauthorized');
		expect((error as FleetClientError).message).toContain('revoked, deleted, or the node was disabled');
	});

	it('honours a base URL that carries a path prefix', async () => {
		const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, node: nodeView } }));
		await client(fetchFn, 'https://self-hosted.example/platform/').heartbeat({ nodeId: NODE_ID, secret: SECRET });
		expect(calls[0].url).toBe('https://self-hosted.example/platform/api/fleet/heartbeat');
	});
});
