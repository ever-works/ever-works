import { describe, expect, it } from 'vitest';
import type { HeartbeatState, NodeConfig, WorkerLoopState } from 'ever-works-node';
import { CLOUD_API_URL, IDLE_WORKER_STATUS, LOCAL_DESKTOP_API_URL, type EnrollRequest } from '../shared/ipc-contract';
import {
	authenticateRequestValid,
	enrollRequestValid,
	requestedEnrollMode,
	resolveEnrollApiUrl,
	resolveNodeName,
	toIdentityView,
	toStatusView,
	toWorkerStatusView
} from './identity';

const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const TOKEN = 'ZmFrZS1lbnJvbGxtZW50LXRva2VuLWZvci10ZXN0aW5n';
const NODE_ID = '11111111-2222-4333-8444-555555555555';

function config(overrides: Partial<NodeConfig> = {}): NodeConfig {
	return {
		apiUrl: CLOUD_API_URL,
		nodeId: NODE_ID,
		secret: SECRET,
		kind: 'desktop-node',
		capabilities: ['os:win32', 'docker', 'display'],
		name: 'my-laptop',
		heartbeatIntervalMs: 60_000,
		enrolledAt: '2026-07-25T10:00:00.000Z',
		...overrides
	};
}

function state(overrides: Partial<HeartbeatState> = {}): HeartbeatState {
	return {
		state: 'connected',
		lastHeartbeatAt: 1_700_000_000_000,
		consecutiveFailures: 0,
		nextAttemptInMs: 60_000,
		lastError: null,
		lastErrorKind: null,
		node: null,
		...overrides
	};
}

describe('toIdentityView', () => {
	it('NEVER carries the heartbeat secret across the IPC boundary', () => {
		const view = toIdentityView(config());

		// The whole serialized payload is what actually reaches the renderer.
		expect(JSON.stringify(view)).not.toContain(SECRET);
		expect(Object.keys(view)).not.toContain('secret');
		expect((view as unknown as Record<string, unknown>).secret).toBeUndefined();
	});

	it('projects every non-credential field the status window needs', () => {
		expect(toIdentityView(config())).toEqual({
			enrolled: true,
			nodeId: NODE_ID,
			apiUrl: CLOUD_API_URL,
			kind: 'desktop-node',
			capabilities: ['os:win32', 'docker', 'display'],
			limits: { maxConcurrentJobs: 1, maxCpuPercent: null, maxMemoryMb: null },
			name: 'my-laptop',
			heartbeatIntervalMs: 60_000,
			enrolledAt: '2026-07-25T10:00:00.000Z'
		});
	});

	it('carries the operator capability opt-in and resource ceilings', () => {
		const view = toIdentityView(
			config({
				capabilitySelection: ['docker'],
				limits: { maxConcurrentJobs: 4, maxCpuPercent: 70, maxMemoryMb: 8_192 }
			})
		);
		expect(view.capabilitySelection).toEqual(['docker']);
		expect(view.limits).toEqual({ maxConcurrentJobs: 4, maxCpuPercent: 70, maxMemoryMb: 8_192 });
	});

	it('reports a clean not-enrolled view when there is no config', () => {
		expect(toIdentityView(null)).toEqual({
			enrolled: false,
			capabilities: [],
			limits: { maxConcurrentJobs: 1, maxCpuPercent: null, maxMemoryMb: null }
		});
	});

	it('omits the optional label rather than emitting undefined', () => {
		const view = toIdentityView(config({ name: undefined }));
		expect(view.enrolled).toBe(true);
		expect('name' in view).toBe(false);
	});
});

describe('toStatusView', () => {
	it('maps a healthy loop, surfacing the platform-reported node status', () => {
		const view = toStatusView(
			state({
				node: {
					id: NODE_ID,
					name: 'my-laptop',
					kind: 'desktop-node',
					status: 'online',
					platform: 'win32/x64',
					version: '0.1.0',
					capabilities: [],
					lastHeartbeatAt: null,
					createdAt: null,
					persisted: true
				}
			})
		);

		expect(view).toEqual({
			state: 'connected',
			lastHeartbeatAt: 1_700_000_000_000,
			consecutiveFailures: 0,
			nextAttemptInMs: 60_000,
			lastError: null,
			platformStatus: 'online',
			worker: IDLE_WORKER_STATUS
		});
	});

	it('shows a connected node that the operator has paused (A18)', () => {
		// "Connected but paused" is exactly the state pause/resume produces,
		// and the two loops are independent — so it has to be representable.
		const worker = toWorkerStatusView({
			state: 'paused',
			activeJobIds: [],
			consecutiveFailures: 0,
			completed: 7,
			failed: 1,
			lastError: null,
			paused: true,
			throttleReason: null
		});
		const view = toStatusView(state(), worker);

		expect(view.state).toBe('connected');
		expect(view.worker.paused).toBe(true);
		expect(view.worker.completed).toBe(7);
	});

	it('carries the failure detail and backoff while retrying', () => {
		const view = toStatusView(
			state({
				state: 'retrying',
				consecutiveFailures: 3,
				nextAttemptInMs: 300_000,
				lastError: 'Could not reach the API',
				lastErrorKind: 'network'
			})
		);

		expect(view.state).toBe('retrying');
		expect(view.consecutiveFailures).toBe(3);
		expect(view.nextAttemptInMs).toBe(300_000);
		expect(view.lastError).toBe('Could not reach the API');
		expect(view.platformStatus).toBeNull();
	});
});

describe('resolveEnrollApiUrl (main-side re-validation)', () => {
	it('uses the preset URL for the local-desktop and cloud choices, ignoring any renderer-supplied override', () => {
		expect(resolveEnrollApiUrl({ host: 'local-desktop', token: TOKEN })).toBe(LOCAL_DESKTOP_API_URL);
		expect(resolveEnrollApiUrl({ host: 'cloud', token: TOKEN })).toBe(CLOUD_API_URL);
		// A renderer cannot redirect a preset host at a machine of its choosing.
		expect(resolveEnrollApiUrl({ host: 'cloud', apiUrl: 'https://evil.example', token: TOKEN })).toBe(
			CLOUD_API_URL
		);
	});

	it('canonicalizes a self-hosted URL and rejects malformed or non-http(s) ones', () => {
		expect(resolveEnrollApiUrl({ host: 'self-hosted', apiUrl: 'https://works.acme.dev/', token: TOKEN })).toBe(
			'https://works.acme.dev'
		);
		for (const bad of ['', 'not a url', 'ftp://host', 'file:///etc/passwd']) {
			expect(resolveEnrollApiUrl({ host: 'self-hosted', apiUrl: bad, token: TOKEN })).toBeNull();
		}
		expect(resolveEnrollApiUrl({ host: 'self-hosted', token: TOKEN })).toBeNull();
	});

	it('rejects an unknown host choice', () => {
		expect(resolveEnrollApiUrl({ host: 'somewhere-else' as EnrollRequest['host'], token: TOKEN })).toBeNull();
	});
});

describe('toWorkerStatusView', () => {
	it('reports a disabled worker when the node only reports liveness', () => {
		expect(toWorkerStatusView(null)).toEqual(IDLE_WORKER_STATUS);
		expect(toWorkerStatusView(undefined).enabled).toBe(false);
	});

	it('surfaces the throttle reason so the operator sees WHY nothing is running', () => {
		const state: WorkerLoopState = {
			state: 'throttled',
			activeJobIds: [],
			consecutiveFailures: 0,
			completed: 0,
			failed: 0,
			lastError: null,
			paused: false,
			throttleReason: 'host CPU 95% is at or above the 80% ceiling'
		};
		const view = toWorkerStatusView(state);
		expect(view.enabled).toBe(true);
		expect(view.state).toBe('throttled');
		expect(view.throttleReason).toContain('CPU');
	});
});

describe('enrollRequestValid', () => {
	it('accepts a complete token request and rejects a bad token or unusable host', () => {
		expect(enrollRequestValid({ host: 'cloud', token: TOKEN })).toBe(true);
		expect(enrollRequestValid({ host: 'cloud', token: 'short' })).toBe(false);
		expect(enrollRequestValid({ host: 'self-hosted', token: TOKEN })).toBe(false);
		expect(enrollRequestValid({ host: 'cloud' } as EnrollRequest)).toBe(false);
	});

	it('re-validates the sign-in leg main-side — the renderer is not a trust boundary', () => {
		expect(requestedEnrollMode({ host: 'cloud', mode: 'sign-in', email: 'a@b.co', password: 'pw' })).toBe(
			'sign-in'
		);
		expect(enrollRequestValid({ host: 'cloud', mode: 'sign-in', email: 'a@b.co', password: 'pw' })).toBe(true);
		expect(enrollRequestValid({ host: 'cloud', mode: 'sign-in', email: 'a@b.co' })).toBe(false);
		expect(enrollRequestValid({ host: 'cloud', mode: 'sign-in', email: 'nope', password: 'pw' })).toBe(false);
		// A renderer cannot smuggle a token past the sign-in leg's checks.
		expect(enrollRequestValid({ host: 'cloud', mode: 'sign-in', token: TOKEN })).toBe(false);
	});

	it('defaults to the token leg when no mode is declared', () => {
		expect(requestedEnrollMode({ host: 'cloud', token: TOKEN })).toBe('token');
	});
});

describe('authenticateRequestValid', () => {
	it('requires a usable host and plausible credentials', () => {
		expect(authenticateRequestValid({ host: 'cloud', email: 'a@b.co', password: 'pw' })).toBe(true);
		expect(authenticateRequestValid({ host: 'self-hosted', email: 'a@b.co', password: 'pw' })).toBe(false);
		expect(authenticateRequestValid({ host: 'cloud', email: '', password: 'pw' })).toBe(false);
	});
});

describe('resolveNodeName', () => {
	it('uses the operator label, falling back to a stable non-identifying default', () => {
		expect(resolveNodeName({ host: 'cloud', name: '  Studio Mac ' })).toBe('Studio Mac');
		expect(resolveNodeName({ host: 'cloud' })).toBe('Desktop Node');
		expect(resolveNodeName({ host: 'cloud', name: '   ' })).toBe('Desktop Node');
	});
});
