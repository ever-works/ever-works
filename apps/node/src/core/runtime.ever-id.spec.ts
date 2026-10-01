import { describe, expect, it } from 'vitest';
import type { EverIdDevicePrompt } from './auth-client';
import type { CapabilityEnvironment, CommandRunner } from './capabilities';
import type { FetchLike, FetchRequestInit, FetchResponseLike } from './fleet-client';
import type { Scheduler } from './heartbeat';
import { createLogger, type LogEntry } from './logger';
import { enrollNodeWithEverId } from './runtime';

/**
 * Node enrollment with Ever ID instead of a password (APW-12 FR-39, ACC-12-28
 * node half): sign in with a code, mint a one-time enrollment token with the
 * session, enroll with it — the same protocol steps as the credentials path.
 */

const API_URL = 'https://api.ever.works';
const ISSUER = 'https://id.example.com';
const DEVICE_CODE = 'device-code-Zx9QpL3mVt7Rw2Kc4Hn8';
const ACCESS_TOKEN = 'ever-id-access-token-9f8e7d6c5b4a3210';
const SESSION_TOKEN = 'ever-works-session-token-0a1b2c3d4e5f';
const ENROLLMENT_TOKEN = 'ZmFrZS1lbnJvbGxtZW50LXRva2VuLWZvci10ZXN0aW5n';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const NODE_ID = '11111111-2222-4333-8444-555555555555';

const environment: CapabilityEnvironment = {
	platform: 'linux',
	arch: 'x64',
	nodeVersion: 'v22.11.0',
	hasDisplay: false
};

const runner: CommandRunner = {
	run: async (command) =>
		command === 'git' ? { code: 0, stdout: 'git version 2.4', stderr: '' } : { code: 127, stdout: '', stderr: '' }
};

function jsonResponse(status: number, body: unknown): FetchResponseLike {
	return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function fakePlatform(session: () => FetchResponseLike) {
	const requests: Array<{ url: string; init: FetchRequestInit }> = [];
	const routes: Record<string, () => FetchResponseLike> = {
		[`${API_URL}/api/auth/ever-id/client-config`]: () =>
			jsonResponse(200, {
				issuer: ISSUER,
				localClients: [{ kind: 'node', clientId: 'node-client-id' }],
				scopes: ['openid', 'email', 'ever-works:session']
			}),
		[`${ISSUER}/.well-known/openid-configuration`]: () =>
			jsonResponse(200, {
				device_authorization_endpoint: `${ISSUER}/oauth/v2/device_authorization`,
				token_endpoint: `${ISSUER}/oauth/v2/token`
			}),
		[`${ISSUER}/oauth/v2/device_authorization`]: () =>
			jsonResponse(200, {
				device_code: DEVICE_CODE,
				user_code: 'WDJB-MJHT',
				verification_uri: `${ISSUER}/device`,
				expires_in: 900,
				interval: 5
			}),
		[`${ISSUER}/oauth/v2/token`]: () => jsonResponse(200, { access_token: ACCESS_TOKEN, token_type: 'Bearer' }),
		[`${API_URL}/api/auth/ever-id/session`]: session,
		[`${API_URL}/api/fleet/nodes/enrollment-token`]: () => jsonResponse(201, { token: ENROLLMENT_TOKEN }),
		[`${API_URL}/api/fleet/enroll`]: () =>
			jsonResponse(201, {
				nodeId: NODE_ID,
				secret: SECRET,
				node: {
					id: NODE_ID,
					name: 'My laptop',
					kind: 'desktop-node',
					status: 'online',
					platform: 'linux/x64',
					version: '0.1.0',
					capabilities: ['os:linux'],
					lastHeartbeatAt: null,
					createdAt: null,
					persisted: true
				}
			})
	};
	const fetchFn: FetchLike = async (url, init) => {
		requests.push({ url, init });
		const route = routes[url];
		if (!route) {
			throw new Error(`unexpected request: ${init.method} ${url}`);
		}
		return route();
	};
	return { fetchFn, requests };
}

function io(fetchFn: FetchLike) {
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });
	const scheduler: Scheduler = {
		setTimeout: (callback) => {
			callback();
			return 0;
		},
		clearTimeout: () => undefined
	};
	return { entries, io: { fetchFn, runner, environment, logger, version: '0.1.0', scheduler } };
}

describe('enrollNodeWithEverId', () => {
	it('signs in with a code, mints a one-time token with the session and enrolls with it', async () => {
		const platform = fakePlatform(() =>
			jsonResponse(200, {
				access_token: SESSION_TOKEN,
				user: { id: 'u1', email: 'alice@example.com', username: 'alice' }
			})
		);
		const { io: deps, entries } = io(platform.fetchFn);
		const prompts: EverIdDevicePrompt[] = [];

		const config = await enrollNodeWithEverId({
			...deps,
			apiUrl: API_URL,
			kind: 'desktop-node',
			nodeName: 'My laptop',
			onPrompt: (prompt) => void prompts.push(prompt)
		});

		expect(prompts).toEqual([
			{ verificationUri: `${ISSUER}/device`, userCode: 'WDJB-MJHT', expiresInSeconds: 900 }
		]);
		expect(config).toMatchObject({
			apiUrl: API_URL,
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'desktop-node',
			name: 'My laptop'
		});

		const mint = platform.requests.find((request) => request.url.endsWith('/api/fleet/nodes/enrollment-token'));
		expect(mint?.init.headers.Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
		expect(JSON.parse(mint?.init.body ?? '{}')).toEqual({ name: 'My laptop', kind: 'desktop-node' });
		const enroll = platform.requests.find((request) => request.url.endsWith('/api/fleet/enroll'));
		expect(JSON.parse(enroll?.init.body ?? '{}')).toMatchObject({ token: ENROLLMENT_TOKEN });

		const text = entries.map((entry) => entry.message).join('\n');
		expect(text).toContain(`Signed in to ${API_URL} with Ever ID as alice@example.com`);
		for (const secret of [DEVICE_CODE, ACCESS_TOKEN, SESSION_TOKEN, ENROLLMENT_TOKEN, SECRET]) {
			expect(text).not.toContain(secret);
		}
	});

	it('stops at an unconnected Ever ID (S23) without minting a token', async () => {
		const platform = fakePlatform(() =>
			jsonResponse(403, { status: 'error', code: 'not_connected', message: 'Not connected.' })
		);
		const { io: deps } = io(platform.fetchFn);

		await expect(
			enrollNodeWithEverId({
				...deps,
				apiUrl: API_URL,
				kind: 'node',
				nodeName: 'build-box',
				onPrompt: () => undefined
			})
		).rejects.toMatchObject({
			kind: 'forbidden',
			message: 'Connect Ever ID to your Ever Works account in Settings → Security first.'
		});
		expect(platform.requests.some((request) => request.url.includes('/api/fleet/'))).toBe(false);
	});
});
