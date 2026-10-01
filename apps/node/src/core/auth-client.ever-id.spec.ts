import { describe, expect, it } from 'vitest';
import { EVER_ID_SIGN_IN_MESSAGES, PlatformAuthClient, type EverIdDevicePrompt } from './auth-client';
import { FleetClientError, type FetchLike, type FetchRequestInit, type FetchResponseLike } from './fleet-client';
import type { Scheduler } from './heartbeat';
import { createLogger, type LogEntry, type Logger } from './logger';

/**
 * Sign in with Ever ID using a code (APW-12: S8, S23, FR-39 to FR-42,
 * ACC-12-28 node half, ACC-12-31).
 *
 * The e-mail/password path keeps its own spec (`auth-client.spec.ts`),
 * untouched. Here Ever ID, the API and the clock are faked: the injected
 * scheduler advances a fake clock instead of waiting, so the 5-second polling
 * and the 900-second expiry run instantly. What matters is that the person
 * sees the address and the code and nothing else, that every credential is
 * protected the moment it exists, and that polling honours the provider.
 */

const API_URL = 'https://api.example.com';
const ISSUER = 'https://id.example.com';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const DEVICE_ENDPOINT = `${ISSUER}/oauth/v2/device_authorization`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/v2/token`;
const VERIFICATION_URI = `${ISSUER}/device`;
const CLIENT_CONFIG_URL = `${API_URL}/api/auth/ever-id/client-config`;
const SESSION_URL = `${API_URL}/api/auth/ever-id/session`;
const NODE_CLIENT_ID = 'node-client-id';
const USER_CODE = 'WDJB-MJHT';
const DEVICE_CODE = 'device-code-Zx9QpL3mVt7Rw2Kc4Hn8';
const ACCESS_TOKEN = 'ever-id-access-token-9f8e7d6c5b4a3210';
const SESSION_TOKEN = 'ever-works-session-token-0a1b2c3d4e5f';

/** Fake-clock origin; every step before polling happens at this instant. */
const START = 1_000_000;

/** Far above the 180 polls a 900-second code allows; past it the fake stops answering. */
const MAX_REQUESTS = 1_000;

interface RecordedRequest {
	url: string;
	init: FetchRequestInit;
	/** Fake-clock time at which the request was sent. */
	at: number;
}

type Route = (request: RecordedRequest) => FetchResponseLike;

function jsonResponse(status: number, body?: unknown): FetchResponseLike {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => (body === undefined ? '' : JSON.stringify(body))
	};
}

const pending = () => jsonResponse(400, { error: 'authorization_pending' });
const slowDown = () => jsonResponse(400, { error: 'slow_down' });
const issued = () => jsonResponse(200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 900 });
const unreachable: Route = () => {
	throw new Error('connect ECONNREFUSED');
};

/** Answers the token endpoint with `replies` in order, then keeps repeating the last one. */
function tokenReplies(...replies: Array<FetchResponseLike | 'unreachable'>): Route {
	let index = 0;
	return (request) => {
		const next = replies[Math.min(index, replies.length - 1)];
		index += 1;
		return next === 'unreachable' ? unreachable(request) : next;
	};
}

function deviceGrant(overrides: Record<string, unknown> = {}): Route {
	return () =>
		jsonResponse(200, {
			device_code: DEVICE_CODE,
			user_code: USER_CODE,
			verification_uri: VERIFICATION_URI,
			verification_uri_complete: `${VERIFICATION_URI}?user_code=${USER_CODE}`,
			expires_in: 900,
			interval: 5,
			...overrides
		});
}

interface Routes {
	clientConfig: Route;
	discovery: Route;
	device: Route;
	token: Route;
	session: Route;
}

function fakeWorld(routes: Partial<Routes> = {}, apiUrl = API_URL) {
	let clock = START;
	const sleeps: number[] = [];
	const requests: RecordedRequest[] = [];
	const prompts: EverIdDevicePrompt[] = [];
	const table: Record<string, Route> = {
		[`${apiUrl}/api/auth/ever-id/client-config`]:
			routes.clientConfig ??
			(() =>
				jsonResponse(200, {
					issuer: ISSUER,
					localClients: [
						{ kind: 'cli', clientId: 'cli-client-id' },
						{ kind: 'node', clientId: NODE_CLIENT_ID }
					],
					scopes: ['openid', 'email', 'ever-works:session']
				})),
		[DISCOVERY_URL]:
			routes.discovery ??
			(() =>
				jsonResponse(200, {
					issuer: ISSUER,
					device_authorization_endpoint: DEVICE_ENDPOINT,
					token_endpoint: TOKEN_ENDPOINT
				})),
		[DEVICE_ENDPOINT]: routes.device ?? deviceGrant(),
		[TOKEN_ENDPOINT]: routes.token ?? tokenReplies(pending(), issued()),
		[`${apiUrl}/api/auth/ever-id/session`]:
			routes.session ??
			(() =>
				jsonResponse(200, {
					access_token: SESSION_TOKEN,
					user: { id: 'u1', email: 'alice@example.com', username: 'alice' }
				}))
	};

	const fetchFn: FetchLike = async (url, init) => {
		const request = { url, init, at: clock };
		requests.push(request);
		if (requests.length > MAX_REQUESTS) {
			throw new Error('runaway polling');
		}
		const route = table[url];
		if (!route) {
			throw new Error(`unexpected request: ${init.method} ${url}`);
		}
		return route(request);
	};

	const scheduler: Scheduler = {
		setTimeout: (callback, ms) => {
			sleeps.push(ms);
			clock += ms;
			callback();
			return 0;
		},
		clearTimeout: () => undefined
	};

	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });

	const client = new PlatformAuthClient({
		apiUrl,
		fetchFn,
		logger,
		timeoutMs: 0,
		scheduler,
		now: () => clock
	});

	return {
		fetchFn,
		scheduler,
		logger,
		entries,
		requests,
		sleeps,
		prompts,
		now: () => clock,
		signIn: () => client.signInWithEverId({ onPrompt: (prompt) => void prompts.push(prompt) }),
		requestsTo: (url: string) => requests.filter((request) => request.url === url)
	};
}

function form(request: RecordedRequest): Record<string, string> {
	return Object.fromEntries(new URLSearchParams(request.init.body));
}

describe('PlatformAuthClient.signInWithEverId', () => {
	it('shows only the verification address and the code, then returns the session from the body', async () => {
		const world = fakeWorld();

		const result = await world.signIn();

		expect(world.prompts).toEqual([
			{ verificationUri: VERIFICATION_URI, userCode: USER_CODE, expiresInSeconds: 900 }
		]);
		expect(result).toEqual({ sessionToken: SESSION_TOKEN, userId: 'u1', email: 'alice@example.com' });
	});

	it('reads the client config, discovers Ever ID and asks for exactly client_id and scope as the node client', async () => {
		const world = fakeWorld();

		await world.signIn();

		const [config, discovery, device] = world.requests;
		expect(config.url).toBe(CLIENT_CONFIG_URL);
		expect(config.init.method).toBe('GET');
		expect(config.init.body).toBe('');
		expect(discovery.url).toBe(DISCOVERY_URL);
		expect(discovery.init.method).toBe('GET');
		expect(device.url).toBe(DEVICE_ENDPOINT);
		expect(device.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
		// No `audience` and no `resource` (plan §7).
		expect(form(device)).toEqual({ client_id: NODE_CLIENT_ID, scope: 'openid email ever-works:session' });
		for (const request of world.requests) {
			expect(request.init.headers['User-Agent']).toBe('ever-works-node');
		}
	});

	it('polls with the device code grant and exchanges the access token as a bearer', async () => {
		const world = fakeWorld();

		await world.signIn();

		for (const poll of world.requestsTo(TOKEN_ENDPOINT)) {
			expect(form(poll)).toEqual({
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: DEVICE_CODE,
				client_id: NODE_CLIENT_ID
			});
		}
		const [exchange] = world.requestsTo(SESSION_URL);
		expect(exchange.init.method).toBe('POST');
		expect(exchange.init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
		const others = world.requests.filter((request) => request !== exchange);
		expect(JSON.stringify(others)).not.toContain(ACCESS_TOKEN);
	});

	it('protects the access token before any other use of it, and the device code before it is shown or sent', async () => {
		const world = fakeWorld();
		const events: string[] = [];
		const base = createLogger({ sink: () => undefined });
		const logger: Logger = {
			...base,
			protect: (value) => {
				events.push(`protect ${value}`);
				base.protect(value);
			}
		};
		const client = new PlatformAuthClient({
			apiUrl: API_URL,
			logger,
			timeoutMs: 0,
			scheduler: world.scheduler,
			now: world.now,
			fetchFn: (url, init) => {
				events.push(`send ${init.method} ${url} ${JSON.stringify(init.headers)} ${init.body}`);
				return world.fetchFn(url, init);
			}
		});

		await client.signInWithEverId({ onPrompt: () => void events.push('prompt') });

		const first = (text: string) => events.findIndex((event) => event.includes(text));
		// The token arrives in a response; the first thing that happens to it is `protect`.
		expect(events[first(ACCESS_TOKEN)]).toBe(`protect ${ACCESS_TOKEN}`);
		expect(first(`protect ${DEVICE_CODE}`)).toBeLessThan(first('prompt'));
		expect(first('prompt')).toBeLessThan(first(`send POST ${TOKEN_ENDPOINT}`));
		expect(events[first(SESSION_TOKEN)]).toBe(`protect ${SESSION_TOKEN}`);
	});

	it('keeps the session protected and forgets the spent device code and access token', async () => {
		const world = fakeWorld();

		await world.signIn();

		expect(world.logger.redact(`session ${SESSION_TOKEN}`)).not.toContain(SESSION_TOKEN);
		expect(world.logger.redact(`code ${DEVICE_CODE}`)).toContain(DEVICE_CODE);
		expect(world.logger.redact(`token ${ACCESS_TOKEN}`)).toContain(ACCESS_TOKEN);
	});

	it('keeps the access token out of an error raised while exchanging it', async () => {
		const world = fakeWorld({
			session: () => {
				throw new Error(`socket hang up while sending Bearer ${ACCESS_TOKEN}`);
			}
		});

		const failure = await world.signIn().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(FleetClientError);
		expect((failure as FleetClientError).kind).toBe('network');
		expect((failure as FleetClientError).message).not.toContain(ACCESS_TOKEN);
	});

	it('never logs, prompts or addresses a token or the device code', async () => {
		const world = fakeWorld();

		await world.signIn();

		const shown = JSON.stringify([world.entries, world.prompts]);
		for (const secret of [DEVICE_CODE, ACCESS_TOKEN, SESSION_TOKEN]) {
			expect(shown).not.toContain(secret);
		}
		for (const request of world.requests) {
			for (const value of [DEVICE_CODE, ACCESS_TOKEN, SESSION_TOKEN, USER_CODE]) {
				expect(request.url).not.toContain(value);
			}
		}
	});

	describe('polling (FR-41)', () => {
		it.each([1, 0, -3, 4.9, undefined, 'fast'])(
			'never polls faster than every 5 seconds (interval %s)',
			async (interval) => {
				const world = fakeWorld({
					device: deviceGrant({ interval }),
					token: tokenReplies(pending(), pending(), issued())
				});

				await world.signIn();

				expect(world.sleeps).toEqual([5000, 5000, 5000]);
			}
		);

		it('honours a longer interval from Ever ID', async () => {
			const world = fakeWorld({ device: deviceGrant({ interval: 12 }) });

			await world.signIn();

			expect(world.sleeps).toEqual([12_000, 12_000]);
		});

		it('adds 5 seconds for this and every later poll on each slow_down', async () => {
			const world = fakeWorld({ token: tokenReplies(slowDown(), slowDown(), pending(), issued()) });

			await world.signIn();

			expect(world.sleeps).toEqual([5000, 10_000, 15_000, 15_000]);
		});

		it('returns the session within 5 seconds of the approval at Ever ID (S8)', async () => {
			const approvedAt = START + 37_000;
			const world = fakeWorld({ token: (request) => (request.at >= approvedAt ? issued() : pending()) });

			await world.signIn();

			const [exchange] = world.requestsTo(SESSION_URL);
			expect(exchange.at - approvedAt).toBeGreaterThanOrEqual(0);
			expect(exchange.at - approvedAt).toBeLessThanOrEqual(5000);
		});

		it('backs off when a poll cannot reach Ever ID, and gives up after three in a row', async () => {
			const recovering = fakeWorld({ token: tokenReplies('unreachable', pending(), issued()) });
			await expect(recovering.signIn()).resolves.toMatchObject({ sessionToken: SESSION_TOKEN });
			expect(recovering.sleeps).toEqual([5000, 10_000, 10_000]);

			const down = fakeWorld({ token: tokenReplies('unreachable', jsonResponse(503), 'unreachable') });
			await expect(down.signIn()).rejects.toMatchObject({
				kind: 'network',
				message: EVER_ID_SIGN_IN_MESSAGES.providerUnavailable
			});
			expect(down.sleeps).toEqual([5000, 10_000, 20_000]);
		});
	});

	describe('expiry (FR-41)', () => {
		it('stops when Ever ID says the code expired', async () => {
			const world = fakeWorld({ token: tokenReplies(pending(), jsonResponse(400, { error: 'expired_token' })) });

			await expect(world.signIn()).rejects.toMatchObject({ message: 'The code expired. Start again.' });
			expect(world.requestsTo(SESSION_URL)).toHaveLength(0);
		});

		it('stops when the code’s lifetime runs out', async () => {
			const world = fakeWorld({ device: deviceGrant({ expires_in: 20 }), token: pending });

			await expect(world.signIn()).rejects.toMatchObject({ message: EVER_ID_SIGN_IN_MESSAGES.expired });
			expect(world.requestsTo(TOKEN_ENDPOINT).map((poll) => poll.at - START)).toEqual([5000, 10_000, 15_000]);
		});

		it('never waits more than 900 seconds, whatever Ever ID answers', async () => {
			const world = fakeWorld({ device: deviceGrant({ expires_in: 3600 }), token: pending });

			await expect(world.signIn()).rejects.toMatchObject({ message: EVER_ID_SIGN_IN_MESSAGES.expired });
			expect(world.prompts[0].expiresInSeconds).toBe(900);
			expect(world.now() - START).toBe(900_000);
		});
	});

	describe('failures', () => {
		it('reports a person declining at Ever ID', async () => {
			const world = fakeWorld({ token: tokenReplies(pending(), jsonResponse(400, { error: 'access_denied' })) });

			await expect(world.signIn()).rejects.toMatchObject({
				kind: 'forbidden',
				message: 'Sign-in was declined at Ever ID.'
			});
		});

		it('asks an unconnected Ever ID to be connected first (S23)', async () => {
			const world = fakeWorld({
				session: () => jsonResponse(403, { status: 'error', code: 'not_connected', message: 'Not connected.' })
			});

			await expect(world.signIn()).rejects.toMatchObject({
				kind: 'forbidden',
				status: 403,
				message: 'Connect Ever ID to your Ever Works account in Settings → Security first.'
			});
		});

		it('says Ever ID is not available when the server has it turned off, without contacting Ever ID', async () => {
			const world = fakeWorld({
				clientConfig: () =>
					jsonResponse(404, { status: 'error', code: 'ever_id_disabled', message: 'Not found.' })
			});

			await expect(world.signIn()).rejects.toMatchObject({
				status: 404,
				message: EVER_ID_SIGN_IN_MESSAGES.unavailable
			});
			expect(world.requests.map((request) => request.url)).toEqual([CLIENT_CONFIG_URL]);
			expect(world.prompts).toHaveLength(0);
		});

		it('says Ever ID is not available when there is no client for nodes', async () => {
			const world = fakeWorld({
				clientConfig: () =>
					jsonResponse(200, { issuer: ISSUER, localClients: [{ kind: 'cli', clientId: 'c' }], scopes: [] })
			});

			await expect(world.signIn()).rejects.toMatchObject({ message: EVER_ID_SIGN_IN_MESSAGES.unavailable });
		});

		it.each<[string, Partial<Routes>]>([
			['discovery cannot be reached', { discovery: unreachable }],
			['device authorization fails', { device: () => jsonResponse(503) }],
			[
				'the API reports Ever ID unavailable',
				{ session: () => jsonResponse(503, { code: 'provider_unavailable' }) }
			]
		])('says Ever ID is not responding when %s (S16)', async (_case, routes) => {
			const world = fakeWorld(routes);

			await expect(world.signIn()).rejects.toMatchObject({
				message: "Ever ID isn't responding. Try again in a minute, or sign in another way."
			});
		});

		it.each<[string, FetchResponseLike, Record<string, unknown>]>([
			[
				'a refused token',
				jsonResponse(401, { code: 'transaction_invalid' }),
				{ kind: 'unauthorized', message: 'That sign-in expired or was already used. Start again.' }
			],
			[
				'a suspended account',
				jsonResponse(403, { code: 'account_disabled' }),
				{ kind: 'forbidden', message: 'Account is suspended.' }
			],
			[
				'the camelCase code spelling',
				jsonResponse(403, { code: 'notConnected' }),
				{ message: EVER_ID_SIGN_IN_MESSAGES.notConnected }
			],
			['a rate limit', jsonResponse(429), { kind: 'rate-limited' }],
			[
				'an unexpected status, never echoing the body',
				jsonResponse(500, { message: 'internal detail' }),
				{ kind: 'server', message: 'API error (HTTP 500)' }
			],
			['an answer without a session', jsonResponse(200, { user: { id: 'u1' } }), { kind: 'malformed' }]
		])('maps %s from the exchange', async (_case, answer, expected) => {
			const world = fakeWorld({ session: () => answer });

			await expect(world.signIn()).rejects.toMatchObject(expected);
		});

		it('reports a provider refusal by its error code, without control characters', async () => {
			const world = fakeWorld({ device: () => jsonResponse(400, { error: 'invalid_client\u001b[2J\r\n' }) });

			await expect(world.signIn()).rejects.toMatchObject({
				kind: 'invalid-request',
				message: 'Ever ID refused the sign-in request (invalid_client [2J).'
			});
		});

		it('refuses to send the Ever ID token over plain http to another machine, before any request', async () => {
			const world = fakeWorld({}, 'http://api.example.com');

			await expect(world.signIn()).rejects.toMatchObject({
				kind: 'invalid-request',
				message: EVER_ID_SIGN_IN_MESSAGES.insecureApiUrl('api.example.com')
			});
			expect(world.requests).toHaveLength(0);
		});

		it('accepts plain http to this machine, as local development needs', async () => {
			const world = fakeWorld({}, 'http://127.0.0.1:3100');

			await expect(world.signIn()).resolves.toMatchObject({ sessionToken: SESSION_TOKEN });
		});

		it('refuses an Ever ID reached over plain http', async () => {
			const world = fakeWorld({
				device: deviceGrant({ verification_uri: 'http://id.example.com/device' })
			});

			await expect(world.signIn()).rejects.toMatchObject({
				message: EVER_ID_SIGN_IN_MESSAGES.insecureProvider('id.example.com')
			});
			expect(world.prompts).toHaveLength(0);
		});
	});
});
