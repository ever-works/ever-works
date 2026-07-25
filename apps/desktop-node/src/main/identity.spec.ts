import { describe, expect, it } from 'vitest';
import type { HeartbeatState, NodeConfig } from 'ever-works-node';
import { CLOUD_API_URL, LOCAL_DESKTOP_API_URL, type EnrollRequest } from '../shared/ipc-contract';
import { enrollRequestValid, resolveEnrollApiUrl, toIdentityView, toStatusView } from './identity';

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
			name: 'my-laptop',
			heartbeatIntervalMs: 60_000,
			enrolledAt: '2026-07-25T10:00:00.000Z'
		});
	});

	it('reports a clean not-enrolled view when there is no config', () => {
		expect(toIdentityView(null)).toEqual({ enrolled: false, capabilities: [] });
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
			platformStatus: 'online'
		});
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

describe('enrollRequestValid', () => {
	it('accepts a complete request and rejects a bad token or unusable host', () => {
		expect(enrollRequestValid({ host: 'cloud', token: TOKEN })).toBe(true);
		expect(enrollRequestValid({ host: 'cloud', token: 'short' })).toBe(false);
		expect(enrollRequestValid({ host: 'self-hosted', token: TOKEN })).toBe(false);
		expect(enrollRequestValid({ host: 'cloud' } as EnrollRequest)).toBe(false);
	});
});
