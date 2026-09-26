import { readFileSync } from 'node:fs';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JWK } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginContext } from '@ever-works/plugin';

import { type OidcFetchImpl, type OidcHttpResponse } from '../discovery.js';
import {
	OIDC_DEFAULT_CLOCK_SKEW_SECONDS,
	OIDC_ID_TOKEN_MAX_AGE_SECONDS,
	OIDC_SUBJECT_MAX_LENGTH,
	OidcIdentityPlugin
} from '../oidc-identity.plugin.js';
import { oidcIdentitySettingsSchema } from '../settings.schema.js';

/**
 * APW-12 T7 — the ID token against **ACC-12-07**, in the acceptance criterion's
 * own words:
 *
 * > An ID token with a wrong issuer, audience, nonce, algorithm `none`, a
 * > symmetric algorithm, an expired `exp` beyond 60 seconds, or an `iat` older
 * > than 600 seconds is refused.
 *
 * Every clause of that sentence has a case below, and so does every other rule
 * FR-11 states ("its signature verifies against Ever ID's published keys"; "`iss`
 * equals the configured issuer and is allow-listed"; "`aud` contains the client
 * ID, and when `aud` has several values `azp` equals the client ID"; "`iat` is no
 * later than now plus the skew"; "`nonce` matches"; "`sub` is 1–255 characters")
 * plus FR-12's authorization-response `iss`, plus the two edges the criterion
 * does not name but FR-11 implies — a token that is **not yet** valid (`iat` in
 * the future beyond the skew) and a subject of exactly the maximum length.
 *
 * ## The clock, and the skew edges
 *
 * `EXCHANGE` is driven by an injected clock (`OidcIdentityPluginOptions.now`, the
 * seam T6 added), not by `Date.now` and not by sleeping: every time case moves
 * that clock and asserts an outcome, and the numbers in the cases are the
 * **literals of FR-11's prose** — `60`, `600`, `300` — never the module's
 * constants. A behavioural case that advanced the clock by the constant it
 * asserts would follow a mutant instead of catching it (T6 measured exactly
 * that); the exported constants are cross-checked at the end of this file
 * against `EVER_ID_LIMITS` and against the settings schema's own defaults.
 *
 * ## Real signatures
 *
 * Tokens are signed by `jose` with freshly generated ES256 key pairs, published
 * as `exportJWK` output, and verified through the plugin's real key cache and a
 * real `compactVerify`. Nothing stubs the signature layer: FR-11's first clause
 * is about signature verification, and `badSignature`/`badAlg` are only
 * meaningful if a real verification produced them.
 *
 * ## What this file does not prove
 *
 * It is a **unit** proof: one process, one fake provider. FR-19's "a sign-in
 * transaction completes at most once", the transaction cookie and its 600
 * seconds (§3.4), the account-resolution branches (FR-22…FR-25) and the
 * end-to-end callback are T20/T25's integration and flow specs. The scope
 * statement in the T7 report says the same thing in the author's words.
 */

const ISSUER = 'https://auth.ever.co';
const AUTHORIZATION_ENDPOINT = `${ISSUER}/oauth/v2/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/v2/token`;
const JWKS_URI = `${ISSUER}/oauth/v2/keys`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = 'ever-works-web';
const SECRET = 'ever-id-client-secret-0123456789abcdef-do-not-print';
const REDIRECT_URI = 'https://ever.works/api/auth/ever-id/callback';
const CODE = 'authorization-code-1';
const CODE_VERIFIER = 'a-64-character-code-verifier-0123456789abcdefghijklmnopqrstuvwxyzABCD';
const NONCE = 'the-nonce-the-transaction-sealed';

/** FR-11's and FR-15's numbers, written as literals rather than read from the module (see the header). */
const FR11_SKEW_SECONDS = 60;
const FR11_ID_TOKEN_MAX_AGE_SECONDS = 600;
const FR25_CONNECT_MAX_AUTH_AGE_SECONDS = 300;
const FR11_SUBJECT_MAX_LENGTH = 255;
const FR15_TIMEOUT_MS = 5_000;

const BASE_TIME_MS = Date.parse('2026-09-17T09:00:00.000Z');
const BASE_TIME_SECONDS = Math.floor(BASE_TIME_MS / 1_000);

/** The injected clock. Real timers stay in charge of the one timeout case. */
let clockMs = BASE_TIME_MS;

const at = (offsetSeconds: number): void => {
	clockMs = BASE_TIME_MS + offsetSeconds * 1_000;
};

interface TestKey {
	readonly kid: string;
	readonly jwk: JWK;
	readonly privateKey: CryptoKey;
}

/** A real ES256 key pair, published the way a provider publishes it. */
const makeKey = async (kid: string): Promise<TestKey> => {
	const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
	const jwk = await exportJWK(publicKey);
	return { kid, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' }, privateKey };
};

/** The discovery document a healthy ZITADEL-shaped provider publishes (plan §4.3). */
const healthyDocument = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	issuer: ISSUER,
	authorization_endpoint: AUTHORIZATION_ENDPOINT,
	token_endpoint: TOKEN_ENDPOINT,
	jwks_uri: JWKS_URI,
	code_challenge_methods_supported: ['S256'],
	id_token_signing_alg_values_supported: ['ES256'],
	...overrides
});

const settings = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	issuerUrl: ISSUER,
	clientId: CLIENT_ID,
	clientSecret: SECRET,
	...overrides
});

/**
 * The claims a valid ID token carries, in one place, so each case can be read as
 * "everything is valid, except this".
 *
 * The times are absolute seconds and sit in the middle of their windows; the
 * edge cases below move them explicitly.
 */
const validClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	iss: ISSUER,
	sub: 'subject-1',
	aud: CLIENT_ID,
	exp: BASE_TIME_SECONDS + 300,
	iat: BASE_TIME_SECONDS,
	nonce: NONCE,
	email: 'person@example.com',
	email_verified: true,
	name: 'A Person',
	auth_time: BASE_TIME_SECONDS,
	sid: 'ever-id-session-1',
	...overrides
});

/** Sign a claim set with a real private key, the way the provider signs it. */
const signIdToken = (claims: Record<string, unknown>, key: TestKey, alg = 'ES256'): Promise<string> =>
	new SignJWT(claims).setProtectedHeader({ alg, kid: key.kid }).sign(key.privateKey);

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

interface FakeCall {
	readonly url: string;
	readonly method: string | undefined;
	readonly body: string | undefined;
	readonly headers: Record<string, string>;
}

/**
 * A provider with a token endpoint, a key set and a discovery document.
 *
 * `mode` is the whole vocabulary FR-13/FR-15 have to survive at this boundary: a
 * normal answer, an error status, a transport error, a socket that never answers,
 * and — the one FR-11 cannot check itself — a 200 that carries no `id_token`.
 * Every call is recorded with its method, body and headers, so FR-15's "never
 * retried" and plan §4.2's `client_secret_basic` are asserted on what actually
 * went out rather than on what the code says.
 */
interface FakeProvider {
	readonly calls: FakeCall[];
	readonly fetch: OidcFetchImpl;
	document: Record<string, unknown>;
	keys: JWK[];
	idToken: string | null;
	mode: 'ok' | 'http500' | 'reject' | 'hang' | 'noIdToken';
}

const jsonAnswer = (body: unknown): OidcHttpResponse => ({ ok: true, status: 200, json: async () => body });

const fakeProvider = (): FakeProvider => {
	const provider: FakeProvider = {
		calls: [],
		document: healthyDocument(),
		keys: [],
		idToken: null,
		mode: 'ok',
		fetch: async (url, init): Promise<OidcHttpResponse> => {
			provider.calls.push({ url, method: init.method, body: init.body, headers: init.headers });
			if (url === DISCOVERY_URL) return jsonAnswer(provider.document);
			if (url === JWKS_URI) return jsonAnswer({ keys: provider.keys });
			if (url === TOKEN_ENDPOINT) {
				switch (provider.mode) {
					case 'reject':
						throw new Error('connect ECONNREFUSED (transport)');
					case 'http500':
						return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
					case 'hang':
						// A real `fetch` rejects when its signal aborts; modelling that is
						// what makes FR-15's bound observable at all.
						return new Promise<OidcHttpResponse>((_resolve, reject) => {
							init.signal.addEventListener('abort', () =>
								reject(new DOMException('The operation was aborted.', 'AbortError'))
							);
						});
					case 'noIdToken':
						return jsonAnswer({ access_token: 'ever-id-access-token', token_type: 'Bearer' });
					default:
						return jsonAnswer({
							id_token: provider.idToken,
							access_token: 'ever-id-access-token',
							token_type: 'Bearer',
							expires_in: 300
						});
				}
			}
			throw new Error(`unexpected request: ${url}`);
		}
	};
	return provider;
};

const pluginFor = async (
	provider: FakeProvider,
	values: Record<string, unknown> = settings()
): Promise<{ plugin: OidcIdentityPlugin; logger: CapturedLogger }> => {
	const logger = captureLogger();
	// The injected clock, so nothing here depends on `Date.now` — and real timers,
	// so the one case that needs a timer owns the switch to fake ones.
	const plugin = new OidcIdentityPlugin({ fetchImpl: provider.fetch, now: () => clockMs });
	await plugin.onLoad(contextFor(values, logger));
	return { plugin, logger };
};

/** Redeem the code with the token the provider is currently configured to answer. */
const exchange = (
	plugin: OidcIdentityPlugin,
	overrides: {
		receivedIssuer?: string;
		maxAuthAgeSeconds?: number;
		expectedNonce?: string;
		codeVerifier?: string;
	} = {}
) =>
	plugin.exchangeAuthorizationCode({
		code: CODE,
		redirectUri: REDIRECT_URI,
		codeVerifier: overrides.codeVerifier ?? CODE_VERIFIER,
		expectedNonce: overrides.expectedNonce ?? NONCE,
		...(overrides.receivedIssuer === undefined ? {} : { receivedIssuer: overrides.receivedIssuer }),
		...(overrides.maxAuthAgeSeconds === undefined ? {} : { maxAuthAgeSeconds: overrides.maxAuthAgeSeconds })
	});

/** Sign `claims` with `key`, publish `key`, and answer them from the token endpoint. */
const exchangeClaims = async (
	claims: Record<string, unknown>,
	options: {
		key?: TestKey;
		published?: JWK[];
		settings?: Record<string, unknown>;
		alg?: string;
	} = {}
): Promise<{ plugin: OidcIdentityPlugin; provider: FakeProvider; logger: CapturedLogger }> => {
	const key = options.key ?? (await makeKey('key-a'));
	const provider = fakeProvider();
	provider.keys = options.published ?? [key.jwk];
	provider.idToken = await signIdToken(claims, key, options.alg ?? 'ES256');
	const { plugin, logger } = await pluginFor(provider, options.settings ?? settings());
	return { plugin, provider, logger };
};

/** The refusal every claim rule raises: one code, and nothing else in the message (FR-16). */
const expectRefusal = async (work: Promise<unknown>, code: string): Promise<void> => {
	await expect(work, code).rejects.toMatchObject({ code });
};

/** How many times a given endpoint was called. */
const callsTo = (provider: FakeProvider, url: string): FakeCall[] => provider.calls.filter((call) => call.url === url);

afterEach(() => {
	clockMs = BASE_TIME_MS;
	vi.useRealTimers();
});

describe('the accepted token (FR-11) — everything valid, and the claims the platform keeps', () => {
	it('answers the seven claims of VerifiedIdTokenClaims', async () => {
		const { plugin } = await exchangeClaims(validClaims());

		await expect(exchange(plugin)).resolves.toEqual({
			issuer: ISSUER,
			subject: 'subject-1',
			email: 'person@example.com',
			emailVerified: true,
			name: 'A Person',
			authTime: BASE_TIME_SECONDS,
			sid: 'ever-id-session-1'
		});
	});

	it('answers null/false for the claims a provider may omit, and never invents a value', async () => {
		const claims = validClaims();
		for (const claim of ['email', 'email_verified', 'name', 'auth_time', 'sid']) delete claims[claim];
		const { plugin } = await exchangeClaims(claims);

		await expect(exchange(plugin)).resolves.toEqual({
			issuer: ISSUER,
			subject: 'subject-1',
			email: null,
			emailVerified: false,
			name: null,
			authTime: null,
			sid: null
		});
	});

	it('accepts an `email_verified` of true and refuses to read anything else as true', async () => {
		const verified = await exchangeClaims(validClaims({ email_verified: true }));
		await expect(exchange(verified.plugin)).resolves.toMatchObject({ emailVerified: true });

		// The claim "reflects `email_verified` exactly" (plan §4.1): a string is not a
		// boolean, and FR-23/FR-25 branch on the pair, so a truthy string must not pass
		// as consent to use an address.
		const stringy = await exchangeClaims(validClaims({ email_verified: 'true' }));
		await expect(exchange(stringy.plugin)).resolves.toMatchObject({ emailVerified: false });
	});

	it('sends the code with client_secret_basic and the four form fields of RFC 6749 §4.1.3', async () => {
		const { plugin, provider } = await exchangeClaims(validClaims());

		await exchange(plugin);

		const [call] = callsTo(provider, TOKEN_ENDPOINT);
		expect(call.method).toBe('POST');
		expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
		expect(call.headers.accept).toBe('application/json');

		// `ClientSecretBasic` (RFC 6749 §2.3.1 / Appendix B): the credentials are
		// form-urlencoded and then base64'd into the `authorization` header. The
		// property that matters is that a provider decoding the header recovers the
		// configured pair exactly; the boolean comparison keeps a failure from printing
		// the secret into this spec's output.
		const encoded = (call.headers.authorization ?? '').replace(/^Basic /u, '');
		const credentials = Buffer.from(encoded, 'base64').toString('utf8');
		const [username, password] = credentials.split(':');
		const clientIdMatches = decodeURIComponent(username ?? '') === CLIENT_ID;
		const secretMatches = decodeURIComponent(password ?? '') === SECRET;
		expect({ clientIdMatches, secretMatches }).toEqual({ clientIdMatches: true, secretMatches: true });
		// The spelling is pinned, because it is not quite what Appendix B prescribes:
		// `oauth4webapi`'s `formUrlEncode` percent-encodes `-` (and `_`, `.`, `!`, `~`,
		// `*`, `'`, `(`, `)`), where Appendix B leaves the unreserved set alone. A server
		// that percent-decodes the credential — as RFC 6749 tells it to — sees
		// `ever-works-web` either way; the T7 report carries this as an interop finding.
		expect(username).toBe('ever%2Dworks%2Dweb');

		const body = new URLSearchParams(call.body ?? '');
		expect([...body.keys()].sort()).toEqual(['code', 'code_verifier', 'grant_type', 'redirect_uri']);
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('code')).toBe(CODE);
		expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
		// The verifier goes to the provider and nowhere else: this is the only request
		// that carries it.
		expect(body.get('code_verifier')).toBe(CODE_VERIFIER);
	});

	it('never retries the exchange, however the token endpoint fails (FR-15)', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		provider.mode = 'http500';
		const { plugin } = await pluginFor(provider);

		await expectRefusal(exchange(plugin), 'providerUnavailable');

		// Discovery and the key set retry once (FR-15); the token endpoint does not,
		// because a second attempt is a second redemption of a single-use code (FR-19).
		expect(callsTo(provider, TOKEN_ENDPOINT)).toHaveLength(1);
	});
});

describe('FR-12 — the issuer the authorization response names', () => {
	it('refuses a response that names another issuer, without touching the network', async () => {
		const { plugin, provider, logger } = await exchangeClaims(validClaims());
		// The load line is the only thing the plugin has logged so far.
		const loggedAtLoad = logger.lines.length;

		await expectRefusal(exchange(plugin, { receivedIssuer: 'https://auth.example.net' }), 'badIssuer');

		// Nothing was redeemed and nothing was fetched: a code whose response named
		// another issuer is not a code this installation may spend.
		expect(provider.calls).toEqual([]);
		expect(logger.lines.slice(loggedAtLoad)).toEqual([]);
	});

	it('accepts a response that names the configured issuer', async () => {
		const { plugin, provider } = await exchangeClaims(validClaims());

		await expect(exchange(plugin, { receivedIssuer: ISSUER })).resolves.toMatchObject({ issuer: ISSUER });
		expect(callsTo(provider, TOKEN_ENDPOINT)).toHaveLength(1);
	});
});

describe('FR-11 — the issuer (plan §4.3)', () => {
	it('refuses a token whose `iss` is not the configured issuer', async () => {
		const { plugin } = await exchangeClaims(validClaims({ iss: 'https://auth.example.net' }));
		await expectRefusal(exchange(plugin), 'badIssuer');
	});

	it('refuses a token whose `iss` is not allow-listed, even when it is the configured issuer', async () => {
		const { plugin } = await exchangeClaims(validClaims(), {
			settings: settings({ allowedIssuers: ['https://auth.example.net'] })
		});
		await expectRefusal(exchange(plugin), 'badIssuer');
	});

	it('refuses a token from an allow-listed issuer that is not the one the document advertises', async () => {
		const { plugin } = await exchangeClaims(validClaims({ iss: 'https://auth.old.example' }), {
			settings: settings({ allowedIssuers: [ISSUER, 'https://auth.old.example'] })
		});
		await expectRefusal(exchange(plugin), 'badIssuer');
	});

	it('refuses a token with no `iss` at all', async () => {
		const claims = validClaims();
		delete claims.iss;
		const { plugin } = await exchangeClaims(claims);
		await expectRefusal(exchange(plugin), 'badIssuer');
	});
});

describe('FR-11 — the audience and `azp` (plan §4.3)', () => {
	it('refuses a token for another client', async () => {
		const { plugin } = await exchangeClaims(validClaims({ aud: 'ever-works-cli' }));
		await expectRefusal(exchange(plugin), 'badAudience');
	});

	it('refuses a token whose audience list does not contain the client id', async () => {
		const { plugin } = await exchangeClaims(validClaims({ aud: ['ever-works-cli', 'another-app'] }));
		await expectRefusal(exchange(plugin), 'badAudience');
	});

	it('refuses an audience that is neither a string nor a list of strings', async () => {
		const { plugin } = await exchangeClaims(validClaims({ aud: 42 }));
		await expectRefusal(exchange(plugin), 'badAudience');
	});

	it('refuses a multi-valued audience with no `azp`', async () => {
		const { plugin } = await exchangeClaims(validClaims({ aud: [CLIENT_ID, 'another-app'] }));
		await expectRefusal(exchange(plugin), 'badAuthorizedParty');
	});

	it('refuses a multi-valued audience whose `azp` is another client', async () => {
		const { plugin } = await exchangeClaims(validClaims({ aud: [CLIENT_ID, 'another-app'], azp: 'another-app' }));
		await expectRefusal(exchange(plugin), 'badAuthorizedParty');
	});

	it('accepts a multi-valued audience whose `azp` is the client id', async () => {
		const { plugin } = await exchangeClaims(validClaims({ aud: [CLIENT_ID, 'another-app'], azp: CLIENT_ID }));
		await expect(exchange(plugin)).resolves.toMatchObject({ subject: 'subject-1' });
	});

	it('accepts a single-valued audience equal to the client id even when `azp` names another party (FR-11 is narrower than OIDC Core here)', async () => {
		const { plugin } = await exchangeClaims(validClaims({ aud: CLIENT_ID, azp: 'another-app' }));
		await expect(exchange(plugin)).resolves.toMatchObject({ subject: 'subject-1' });
	});
});

describe('FR-11 — the times, at the skew edges (ACC-12-07)', () => {
	it('refuses a token that expired 60 seconds ago and accepts one that expired 59 seconds ago', async () => {
		// The edge FR-11 states as "`exp` is later than now minus the skew": strict, so
		// exactly 60 seconds past is already out.
		const justOutside = await exchangeClaims(
			validClaims({ exp: BASE_TIME_SECONDS - FR11_SKEW_SECONDS, iat: BASE_TIME_SECONDS - 300 })
		);
		await expectRefusal(exchange(justOutside.plugin), 'expired');

		const justInside = await exchangeClaims(
			validClaims({ exp: BASE_TIME_SECONDS - 59, iat: BASE_TIME_SECONDS - 300 })
		);
		await expect(exchange(justInside.plugin)).resolves.toMatchObject({ subject: 'subject-1' });
	});

	it('refuses a token that expired 61 seconds ago', async () => {
		const { plugin } = await exchangeClaims(
			validClaims({ exp: BASE_TIME_SECONDS - 61, iat: BASE_TIME_SECONDS - 300 })
		);
		await expectRefusal(exchange(plugin), 'expired');
	});

	it('refuses a token with no `exp` — a window that cannot be read is not a pass', async () => {
		const claims = validClaims();
		delete claims.exp;
		const { plugin } = await exchangeClaims(claims);
		await expectRefusal(exchange(plugin), 'expired');
	});

	it('accepts an `iat` of exactly 600 seconds ago and refuses one 601 seconds ago', async () => {
		const atTheEdge = await exchangeClaims(validClaims({ iat: BASE_TIME_SECONDS - FR11_ID_TOKEN_MAX_AGE_SECONDS }));
		await expect(exchange(atTheEdge.plugin)).resolves.toMatchObject({ subject: 'subject-1' });

		const past = await exchangeClaims(validClaims({ iat: BASE_TIME_SECONDS - FR11_ID_TOKEN_MAX_AGE_SECONDS - 1 }));
		await expectRefusal(exchange(past.plugin), 'tooOld');
	});

	it('accepts an `iat` 60 seconds in the future and refuses one 61 seconds in the future', async () => {
		const inside = await exchangeClaims(validClaims({ iat: BASE_TIME_SECONDS + FR11_SKEW_SECONDS }));
		await expect(exchange(inside.plugin)).resolves.toMatchObject({ subject: 'subject-1' });

		const ahead = await exchangeClaims(validClaims({ iat: BASE_TIME_SECONDS + FR11_SKEW_SECONDS + 1 }));
		await expectRefusal(exchange(ahead.plugin), 'notYetValid');
	});

	it('refuses a token with no `iat`', async () => {
		const claims = validClaims();
		delete claims.iat;
		const { plugin } = await exchangeClaims(claims);
		await expectRefusal(exchange(plugin), 'tooOld');
	});

	it('honours a configured skew of 0: no grace at all', async () => {
		const values = settings({ clockSkewSeconds: 0 });

		// FR-11's rule is "`exp` is later than now minus the skew", so with no skew a
		// token that expires exactly now is already out, and one second of life is in.
		const oneSecondLeft = await exchangeClaims(validClaims({ exp: BASE_TIME_SECONDS + 1 }), { settings: values });
		await expect(exchange(oneSecondLeft.plugin)).resolves.toMatchObject({ subject: 'subject-1' });

		const expiringNow = await exchangeClaims(validClaims({ exp: BASE_TIME_SECONDS }), { settings: values });
		await expectRefusal(exchange(expiringNow.plugin), 'expired');

		const oneSecondLate = await exchangeClaims(validClaims({ exp: BASE_TIME_SECONDS - 1 }), { settings: values });
		await expectRefusal(exchange(oneSecondLate.plugin), 'expired');

		// And the future edge closes with it: `iat = now` is inside, `iat = now + 1` is not.
		const now = await exchangeClaims(validClaims({ iat: BASE_TIME_SECONDS }), { settings: values });
		await expect(exchange(now.plugin)).resolves.toMatchObject({ subject: 'subject-1' });

		const oneSecondAhead = await exchangeClaims(validClaims({ iat: BASE_TIME_SECONDS + 1 }), { settings: values });
		await expectRefusal(exchange(oneSecondAhead.plugin), 'notYetValid');
	});

	it('honours a configured skew of 120: the widest tolerance FR-2 allows', async () => {
		const values = settings({ clockSkewSeconds: 120 });

		const inside = await exchangeClaims(
			validClaims({ exp: BASE_TIME_SECONDS - 119, iat: BASE_TIME_SECONDS + 120 }),
			{ settings: values }
		);
		await expect(exchange(inside.plugin)).resolves.toMatchObject({ subject: 'subject-1' });

		const outside = await exchangeClaims(validClaims({ exp: BASE_TIME_SECONDS - 121, iat: BASE_TIME_SECONDS }), {
			settings: values
		});
		await expectRefusal(exchange(outside.plugin), 'expired');

		const ahead = await exchangeClaims(
			validClaims({ exp: BASE_TIME_SECONDS + 300, iat: BASE_TIME_SECONDS + 121 }),
			{ settings: values }
		);
		await expectRefusal(exchange(ahead.plugin), 'notYetValid');
	});

	it('does not move the 600-second freshness bound when the skew is widened', async () => {
		// The past edge of `iat` is FR-11's fixed rule, not a tolerance: a 120-second
		// skew must not make a 601-second-old token acceptable.
		const { plugin } = await exchangeClaims(
			validClaims({ iat: BASE_TIME_SECONDS - FR11_ID_TOKEN_MAX_AGE_SECONDS - 1 }),
			{ settings: settings({ clockSkewSeconds: 120 }) }
		);
		await expectRefusal(exchange(plugin), 'tooOld');
	});

	it('applies the injected clock, not the wall clock', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		// A token that expires 300 seconds after the injected clock, signed while the
		// wall clock is years away: accepted only if the injected clock is the one in use.
		provider.idToken = await signIdToken(validClaims({ exp: BASE_TIME_SECONDS + 300 }), key);
		const { plugin } = await pluginFor(provider);

		at(299);
		await expect(exchange(plugin)).resolves.toMatchObject({ subject: 'subject-1' });

		// 302 seconds later the same token is outside the injected clock's window, and
		// the key cache is still warm (600 s), so the refusal is the time rule's.
		at(361);
		await expectRefusal(exchange(plugin), 'expired');
	});
});

describe('FR-11 — the algorithm (ACC-12-07)', () => {
	it('refuses alg=none before any key lookup', async () => {
		const { plugin, provider } = await exchangeClaims(validClaims());
		// An unsigned token: the header says `none` and there is no signature at all.
		provider.idToken = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-a' })).toString('base64url')}.${Buffer.from(
			JSON.stringify(validClaims())
		).toString('base64url')}.`;

		await expectRefusal(exchange(plugin), 'badAlg');

		// The refusal is lexical: not one key was fetched, so a token cannot talk this
		// installation into treating a published public key as a shared secret.
		expect(callsTo(provider, JWKS_URI)).toEqual([]);
	});

	it('refuses a symmetric algorithm (HS256) before any key lookup', async () => {
		const { plugin, provider } = await exchangeClaims(validClaims());
		provider.idToken = await new SignJWT(validClaims())
			.setProtectedHeader({ alg: 'HS256', kid: 'key-a' })
			.sign(new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes'));

		await expectRefusal(exchange(plugin), 'badAlg');
		expect(callsTo(provider, JWKS_URI)).toEqual([]);
	});

	it('refuses a token signed by a key the provider never published', async () => {
		const published = await makeKey('key-a');
		const impostor = await makeKey('key-a');
		const { plugin } = await exchangeClaims(validClaims(), { key: impostor, published: [published.jwk] });

		await expectRefusal(exchange(plugin), 'badSignature');
	});

	it('refuses a token whose payload was changed after signing', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		const signed = await signIdToken(validClaims(), key);
		const [header, , signature] = signed.split('.');
		provider.idToken = `${header as string}.${Buffer.from(
			JSON.stringify(validClaims({ sub: 'someone-else' }))
		).toString('base64url')}.${signature as string}`;
		const { plugin } = await pluginFor(provider);

		await expectRefusal(exchange(plugin), 'badSignature');
	});
});

describe('FR-11 — the nonce', () => {
	it('refuses a token whose `nonce` is not the one the transaction sealed', async () => {
		const { plugin } = await exchangeClaims(validClaims({ nonce: 'some-other-nonce' }));
		await expectRefusal(exchange(plugin), 'badNonce');
	});

	it('refuses a token with no `nonce`', async () => {
		const claims = validClaims();
		delete claims.nonce;
		const { plugin } = await exchangeClaims(claims);
		await expectRefusal(exchange(plugin), 'badNonce');
	});

	it('refuses a token whose `nonce` differs only in case', async () => {
		const { plugin } = await exchangeClaims(validClaims({ nonce: NONCE.toUpperCase() }));
		await expectRefusal(exchange(plugin), 'badNonce');
	});
});

describe('FR-11 — the subject (1–255 characters)', () => {
	it('accepts a subject of exactly 255 characters and refuses 256', async () => {
		const longest = 'a'.repeat(FR11_SUBJECT_MAX_LENGTH);
		const accepted = await exchangeClaims(validClaims({ sub: longest }));
		await expect(exchange(accepted.plugin)).resolves.toMatchObject({ subject: longest });

		const tooLong = await exchangeClaims(validClaims({ sub: 'a'.repeat(FR11_SUBJECT_MAX_LENGTH + 1) }));
		await expectRefusal(exchange(tooLong.plugin), 'badSignature');
	});

	it('refuses an empty subject, a missing subject and a non-string subject', async () => {
		const empty = await exchangeClaims(validClaims({ sub: '' }));
		await expectRefusal(exchange(empty.plugin), 'badSignature');

		const claims = validClaims();
		delete claims.sub;
		const missing = await exchangeClaims(claims);
		await expectRefusal(exchange(missing.plugin), 'badSignature');

		const numeric = await exchangeClaims(validClaims({ sub: 12345 }));
		await expectRefusal(exchange(numeric.plugin), 'badSignature');
	});
});

describe('FR-25 — maxAuthAgeSeconds, the one caller-supplied bound', () => {
	it('accepts an authentication exactly 300 seconds old plus the skew, and refuses one second older', async () => {
		const atTheEdge = await exchangeClaims(
			validClaims({ auth_time: BASE_TIME_SECONDS - FR25_CONNECT_MAX_AUTH_AGE_SECONDS - FR11_SKEW_SECONDS })
		);
		await expect(
			exchange(atTheEdge.plugin, { maxAuthAgeSeconds: FR25_CONNECT_MAX_AUTH_AGE_SECONDS })
		).resolves.toMatchObject({
			authTime: BASE_TIME_SECONDS - FR25_CONNECT_MAX_AUTH_AGE_SECONDS - FR11_SKEW_SECONDS
		});

		const older = await exchangeClaims(
			validClaims({ auth_time: BASE_TIME_SECONDS - FR25_CONNECT_MAX_AUTH_AGE_SECONDS - FR11_SKEW_SECONDS - 1 })
		);
		await expectRefusal(exchange(older.plugin, { maxAuthAgeSeconds: FR25_CONNECT_MAX_AUTH_AGE_SECONDS }), 'tooOld');
	});

	it('refuses a token with no `auth_time` when the caller asked for a fresh authentication', async () => {
		const claims = validClaims();
		delete claims.auth_time;
		const { plugin } = await exchangeClaims(claims);

		// No bound: a plain sign-in does not need `auth_time` (and gets `null`).
		await expect(exchange(plugin)).resolves.toMatchObject({ authTime: null });

		// With the bound, the same token is refused: a connect flow that cannot show
		// the authentication was recent must re-authenticate.
		await expectRefusal(exchange(plugin, { maxAuthAgeSeconds: FR25_CONNECT_MAX_AUTH_AGE_SECONDS }), 'tooOld');
	});

	it('does not apply the bound to a token whose `auth_time` is old when the caller asked for none', async () => {
		const { plugin } = await exchangeClaims(
			validClaims({ auth_time: BASE_TIME_SECONDS - 86_400, iat: BASE_TIME_SECONDS })
		);
		await expect(exchange(plugin)).resolves.toMatchObject({ authTime: BASE_TIME_SECONDS - 86_400 });
	});
});

describe('the provider, not the token (FR-13, FR-15, plan §5.2)', () => {
	it('answers providerUnavailable when the token endpoint refuses the grant', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		provider.mode = 'http500';
		const { plugin } = await pluginFor(provider);

		await expectRefusal(exchange(plugin), 'providerUnavailable');
	});

	it('answers providerUnavailable when the token endpoint cannot be reached', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		provider.mode = 'reject';
		const { plugin } = await pluginFor(provider);

		await expectRefusal(exchange(plugin), 'providerUnavailable');
	});

	it('answers providerUnavailable at FR-15s 5,000 ms bound when the token endpoint never answers', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		provider.idToken = await signIdToken(validClaims(), key);
		provider.mode = 'hang';
		const { plugin } = await pluginFor(provider);

		// This is the one case that needs the timer to fire: the POST's bound is a
		// `setTimeout` inside `discovery.ts` precisely so a fake clock can drive it.
		// The expectation is attached **before** the clock moves, so the refusal is
		// never an unhandled rejection while the timers run.
		vi.useFakeTimers();
		const refused = expect(exchange(plugin)).rejects.toMatchObject({ code: 'providerUnavailable' });
		await vi.advanceTimersByTimeAsync(FR15_TIMEOUT_MS);
		await refused;
	});

	it('answers providerUnavailable when the token endpoint answers 200 without an id_token', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		provider.mode = 'noIdToken';
		const { plugin } = await pluginFor(provider);

		await expectRefusal(exchange(plugin), 'providerUnavailable');
	});

	it('answers providerUnavailable when the key set cannot be read (FR-13)', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		provider.idToken = await signIdToken(validClaims(), key);
		// The discovery document still answers; only the key set is gone.
		const original = provider.fetch;
		provider.fetch = async (url, init) => {
			if (url === JWKS_URI) {
				provider.calls.push({ url, method: init.method, body: init.body, headers: init.headers });
				throw new Error('connect ECONNREFUSED (transport)');
			}
			return original(url, init);
		};
		const failing = new OidcIdentityPlugin({ fetchImpl: provider.fetch, now: () => clockMs });
		await failing.onLoad(contextFor(settings()));

		// FR-15 gives the key set one retry after 1,000 ms, so the refusal only lands
		// once that timer fires — advanced here rather than waited out.
		vi.useFakeTimers();
		const refused = expect(exchange(failing)).rejects.toMatchObject({ code: 'providerUnavailable' });
		await vi.advanceTimersByTimeAsync(1_100);
		await refused;
		expect(callsTo(provider, JWKS_URI)).toHaveLength(2);
	});

	it('validates a token signed by a rotated key after exactly one key refresh (FR-13, ACC-12-08)', async () => {
		const keyA = await makeKey('key-a');
		const keyB = await makeKey('key-b');
		const provider = fakeProvider();
		provider.keys = [keyA.jwk];
		provider.idToken = await signIdToken(validClaims(), keyA);
		const { plugin } = await pluginFor(provider);

		await expect(exchange(plugin)).resolves.toMatchObject({ subject: 'subject-1' });
		expect(callsTo(provider, JWKS_URI)).toHaveLength(1);

		// The provider rotates: `key-b` is published on the next fetch, and the token
		// the next callback carries is signed with it.
		provider.keys = [keyA.jwk, keyB.jwk];
		provider.idToken = await signIdToken(validClaims(), keyB);
		at(1);
		await expect(exchange(plugin)).resolves.toMatchObject({ subject: 'subject-1' });
		expect(callsTo(provider, JWKS_URI)).toHaveLength(2);

		// The refreshed set is cached: a third exchange fetches nothing.
		at(2);
		await expect(exchange(plugin)).resolves.toMatchObject({ subject: 'subject-1' });
		expect(callsTo(provider, JWKS_URI)).toHaveLength(2);
	});

	it('answers providerUnavailable when the discovery document cannot be read', async () => {
		const provider = fakeProvider();
		const failing: FakeProvider = {
			...provider,
			fetch: async () => {
				throw new Error('connect ECONNREFUSED (transport)');
			}
		};
		const { plugin } = await pluginFor(failing);

		// The discovery read retries once after 1,000 ms (FR-15), so the refusal lands
		// on the retry's timer rather than immediately.
		vi.useFakeTimers();
		const refused = expect(exchange(plugin)).rejects.toMatchObject({ code: 'providerUnavailable' });
		await vi.advanceTimersByTimeAsync(1_100);
		await refused;
	});

	it('answers providerUnavailable when the document names a different issuer (FR-14)', async () => {
		const provider = fakeProvider();
		provider.document = healthyDocument({ issuer: 'https://auth.example.net' });
		const { plugin } = await pluginFor(provider);

		await expectRefusal(exchange(plugin), 'providerUnavailable');
	});

	it('answers providerUnavailable when the document advertises no token endpoint or no key set (FR-3)', async () => {
		for (const missing of ['token_endpoint', 'jwks_uri']) {
			const provider = fakeProvider();
			provider.document = healthyDocument({ [missing]: undefined });
			const { plugin } = await pluginFor(provider);

			await expectRefusal(exchange(plugin), 'providerUnavailable');
			expect(
				provider.calls.filter((call) => call.url === TOKEN_ENDPOINT),
				missing
			).toEqual([]);
		}
	});

	it('answers providerUnavailable for an unconfigured integration', async () => {
		const provider = fakeProvider();
		const { plugin } = await pluginFor(provider, { issuerUrl: ISSUER, clientId: CLIENT_ID });

		await expectRefusal(exchange(plugin), 'providerUnavailable');
		expect(provider.calls).toEqual([]);
	});
});

describe('FR-16 — no token material reaches an error message or a log line', () => {
	it('answers a refusal whose message is the code and nothing else', async () => {
		const { plugin, logger } = await exchangeClaims(validClaims({ nonce: 'not-the-nonce' }));

		let captured: { message?: string; code?: string } = {};
		try {
			await exchange(plugin);
		} catch (error) {
			const failure = error as Error & { code?: string };
			captured = { message: failure.message, code: failure.code };
		}

		// `message` is the code and nothing else, which is FR-16's cheapest promise to
		// keep: there is no other string to leak. (`name` is **not** asserted: the
		// contract's `IdentityTokenRejectedError` does not set it, so it reads `Error` —
		// reported as a finding, since `code` is the discriminator callers use.)
		expect(captured).toEqual({ message: 'badNonce', code: 'badNonce' });

		// Nothing that was sent or received appears in the log lines either: the code,
		// the verifier, the nonce, the token and the client secret are each checked by
		// boolean first, so a failure cannot paste the value into this spec's output.
		const log = logger.lines.join('\n');
		const leaks = {
			code: log.includes(CODE),
			verifier: log.includes(CODE_VERIFIER),
			nonce: log.includes(NONCE),
			secret: log.includes(SECRET),
			token: log.includes('eyJ')
		};
		expect(leaks).toEqual({ code: false, verifier: false, nonce: false, secret: false, token: false });
	});

	it('keeps the secret and the code out of every provider-unavailable path', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		provider.mode = 'http500';
		const { plugin, logger } = await pluginFor(provider);

		let captured: { message?: string; code?: string } = {};
		try {
			await exchange(plugin);
		} catch (error) {
			const failure = error as Error & { code?: string };
			captured = { message: failure.message, code: failure.code };
		}

		const serialised = JSON.stringify({ captured, logger: logger.lines });
		const leaks = { code: serialised.includes(CODE), secret: serialised.includes(SECRET) };
		expect(leaks).toEqual({ code: false, secret: false });
		expect(captured).toEqual({ message: 'providerUnavailable', code: 'providerUnavailable' });
	});
});

describe('the transcribed FR-11 numbers still match EVER_ID_LIMITS and the schema', () => {
	const contractsSource = readFileSync(
		new URL('../../../../contracts/src/apps/ever-id.ts', import.meta.url),
		'utf-8'
	);

	const limitValue = (key: string): number => {
		const match = new RegExp(`\\b${key}:\\s*([0-9_]+)`, 'u').exec(contractsSource);
		expect(match, `${key} not found in EVER_ID_LIMITS`).not.toBeNull();
		return Number((match as RegExpExecArray)[1].replaceAll('_', ''));
	};

	it('mirrors the skew default and the 600-second freshness bound of FR-11', () => {
		expect(OIDC_DEFAULT_CLOCK_SKEW_SECONDS).toBe(limitValue('defaultClockSkewSeconds'));
		expect(OIDC_ID_TOKEN_MAX_AGE_SECONDS).toBe(limitValue('idTokenMaxAgeSeconds'));
		// FR-2's and FR-11's prose, pinned literally so a change has to change this line.
		expect([OIDC_DEFAULT_CLOCK_SKEW_SECONDS, OIDC_ID_TOKEN_MAX_AGE_SECONDS]).toEqual([60, 600]);
	});

	it('keeps the schema default the plugin falls back to and the schema maximum apart', () => {
		const properties = oidcIdentitySettingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(properties.clockSkewSeconds.default).toBe(OIDC_DEFAULT_CLOCK_SKEW_SECONDS);
		expect(properties.clockSkewSeconds.maximum).toBe(limitValue('maxClockSkewSeconds'));
		// The plugin applies `clockSkewSeconds ?? OIDC_DEFAULT_CLOCK_SKEW_SECONDS`; a
		// schema default that disagreed with that fallback would mean two answers to the
		// same question depending on whether the stored settings carried the key.
		expect(properties.clockSkewSeconds.default).toBe(60);
	});

	it('mirrors FR-11s subject bound', () => {
		expect(OIDC_SUBJECT_MAX_LENGTH).toBe(FR11_SUBJECT_MAX_LENGTH);
		expect(OIDC_SUBJECT_MAX_LENGTH).toBe(255);
	});
});
