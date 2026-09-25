import { existsSync, readFileSync } from 'node:fs';

import { compactVerify, createLocalJWKSet } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginContext } from '@ever-works/plugin';

import { OidcDiscoveryReader } from '../discovery.js';
import { OIDC_BACKCHANNEL_LOGOUT_EVENT, OidcIdentityPlugin } from '../oidc-identity.plugin.js';
import { FAKE_BACKCHANNEL_LOGOUT_EVENT, FakeOidcProvider, s256 } from '../testing/fake-oidc-provider.js';

/**
 * APW-12 T8 — the fake provider of plan §10.4, and the package surface that ships
 * it.
 *
 * Plan §10.4 asks for one fake that "starts a local HTTP server on a free port with
 * discovery, JWKS (ES256 via `node:crypto`), authorize (auto-approve a configured
 * user), token (PKCE checked), device authorization, end-session, and helpers to
 * rotate keys, mint access tokens and post a signed back-channel logout token". The
 * first four groups below are those clauses, each driven through a **real HTTP
 * round trip** — the plugin under test uses its default `fetch`, so nothing here
 * stubs the transport, and every key is a real P-256 key pair signed by
 * `node:crypto`.
 *
 * The last two groups are the shipped surface, which has nowhere else to live: the
 * `./testing` subpath must not reach the main entry, and `healthCheck` is the
 * seventh-and-a-half method T8 owes. T8's task text names exactly three spec files,
 * so they are here rather than in a fourth.
 *
 * ## Why the clock is injected even here
 *
 * The fake takes `now` (epoch ms) and every minted claim is stamped from it, which
 * is what lets the key-rotation case jump the plugin's key cache past FR-13's 600
 * seconds instead of sleeping through it. The numbers in the cases are literals.
 */

const BASE_TIME_MS = Date.parse('2026-09-17T09:00:00.000Z');
const REDIRECT_URI = 'https://ever.works/api/auth/ever-id/callback';
const SECRET = 'fake-client-secret';
const ACCESS_TOKEN_LIFETIME_SECONDS = 300;
const JWKS_CACHE_SECONDS = 600;

/** One clock for the provider and the relying party, in epoch milliseconds. */
let clockMs = BASE_TIME_MS;

interface CapturedLogger {
	readonly lines: string[];
	readonly log: (message: string, ...rest: unknown[]) => void;
	readonly warn: (message: string, ...rest: unknown[]) => void;
	readonly error: (message: string, ...rest: unknown[]) => void;
	readonly debug: (message: string, ...rest: unknown[]) => void;
}

const captureLogger = (): CapturedLogger => {
	const lines: string[] = [];
	const record =
		(level: string) =>
		(message: string, ...rest: unknown[]) => {
			lines.push(`${level} ${message} ${rest.map((value) => JSON.stringify(value) ?? '').join(' ')}`);
		};
	return { lines, log: record('log'), warn: record('warn'), error: record('error'), debug: record('debug') };
};

const contextFor = (values: Record<string, unknown>, logger = captureLogger()): PluginContext =>
	({
		pluginId: 'oidc-identity',
		logger,
		cache: {},
		http: {},
		env: {},
		envVars: {},
		services: {},
		getSettings: vi.fn().mockResolvedValue(values)
	}) as unknown as PluginContext;

/** The settings an installation points at the fake with (FR-2). */
const settingsFor = (provider: FakeOidcProvider, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	issuerUrl: provider.issuer,
	clientId: provider.clientId,
	clientSecret: provider.clientSecret ?? SECRET,
	...overrides
});

/** A plugin wired to the fake over **real** HTTP: no `fetchImpl`, so `fetch` is the runtime's. */
const pluginFor = async (
	provider: FakeOidcProvider,
	overrides: Record<string, unknown> = {}
): Promise<{ plugin: OidcIdentityPlugin; logger: CapturedLogger }> => {
	const logger = captureLogger();
	const plugin = new OidcIdentityPlugin({ now: () => clockMs });
	await plugin.onLoad(contextFor(settingsFor(provider, overrides), logger));
	return { plugin, logger };
};

/**
 * Run `work` against a started provider, and stop it whatever happens.
 *
 * The injected clock is shared with the relying party: the provider stamps every
 * minted claim from it and enforces FR-41's poll interval on it, so a case moves
 * one variable and both sides see the same time. Letting the fake read the wall
 * clock instead would make its tokens two days old — or two days in the future —
 * the moment this machine's date drifts from `BASE_TIME_MS`.
 */
const withProvider = async <T>(
	options: Parameters<typeof FakeOidcProvider.start>[0],
	work: (provider: FakeOidcProvider) => Promise<T>
): Promise<T> => {
	const provider = await FakeOidcProvider.start({ now: () => clockMs, ...options });
	try {
		return await work(provider);
	} finally {
		await provider.stop();
	}
};

/** Follow an authorization URL the way a browser would, without leaving the process. */
const followAuthorize = async (url: string): Promise<Record<string, string>> => {
	const response = await fetch(url, { redirect: 'manual' });
	const location = response.headers.get('location');
	if (location === null) throw new Error(`no redirect from ${url}: ${response.status}`);
	return Object.fromEntries(new URL(location).searchParams.entries());
};

afterEach(() => {
	clockMs = BASE_TIME_MS;
	vi.useRealTimers();
});

describe('discovery — the document a relying party reads (FR-3, FR-14)', () => {
	it('publishes a document OidcDiscoveryReader accepts, with every endpoint FR-3 checks', async () => {
		await withProvider({}, async (provider) => {
			const reader = new OidcDiscoveryReader({ issuerUrl: provider.issuer, now: () => clockMs });
			const read = await reader.read();

			expect(read.ok).toBe(true);
			if (!read.ok) return;
			expect(read.issuerMatches).toBe(true);
			expect(read.document).toMatchObject({
				issuer: provider.issuer,
				authorization_endpoint: `${provider.issuer}/authorize`,
				token_endpoint: `${provider.issuer}/token`,
				jwks_uri: `${provider.issuer}/jwks`,
				end_session_endpoint: `${provider.issuer}/end_session`,
				device_authorization_endpoint: `${provider.issuer}/device_authorization`,
				code_challenge_methods_supported: ['S256'],
				id_token_signing_alg_values_supported: ['ES256'],
				backchannel_logout_supported: true
			});
		});
	});

	it('answers every FR-3 check row through the plugin’s own Test connection', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);

			const checks = await plugin.testConnection();

			expect(checks.map((check) => [check.id, check.ok])).toEqual([
				['discovery', true],
				['issuerMatch', true],
				['endpoints', true],
				['pkceS256', true],
				['signingAlg', true],
				['backchannelLogout', true],
				['deviceAuthorization', true]
			]);
		});
	});

	it('lets a case leave a field out, which is how FR-36’s `null` and FR-3’s rows are driven', async () => {
		await withProvider({ omit: ['end_session_endpoint', 'device_authorization_endpoint'] }, async (provider) => {
			const document = provider.discoveryDocument();

			expect(document.end_session_endpoint).toBeUndefined();
			expect(document.device_authorization_endpoint).toBeUndefined();
			expect(document.jwks_uri).toBe(`${provider.issuer}/jwks`);
		});
	});

	it('publishes real P-256 keys with a `kid`, an `alg` and a `use`', async () => {
		await withProvider({}, async (provider) => {
			const response = await fetch(provider.jwksUri);
			const body = (await response.json()) as { keys: Array<Record<string, unknown>> };

			expect(body.keys).toHaveLength(1);
			expect(body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
			expect(String(body.keys[0].kid)).toBe(provider.currentKeyId);
		});
	});
});

describe('the authorization code flow — S256, the exact redirect and a single use', () => {
	it('completes a sign-in through the plugin: request, redirect, PKCE exchange, ID token', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);

			const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
			const authorizeUrl = new URL(request.url);
			expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
			expect(authorizeUrl.searchParams.get('code_challenge')).toBe(s256(request.codeVerifier));
			expect(authorizeUrl.searchParams.get('scope')).toBe('openid email profile');

			const response = await followAuthorize(request.url);
			expect(response.state).toBe(request.state);
			// RFC 9207: the fake names itself in the authorization response, which is
			// the `iss` FR-12 compares before any code is spent.
			expect(response.iss).toBe(provider.issuer);
			expect(response.code).toBeTruthy();

			const claims = await plugin.exchangeAuthorizationCode({
				code: response.code,
				redirectUri: REDIRECT_URI,
				codeVerifier: request.codeVerifier,
				expectedNonce: request.nonce,
				receivedIssuer: response.iss
			});

			expect(claims).toMatchObject({
				issuer: provider.issuer,
				subject: 'ever-id-subject-1',
				email: 'person@example.com',
				emailVerified: true,
				sid: 'ever-id-session-1'
			});
		});
	});

	it('refuses a token request whose verifier does not hash to the challenge, with invalid_grant', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);
			const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
			const response = await followAuthorize(request.url);

			const token = await fetch(provider.tokenEndpoint, {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					authorization: basic(provider.clientId, provider.clientSecret ?? SECRET)
				},
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code: response.code,
					redirect_uri: REDIRECT_URI,
					code_verifier: `${request.codeVerifier}-wrong`
				}).toString()
			});

			expect(token.status).toBe(400);
			await expect(token.json()).resolves.toMatchObject({ error: 'invalid_grant' });
		});
	});

	it('spends an authorization code once: the second exchange is invalid_grant', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);
			const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
			const response = await followAuthorize(request.url);
			const body = new URLSearchParams({
				grant_type: 'authorization_code',
				code: response.code,
				redirect_uri: REDIRECT_URI,
				code_verifier: request.codeVerifier
			}).toString();
			const headers = {
				'content-type': 'application/x-www-form-urlencoded',
				authorization: basic(provider.clientId, provider.clientSecret ?? SECRET)
			};

			const first = await fetch(provider.tokenEndpoint, { method: 'POST', headers, body });
			expect(first.status).toBe(200);

			const second = await fetch(provider.tokenEndpoint, { method: 'POST', headers, body });
			expect(second.status).toBe(400);
			await expect(second.json()).resolves.toMatchObject({ error: 'invalid_grant' });
		});
	});

	it('requires client authentication at the token endpoint, the way client_secret_basic does', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);
			const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
			const response = await followAuthorize(request.url);

			const token = await fetch(provider.tokenEndpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code: response.code,
					redirect_uri: REDIRECT_URI,
					code_verifier: request.codeVerifier
				}).toString()
			});

			expect(token.status).toBe(401);
			await expect(token.json()).resolves.toMatchObject({ error: 'invalid_client' });
		});
	});

	it('refuses an authorization request that does not ask for S256', async () => {
		await withProvider({}, async (provider) => {
			const response = await fetch(
				`${provider.authorizationEndpoint}?response_type=code&client_id=${provider.clientId}` +
					`&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=abc&code_challenge_method=plain`,
				{ redirect: 'manual' }
			);

			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
		});
	});
});

describe('device authorization — RFC 8628 with FR-41’s polling rules', () => {
	const startDeviceGrant = async (provider: FakeOidcProvider): Promise<Record<string, unknown>> => {
		const response = await fetch(provider.deviceAuthorizationEndpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				authorization: basic(provider.clientId, provider.clientSecret ?? SECRET)
			},
			body: new URLSearchParams({ client_id: provider.clientId, scope: 'openid email profile' }).toString()
		});
		expect(response.status).toBe(200);
		return (await response.json()) as Record<string, unknown>;
	};

	const poll = async (
		provider: FakeOidcProvider,
		deviceCode: string
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const response = await fetch(provider.tokenEndpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				authorization: basic(provider.clientId, provider.clientSecret ?? SECRET)
			},
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: deviceCode,
				client_id: provider.clientId
			}).toString()
		});
		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	};

	it('hands out a code, an interval of 5 seconds and a 900-second expiry (FR-41)', async () => {
		await withProvider({}, async (provider) => {
			const grant = await startDeviceGrant(provider);

			expect(grant).toMatchObject({ interval: 5, expires_in: 900 });
			expect(String(grant.device_code)).toMatch(/^device-/u);
			expect(String(grant.user_code)).toMatch(/^[A-Z]{4}-[A-Z]{4}$/u);
			expect(grant.verification_uri).toBe(`${provider.issuer}/device`);
		});
	});

	it('answers authorization_pending until the person approves, then the tokens', async () => {
		await withProvider({}, async (provider) => {
			const grant = await startDeviceGrant(provider);
			const deviceCode = String(grant.device_code);

			const pending = await poll(provider, deviceCode);
			expect(pending.status).toBe(400);
			expect(pending.body.error).toBe('authorization_pending');

			// FR-41: the client waits the interval the provider gave it.
			clockMs += 5_000;
			expect(provider.approveDeviceAuthorization()).toBe(1);

			clockMs += 5_000;
			const granted = await poll(provider, deviceCode);
			expect(granted.status).toBe(200);
			expect(granted.body).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TOKEN_LIFETIME_SECONDS });
			expect(typeof granted.body.access_token).toBe('string');
			expect(typeof granted.body.id_token).toBe('string');
		});
	});

	it('answers slow_down when the client polls faster than the interval (FR-41)', async () => {
		await withProvider({}, async (provider) => {
			const grant = await startDeviceGrant(provider);
			const deviceCode = String(grant.device_code);

			await poll(provider, deviceCode);
			const tooFast = await poll(provider, deviceCode);

			expect(tooFast.status).toBe(400);
			expect(tooFast.body.error).toBe('slow_down');
		});
	});

	it('refuses an unknown device code', async () => {
		await withProvider({}, async (provider) => {
			await startDeviceGrant(provider);

			const unknown = await poll(provider, 'device-not-a-real-code');

			expect(unknown.status).toBe(400);
			expect(unknown.body.error).toBe('invalid_grant');
		});
	});
});

describe('end-session — FR-36’s address, and the `null` when there is none', () => {
	it('builds the address with the client id, the exact redirect and the state, and the fake honours it', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);
			const state = 'sealed-sign-out-state';

			const url = await plugin.buildEndSessionUrl({ postLogoutRedirectUri: REDIRECT_URI, state });

			expect(url).not.toBeNull();
			const parsed = new URL(url as string);
			expect(parsed.origin + parsed.pathname).toBe(`${provider.issuer}/end_session`);
			expect(parsed.searchParams.get('client_id')).toBe(provider.clientId);
			expect(parsed.searchParams.get('post_logout_redirect_uri')).toBe(REDIRECT_URI);
			expect(parsed.searchParams.get('state')).toBe(state);
			// FR-31: no Ever ID token is stored, so there is no `id_token_hint` to send.
			expect(parsed.searchParams.get('id_token_hint')).toBeNull();

			const back = await fetch(url as string, { redirect: 'manual' });
			expect(back.status).toBe(302);
			const location = new URL(back.headers.get('location') as string);
			expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
			expect(location.searchParams.get('state')).toBe(state);
		});
	});

	it('answers null when the provider publishes no end-session endpoint', async () => {
		await withProvider({ omit: ['end_session_endpoint'] }, async (provider) => {
			const { plugin } = await pluginFor(provider);

			await expect(
				plugin.buildEndSessionUrl({ postLogoutRedirectUri: REDIRECT_URI, state: 'any-state' })
			).resolves.toBeNull();
		});
	});
});

describe('the minting and rotation helpers', () => {
	it('mints an access token the verifier accepts, and a logout token the verifier accepts', async () => {
		await withProvider({ localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }] }, async (provider) => {
			const { plugin } = await pluginFor(provider);

			const accessToken = await provider.mintAccessToken({
				scopes: ['ever-works:session'],
				authorizedParty: 'ever-works-cli'
			});
			await expect(
				plugin.verifyAccessToken(accessToken, {
					requiredScopes: ['ever-works:session'],
					maxLifetimeSeconds: 3_600,
					maxAgeSeconds: 300,
					allowedAuthorizedParties: ['ever-works-cli']
				})
			).resolves.toMatchObject({ issuer: provider.issuer, authorizedParty: 'ever-works-cli' });

			const logoutToken = await provider.mintLogoutToken();
			await expect(plugin.verifyLogoutToken(logoutToken)).resolves.toMatchObject({
				issuer: provider.issuer,
				sid: 'ever-id-session-1'
			});
		});
	});

	it('signs a notice that another party can verify from the published key set alone', async () => {
		await withProvider({}, async (provider) => {
			const token = await provider.mintLogoutToken({ subject: 'ever-id-subject-1' });
			const jwks = (await (await fetch(provider.jwksUri)).json()) as { keys: never[] };

			const { payload } = await compactVerify(token, createLocalJWKSet(jwks));
			const claims = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;

			expect(claims.events).toEqual({ [FAKE_BACKCHANNEL_LOGOUT_EVENT]: {} });
			expect(claims.sub).toBe('ever-id-subject-1');
			expect(claims.nonce).toBeUndefined();
		});
	});

	it('rotates keys: the removed key stops verifying after FR-13’s refresh, the new one works', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);
			const input = { requiredScopes: ['apps:read'], maxLifetimeSeconds: 3_600 };
			const before = await provider.mintAccessToken({ scopes: ['apps:read'] });
			await expect(plugin.verifyAccessToken(before, input)).resolves.toBeDefined();

			await provider.rotateKeys();
			// FR-13: the cached set stays usable for 600 seconds, so the removed key is
			// refused at the **next refresh** and not before — which is what advancing
			// the injected clock past the cache window drives, with no sleeping.
			clockMs += JWKS_CACHE_SECONDS * 1_000;
			await expect(plugin.verifyAccessToken(before, input)).rejects.toMatchObject({ code: 'badSignature' });

			const after = await provider.mintAccessToken({ scopes: ['apps:read'] });
			await expect(plugin.verifyAccessToken(after, input)).resolves.toMatchObject({ issuer: provider.issuer });
		});
	});

	it('keeps the previous key during a rollover, so a token signed with it still verifies', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);
			const input = { requiredScopes: ['apps:read'], maxLifetimeSeconds: 3_600 };
			// A token that is still inside its own 3,600-second window after the key
			// cache is jumped past FR-13's 600 seconds, so the case is about the **key**
			// and not about the clock.
			const before = await provider.mintAccessToken({
				scopes: ['apps:read'],
				expiresAt: provider.nowSeconds() + 3_600
			});
			await expect(plugin.verifyAccessToken(before, input)).resolves.toBeDefined();

			await provider.rotateKeys({ keepPrevious: true });

			const jwks = (await (await fetch(provider.jwksUri)).json()) as { keys: unknown[] };
			expect(jwks.keys).toHaveLength(2);
			clockMs += JWKS_CACHE_SECONDS * 1_000;
			await expect(plugin.verifyAccessToken(before, input)).resolves.toMatchObject({ issuer: provider.issuer });
		});
	});

	it('posts a signed notice to a back-channel endpoint, and reports the answer', async () => {
		await withProvider({}, async (provider) => {
			const seen: string[] = [];
			const endpoint = await startCapture((body) => {
				seen.push(body);
				return { status: 200, body: '', headers: { 'cache-control': 'no-store' } };
			});

			try {
				const answer = await provider.postBackchannelLogout(endpoint.url);

				expect(answer.status).toBe(200);
				expect(answer.cacheControl).toBe('no-store');
				expect(seen).toHaveLength(1);
				const posted = new URLSearchParams(seen[0]).get('logout_token') ?? '';
				expect(posted.split('.')).toHaveLength(3);
			} finally {
				await endpoint.stop();
			}
		});
	});
});

describe('the shipped surface — the `./testing` subpath, and the main entry it must not reach', () => {
	const barrel = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
	const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
		exports: Record<string, Record<string, string>>;
		everworks: { plugin: { capabilities: string[] } };
	};
	const tsup = readFileSync(new URL('../../tsup.config.ts', import.meta.url), 'utf8');
	const distMain = new URL('../../dist/index.js', import.meta.url);
	const distTesting = new URL('../../dist/testing/fake-oidc-provider.js', import.meta.url);

	it('is not reachable from the package entry — the barrel never mentions it', () => {
		expect(barrel).not.toContain('fake-oidc-provider');
		expect(barrel).not.toContain('FakeOidcProvider');
		expect(barrel).not.toContain('testing/');
	});

	it('is published through its own subpath, pointing at its own file', () => {
		expect(manifest.exports['./testing']).toBeDefined();
		expect(JSON.stringify(manifest.exports['./testing'])).toContain('testing/fake-oidc-provider');
		expect(JSON.stringify(manifest.exports['.'])).not.toContain('fake-oidc-provider');
		expect(manifest.exports['.'].import).not.toBe(manifest.exports['./testing'].import);
	});

	it('is built as its own entry, with splitting off so no shared chunk can bridge the two', () => {
		expect(tsup).toContain("'testing/fake-oidc-provider'");
		expect(tsup).toContain('splitting: false');
	});

	it('is absent from the built main entry, and present in its own bundle', () => {
		// `dist` is gitignored and produced by `pnpm build`; when no build is present
		// this case has nothing to read and returns rather than pretending. The three
		// source-level cases above always run, and T8's evidence records the build the
		// real check was run against.
		if (!existsSync(distMain) || !existsSync(distTesting)) return;

		const main = readFileSync(distMain, 'utf8');
		const testing = readFileSync(distTesting, 'utf8');
		expect(main).not.toContain('FakeOidcProvider');
		expect(main).not.toContain('FAKE_BACKCHANNEL_LOGOUT_EVENT');
		expect(main).not.toContain('fake-oidc-provider');
		expect(testing).toContain('FakeOidcProvider');
	});

	it('ships a plugin that is a complete identity provider, per the contract’s own guard', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);

			expect(manifest.everworks.plugin.capabilities).toEqual(['identity-provider']);
			expect(plugin.healthCheck).toBeTypeOf('function');
		});
	});
});

describe('healthCheck — plan §9.2’s plugin health view', () => {
	it('answers `unhealthy` when the integration is not configured, and names no secret', async () => {
		const plugin = new OidcIdentityPlugin({ now: () => clockMs });
		await plugin.onLoad(contextFor({ issuerUrl: 'https://auth.ever.co' }));

		const health = await plugin.healthCheck();

		expect(health.status).toBe('unhealthy');
		expect(health.checks?.find((check) => check.name === 'configuration')?.status).toBe('unhealthy');
		// The same field names `testConnection` reports, and only the missing ones.
		expect(health.checks?.find((check) => check.name === 'configuration')?.message).toBe(
			'Not configured: clientId, clientSecret.'
		);
		expect(JSON.stringify(health)).not.toContain('ever-id-client-secret');
		expect(health.checkedAt).toBe(BASE_TIME_MS);
	});

	it('answers `unknown` for a configured integration nothing has read yet', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);

			const health = await plugin.healthCheck();

			expect(health.status).toBe('unknown');
			expect(health.checks?.find((check) => check.name === 'discovery')?.status).toBe('unknown');
			expect(health.checks?.find((check) => check.name === 'keys')?.status).toBe('unknown');
		});
	});

	it('answers `healthy` once a Test connection has passed, with both timestamps recorded', async () => {
		await withProvider({}, async (provider) => {
			const { plugin } = await pluginFor(provider);
			await plugin.testConnection();

			const health = await plugin.healthCheck();

			expect(health.status).toBe('healthy');
			expect(health.checks?.find((check) => check.name === 'availability')?.status).toBe('healthy');
			expect(health.checks?.find((check) => check.name === 'discovery')?.data?.refreshedAt).toBe(
				new Date(BASE_TIME_MS).toISOString()
			);
			// No token was verified, so no key set has been fetched: the row is
			// `unknown` rather than invented (plan §9.2's admin surface).
			expect(health.checks?.find((check) => check.name === 'keys')?.status).toBe('unknown');
		});
	});

	it('answers `unhealthy` with the closed reason after a failing Test connection', async () => {
		const plugin = new OidcIdentityPlugin({ now: () => clockMs });
		// An address nothing listens on: the discovery read fails twice (FR-15's one
		// retry) and the run records the provider as unusable (FR-14, FR-5).
		await plugin.onLoad(contextFor({ issuerUrl: 'http://127.0.0.1:1', clientId: 'c', clientSecret: 's' }));
		await plugin.testConnection();

		const health = await plugin.healthCheck();

		expect(health.status).toBe('unhealthy');
		expect(health.message).toContain('discoveryFailed');
		expect(health.checks?.find((check) => check.name === 'availability')?.data).toMatchObject({
			unavailableReason: 'discoveryFailed'
		});
		expect(JSON.stringify(health)).not.toContain('127.0.0.1');
	});

	it('measures `duration` on the injected clock, and never on the wall clock', async () => {
		await withProvider({}, async (provider) => {
			const logger = captureLogger();
			// The settings read is the one await `healthCheck` performs, so moving the
			// clock inside it is what makes the duration observable at all — and it is
			// the injected clock that is read, not `Date.now`.
			const slowContext = {
				...contextFor(settingsFor(provider), logger),
				getSettings: vi.fn(async () => {
					clockMs += 7;
					return settingsFor(provider);
				})
			} as unknown as PluginContext;
			const plugin = new OidcIdentityPlugin({ now: () => clockMs });
			await plugin.onLoad(slowContext);

			const health = await plugin.healthCheck();

			expect(health.duration).toBe(7);
			expect(health.checkedAt).toBe(BASE_TIME_MS + 7);
		});
	});

	it('spells the back-channel logout event exactly as the plugin does', () => {
		// Two copies of one wire value, on purpose (a provider does not import the
		// relying party's constants) — and this is the assertion that stops them
		// drifting apart.
		expect(FAKE_BACKCHANNEL_LOGOUT_EVENT).toBe(OIDC_BACKCHANNEL_LOGOUT_EVENT);
		expect(FAKE_BACKCHANNEL_LOGOUT_EVENT).toBe('http://schemas.openid.net/event/backchannel-logout');
	});
});

/**
 * A one-request HTTP endpoint that records its body — how the "post a signed
 * back-channel logout token" helper is tested without standing up the API.
 */
async function startCapture(
	answer: (body: string) => { status: number; body: string; headers: Record<string, string> }
): Promise<{ url: string; stop: () => Promise<void> }> {
	const { createServer } = await import('node:http');
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			const answerFor = answer(Buffer.concat(chunks).toString('utf8'));
			response.writeHead(answerFor.status, { 'content-type': 'text/plain', ...answerFor.headers });
			response.end(answerFor.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}/backchannel-logout`,
		stop: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
		}
	};
}

/** RFC 6749 §2.3.1's `client_secret_basic` header. */
function basic(clientId: string, clientSecret: string): string {
	return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}
