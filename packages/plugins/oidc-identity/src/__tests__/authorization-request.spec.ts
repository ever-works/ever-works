import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { PluginContext } from '@ever-works/plugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OIDC_OUTBOUND_RETRY_DELAY_MS, type OidcFetchImpl, type OidcHttpResponse } from '../discovery.js';
import {
	OIDC_CODE_VERIFIER_BYTES,
	OIDC_CODE_VERIFIER_LENGTH,
	OIDC_NONCE_BYTES,
	OIDC_STATE_BYTES,
	OidcIdentityPlugin
} from '../oidc-identity.plugin.js';
import { OIDC_NEVER_REQUESTED_SCOPES, OIDC_SIGN_IN_SCOPE, OIDC_SIGN_IN_SCOPES, isSignInScope } from '../scopes.js';

/**
 * APW-12 T7 — the authorization request against **ACC-12-06**, in the acceptance
 * criterion's own words:
 *
 * > The authorization request carries S256, a fresh 32-byte `state` and `nonce`,
 * > and the exact registered redirect address.
 *
 * Three claims, and this file makes each of them measurable rather than
 * plausible:
 *
 *   1. **S256.** The `code_challenge` in the query string is recomputed here with
 *      `node:crypto`'s SHA-256 over the returned `codeVerifier` and compared —
 *      the provider's own computation, done independently of the library the
 *      plugin used to produce it. `code_challenge_method` is asserted to be the
 *      literal `S256` and the word `plain` is asserted absent.
 *   2. **Fresh, 32-byte `state` and `nonce`, 64-character verifier.** Ten calls
 *      are made and every returned value asserted distinct; every `state` and
 *      `nonce` is decoded from base64url and asserted to be exactly **32 bytes**;
 *      the verifier is asserted to be exactly 64 characters of PKCE's unreserved
 *      set. One further case injects the randomness seam so the *source* of those
 *      bytes is under the spec's control: the plugin must ask for exactly 32, 32
 *      and 48 bytes and must encode the bytes it was given, which is asserted
 *      against a hand-written base64url vector rather than against the same
 *      `Buffer.toString('base64url')` the implementation calls.
 *   3. **The exact registered redirect address.** A redirect with a path,
 *      a trailing slash and a query string is asserted back out of the built URL
 *      character for character: nothing is normalised, appended or rebuilt.
 *
 * ## The self-referential trap, and how it is avoided here
 *
 * A behavioural case that advances a clock by the constant it asserts tests the
 * constant, not the behaviour (T6 measured exactly that and wrote the warning
 * into `test-connection.spec.ts`). The same trap exists for byte counts: a case
 * that reads `OIDC_STATE_BYTES` and then asserts "the state is `OIDC_STATE_BYTES`
 * long" follows a mutation instead of catching it. So every behavioural
 * assertion below is written against the **literals in FR-9's prose** (`32`,
 * `32`, `64`) and the exported constants are cross-checked separately — against
 * `EVER_ID_LIMITS` read off disk, and against FR-9's own numbers.
 *
 * ## What is not asserted here
 *
 * The transaction cookie, its 600-second life and its sealing are plan §3.4's
 * `EverIdSealService` (T15/T16), and the one redirect address per deployment is
 * derived by the API (`POST /authorize`, plan §5.1) — this package is handed the
 * address and must not rebuild it, which is all FR-10 asks of it. The skew and
 * the claim rules of FR-11 are `id-token.spec.ts`.
 */

const ISSUER = 'https://auth.ever.co';
const AUTHORIZATION_ENDPOINT = `${ISSUER}/oauth/v2/authorize`;
const CLIENT_ID = 'ever-works-web';
const SECRET = 'ever-id-client-secret-0123456789abcdef-do-not-print';
const REDIRECT_URI = 'https://ever.works/api/auth/ever-id/callback/';

/** FR-9's numbers, written as literals rather than read from the module (see the header). */
const FR9_STATE_BYTES = 32;
const FR9_NONCE_BYTES = 32;
const FR9_CODE_VERIFIER_LENGTH = 64;
const FR9_CODE_VERIFIER_BYTES = 48;

/** RFC 7636 §4.1's unreserved set, which base64url's output is a subset of. */
const PKCE_UNRESERVED = /^[A-Za-z0-9\-._~]+$/u;

/** The discovery document a healthy ZITADEL-shaped provider publishes (plan §4.3). */
const healthyDocument = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	issuer: ISSUER,
	authorization_endpoint: AUTHORIZATION_ENDPOINT,
	token_endpoint: `${ISSUER}/oauth/v2/token`,
	jwks_uri: `${ISSUER}/oauth/v2/keys`,
	code_challenge_methods_supported: ['S256'],
	id_token_signing_alg_values_supported: ['RS256'],
	...overrides
});

const settings = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	issuerUrl: ISSUER,
	clientId: CLIENT_ID,
	clientSecret: SECRET,
	...overrides
});

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

/**
 * A provider whose discovery document is served from memory.
 *
 * `requests` records every URL the plugin touched, so a case can assert that a
 * refusal happened **without** a call (FR-12's "offline" ordering has its own
 * home in `id-token.spec.ts`; here it is the unconfigured and drift cases that
 * must not reach the network). The token and key endpoints are routed too, so the
 * same fake serves both specs' shapes without pretending to be a token exchange.
 */
interface FakeProvider {
	readonly requests: string[];
	readonly fetch: OidcFetchImpl;
	mode: 'ok' | 'reject' | 'http500';
	document: Record<string, unknown>;
}

const fakeProvider = (mode: FakeProvider['mode'] = 'ok'): FakeProvider => {
	const provider: FakeProvider = {
		requests: [],
		mode,
		document: healthyDocument(),
		fetch: async (url, init): Promise<OidcHttpResponse> => {
			provider.requests.push(url);
			switch (provider.mode) {
				case 'reject':
					throw new Error('connect ECONNREFUSED (transport)');
				case 'http500':
					return { ok: false, status: 503, json: async () => ({}) };
				default:
					if (url.endsWith('/.well-known/openid-configuration')) {
						return { ok: true, status: 200, json: async () => provider.document };
					}
					if (url.endsWith('/oauth/v2/keys')) {
						return { ok: true, status: 200, json: async () => ({ keys: [] }) };
					}
					throw new Error(`unexpected request: ${url} (init.headers=${JSON.stringify(init.headers)})`);
			}
		}
	};
	return provider;
};

const pluginFor = async (
	provider: FakeProvider,
	values: Record<string, unknown> = settings(),
	options: { randomBytes?: (length: number) => Uint8Array } = {}
): Promise<OidcIdentityPlugin> => {
	const plugin = new OidcIdentityPlugin({ fetchImpl: provider.fetch, ...options });
	await plugin.onLoad(contextFor(values));
	return plugin;
};

/** The parameters of a built authorization URL, read back the way a provider reads them. */
const parametersOf = (url: string): URLSearchParams => new URL(url).searchParams;

/**
 * Run a call whose first fetch attempt fails, to completion.
 *
 * FR-15's retry waits 1,000 ms on a `setTimeout` inside `discovery.ts`, so a call
 * that fails an attempt only settles once the fake clock moves — and a spec that
 * really waited one second is not a spec.
 */
const settleFailure = async <T>(work: Promise<T>, ms = OIDC_OUTBOUND_RETRY_DELAY_MS + 100): Promise<T> => {
	const advanced = vi.advanceTimersByTimeAsync(ms);
	try {
		return await work;
	} finally {
		await advanced;
	}
};

/** How many bytes a base64url string carries — the only way FR-9's "32 bytes" is checkable. */
const decodedLength = (value: string): number => Buffer.from(value, 'base64url').length;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.parse('2026-09-17T09:00:00.000Z'));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('ACC-12-06 — S256, fresh 32-byte state and nonce, the exact redirect', () => {
	it('builds the request against the discovered authorization endpoint with every FR-8 parameter', async () => {
		const provider = fakeProvider();
		const plugin = await pluginFor(provider);

		const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
		const url = new URL(request.url);

		expect(url.origin + url.pathname).toBe(AUTHORIZATION_ENDPOINT);
		expect(parametersOf(request.url).get('response_type')).toBe('code');
		expect(parametersOf(request.url).get('client_id')).toBe(CLIENT_ID);
		// Exactly once: a duplicated parameter is refused by some providers, and
		// `buildAuthorizationUrl` would add its own copy if one were absent here.
		expect(url.searchParams.getAll('client_id')).toEqual([CLIENT_ID]);
		expect(parametersOf(request.url).get('redirect_uri')).toBe(REDIRECT_URI);
		expect(parametersOf(request.url).get('scope')).toBe('openid email profile');
		expect(parametersOf(request.url).get('code_challenge_method')).toBe('S256');
		expect(parametersOf(request.url).get('state')).toBe(request.state);
		expect(parametersOf(request.url).get('nonce')).toBe(request.nonce);
		expect(parametersOf(request.url).get('code_challenge')).not.toBeNull();
		// FR-8: implicit, hybrid and plain PKCE are never used, so neither
		// `response_mode` nor `code_challenge_method=plain` is ever sent.
		expect(parametersOf(request.url).get('code_challenge_method')).not.toBe('plain');
		expect(parametersOf(request.url).get('response_mode')).toBeNull();
		// One discovery read served the request.
		expect(provider.requests).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
	});

	it('challenges the verifier with S256, computed here the way the provider will compute it', async () => {
		const plugin = await pluginFor(fakeProvider());

		const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
		// The independent computation: SHA-256 of the verifier's ASCII bytes, base64url,
		// no padding (RFC 7636 §4.2). A `plain` challenge would be the verifier itself,
		// and a mutant that swapped the transformation reddens exactly here.
		const expected = createHash('sha256').update(request.codeVerifier, 'ascii').digest('base64url');

		expect(parametersOf(request.url).get('code_challenge')).toBe(expected);
		expect(parametersOf(request.url).get('code_challenge')).not.toBe(request.codeVerifier);
		// The verifier itself never travels in the front channel: RFC 7636's whole
		// point is that only its S256 transformation does. (FR-9 keeps the verifier in
		// the sealed transaction cookie; this is the half this method owns.)
		const verifierInUrl = request.url.includes(request.codeVerifier);
		expect(verifierInUrl).toBe(false);
	});

	it('draws a fresh 32-byte state, a fresh 32-byte nonce and a fresh 64-character verifier on every call', async () => {
		const plugin = await pluginFor(fakeProvider());

		const requests = await Promise.all(
			Array.from({ length: 10 }, () => plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI }))
		);

		const states = requests.map((request) => request.state);
		const nonces = requests.map((request) => request.nonce);
		const verifiers = requests.map((request) => request.codeVerifier);

		// Freshness: ten calls, ten different values each. (A shared or cached value is
		// the failure this asserts against; the chance of a false pass with real
		// randomness is 2^-256 per pair.)
		expect(new Set(states).size).toBe(10);
		expect(new Set(nonces).size).toBe(10);
		expect(new Set(verifiers).size).toBe(10);
		expect(states.some((state) => nonces.includes(state))).toBe(false);

		// Byte counts: decoded, not counted in characters.
		expect(states.map(decodedLength)).toEqual(Array.from({ length: 10 }, () => FR9_STATE_BYTES));
		expect(nonces.map(decodedLength)).toEqual(Array.from({ length: 10 }, () => FR9_NONCE_BYTES));

		// The verifier is 64 characters of PKCE's unreserved set, and base64url — so
		// the byte count behind it is 48.
		expect(verifiers.map((verifier) => verifier.length)).toEqual(
			Array.from({ length: 10 }, () => FR9_CODE_VERIFIER_LENGTH)
		);
		expect(verifiers.filter((verifier) => !PKCE_UNRESERVED.test(verifier))).toEqual([]);
		expect(verifiers.map(decodedLength)).toEqual(Array.from({ length: 10 }, () => FR9_CODE_VERIFIER_BYTES));

		// And every challenge followed its own verifier, so a cached challenge cannot
		// pass while the verifier is fresh.
		const expected = verifiers.map((verifier) =>
			createHash('sha256').update(verifier, 'ascii').digest('base64url')
		);
		expect(requests.map((request) => parametersOf(request.url).get('code_challenge'))).toEqual(expected);
	});

	it('keeps the redirect address byte-for-byte, including its path, trailing slash and query (FR-10)', async () => {
		const plugin = await pluginFor(fakeProvider());
		const exact = 'https://ever.works/api/auth/ever-id/callback/?next=%2Fapps&t=1';

		const request = await plugin.buildAuthorizationRequest({ redirectUri: exact });

		expect(parametersOf(request.url).get('redirect_uri')).toBe(exact);
		// The URL carries it percent-encoded on the wire, which is the only correct
		// spelling — the claim is that nothing was added, dropped or normalised.
		expect(request.url).toContain(`redirect_uri=${encodeURIComponent(exact)}`);
	});

	it('carries prompt=login and max_age only when the caller asks for a fresh authentication (FR-25)', async () => {
		const plugin = await pluginFor(fakeProvider());

		const plain = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
		expect(parametersOf(plain.url).get('prompt')).toBeNull();
		expect(parametersOf(plain.url).get('max_age')).toBeNull();

		const reauth = await plugin.buildAuthorizationRequest({
			redirectUri: REDIRECT_URI,
			prompt: 'login',
			maxAgeSeconds: 300
		});
		expect(parametersOf(reauth.url).get('prompt')).toBe('login');
		expect(parametersOf(reauth.url).get('max_age')).toBe('300');
	});

	it('never asks for offline_access, and never for a scope the sign-in does not read (FR-38)', async () => {
		const plugin = await pluginFor(fakeProvider());

		const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
		const scope = parametersOf(request.url).get('scope') ?? '';

		expect(scope).toBe('openid email profile');
		expect(isSignInScope(scope)).toBe(true);
		// FR-16 as well as FR-38: the request carries the client id and no secret, and
		// no scope outside the sign-in set.
		const carriesOfflineAccess = request.url.includes('offline_access');
		const carriesSecret = request.url.includes(SECRET);
		expect({ carriesOfflineAccess, carriesSecret }).toEqual({ carriesOfflineAccess: false, carriesSecret: false });
	});

	it('refuses a scope string that is not exactly the sign-in set', () => {
		expect(isSignInScope('openid email profile')).toBe(true);
		expect(isSignInScope('openid  email   profile')).toBe(true);
		expect(isSignInScope('openid email')).toBe(false);
		expect(isSignInScope('openid email profile offline_access')).toBe(false);
		expect(isSignInScope('openid email profile profile')).toBe(false);
		expect(isSignInScope('openid email profile apps:read')).toBe(false);
		expect(isSignInScope('')).toBe(false);
	});
});

describe('FR-9 — the randomness seam', () => {
	it('asks for exactly 32, 32 and 48 bytes and encodes the bytes it was given', async () => {
		const requestedLengths: number[] = [];
		const plugin = await pluginFor(fakeProvider(), settings(), {
			randomBytes: (length) => {
				requestedLengths.push(length);
				// A distinct, deterministic pattern per draw, so the three values cannot
				// be confused with one another.
				return new Uint8Array(length).fill(requestedLengths.length);
			}
		});

		const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });

		expect(requestedLengths).toEqual([FR9_STATE_BYTES, FR9_NONCE_BYTES, FR9_CODE_VERIFIER_BYTES]);
		// base64url of `[1, 1, …]` — 43 characters whose first group is `AQEB`; the
		// point of the assertion is that the plugin encodes the raw bytes it was handed,
		// not a derived or re-randomised value.
		expect(request.state).toBe(Buffer.from(new Uint8Array(FR9_STATE_BYTES).fill(1)).toString('base64url'));
		expect(request.nonce).toBe(Buffer.from(new Uint8Array(FR9_NONCE_BYTES).fill(2)).toString('base64url'));
		expect(request.codeVerifier.length).toBe(FR9_CODE_VERIFIER_LENGTH);
		expect([...Buffer.from(request.codeVerifier, 'base64url')]).toEqual(
			Array.from({ length: FR9_CODE_VERIFIER_BYTES }, () => 3)
		);
	});

	it('encodes an injected vector to the base64url spelling written down here, by hand', async () => {
		// `[1, 2, 3]` then zeros: the first base64 group of `01 02 03` is `AQID`, and
		// 29 zero bytes contribute 39 more `A` characters (base64url drops the `=`).
		const plugin = await pluginFor(fakeProvider(), settings(), {
			randomBytes: (length) => {
				const bytes = new Uint8Array(length);
				bytes.set([1, 2, 3].slice(0, length));
				return bytes;
			}
		});

		const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });

		expect(request.state).toBe('AQID' + 'A'.repeat(39));
		expect(request.state.length).toBe(43);
	});
});

describe('what stops a request from being built (FR-2, FR-14)', () => {
	it('refuses an unconfigured integration without touching the network', async () => {
		const provider = fakeProvider();
		const plugin = await pluginFor(provider, { issuerUrl: ISSUER, clientId: '', clientSecret: SECRET });

		const captured: { name?: string; message?: string; reason?: string } = {};
		try {
			await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
		} catch (error) {
			const failure = error as Error & { reason?: string };
			captured.name = failure.name;
			captured.message = failure.message;
			captured.reason = failure.reason;
		}

		expect(captured).toEqual({
			name: 'OidcProviderUnavailableError',
			message: 'providerUnavailable',
			reason: 'notConfigured'
		});
		expect(provider.requests).toEqual([]);
	});

	it('refuses a provider whose discovery document cannot be read (FR-14)', async () => {
		const plugin = await pluginFor(fakeProvider('reject'));

		await expect(
			settleFailure(plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI }))
		).rejects.toMatchObject({ reason: 'discoveryFailed' });
	});

	it('refuses a provider whose document names a different issuer (FR-14)', async () => {
		const provider = fakeProvider();
		provider.document = healthyDocument({ issuer: 'https://auth.example.net' });
		const plugin = await pluginFor(provider);

		await expect(plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI })).rejects.toMatchObject({
			reason: 'issuerDrift'
		});
	});

	it('refuses a document that advertises no authorization endpoint (FR-3)', async () => {
		const provider = fakeProvider();
		provider.document = healthyDocument({ authorization_endpoint: undefined });
		const plugin = await pluginFor(provider);

		await expect(plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI })).rejects.toMatchObject({
			reason: 'discoveryIncomplete'
		});
	});

	it('builds a request for the one non-TLS issuer the settings schema accepts (FR-2)', async () => {
		const provider = fakeProvider();
		provider.document = healthyDocument({
			issuer: 'http://localhost:4000',
			authorization_endpoint: 'http://localhost:4000/oauth/v2/authorize'
		});
		const plugin = await pluginFor(provider, settings({ issuerUrl: 'http://localhost:4000' }));

		const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });

		expect(new URL(request.url).origin).toBe('http://localhost:4000');
		expect(parametersOf(request.url).get('code_challenge_method')).toBe('S256');
	});

	it('serves a second request from the 3,600-second discovery cache (FR-14)', async () => {
		const provider = fakeProvider();
		const plugin = await pluginFor(provider);

		await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
		await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
		// A different redirect is still the same issuer: the document is not re-read.
		await plugin.buildAuthorizationRequest({ redirectUri: `${REDIRECT_URI}other` });

		expect(provider.requests).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
	});
});

describe('the transcribed FR-9 numbers still match the contract and the schema', () => {
	const contractsSource = readFileSync(
		new URL('../../../../contracts/src/apps/ever-id.ts', import.meta.url),
		'utf-8'
	);

	const limitValue = (key: string): number => {
		const match = new RegExp(`\\b${key}:\\s*([0-9_]+)`, 'u').exec(contractsSource);
		expect(match, `${key} not found in EVER_ID_LIMITS`).not.toBeNull();
		return Number((match as RegExpExecArray)[1].replaceAll('_', ''));
	};

	it('mirrors the state, nonce and verifier sizes of FR-9', () => {
		expect(OIDC_STATE_BYTES).toBe(limitValue('stateBytes'));
		expect(OIDC_NONCE_BYTES).toBe(limitValue('nonceBytes'));
		// FR-9's number is 64 characters; this package draws 48 bytes because that is
		// how many base64url encode to 64, and the assertion is that the two agree.
		expect(OIDC_CODE_VERIFIER_LENGTH).toBe(limitValue('codeVerifierLength'));
		expect(Buffer.from(new Uint8Array(OIDC_CODE_VERIFIER_BYTES)).toString('base64url').length).toBe(
			OIDC_CODE_VERIFIER_LENGTH
		);
		// FR-9's prose, pinned literally so a change has to change this line too.
		expect([OIDC_STATE_BYTES, OIDC_NONCE_BYTES, OIDC_CODE_VERIFIER_LENGTH]).toEqual([32, 32, 64]);
	});

	it('pins the sign-in scopes of plan §4.2 and the scope FR-38 forbids', () => {
		expect([...OIDC_SIGN_IN_SCOPES]).toEqual(['openid', 'email', 'profile']);
		expect(OIDC_SIGN_IN_SCOPE).toBe('openid email profile');
		expect([...OIDC_NEVER_REQUESTED_SCOPES]).toEqual(['offline_access']);
		// The plan's words, in one place: the request never carries the refresh scope
		// and never carries a scope the contract defines for another purpose.
		expect(OIDC_SIGN_IN_SCOPE.includes('offline_access')).toBe(false);
		expect(OIDC_SIGN_IN_SCOPE.includes('apps:read')).toBe(false);
		expect(OIDC_SIGN_IN_SCOPE.includes('ever-works:session')).toBe(false);
	});
});
