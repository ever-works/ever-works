import { readFileSync } from 'node:fs';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JWK } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isIdentityProviderPlugin } from '@ever-works/plugin';
import type { PluginContext } from '@ever-works/plugin';

import { type OidcFetchImpl, type OidcHttpResponse } from '../discovery.js';
import {
	OIDC_ACCESS_TOKEN_MAX_AGE_SECONDS,
	OIDC_ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
	OIDC_DEFAULT_API_AUDIENCE,
	OIDC_DEFAULT_CLOCK_SKEW_SECONDS,
	OidcIdentityPlugin
} from '../oidc-identity.plugin.js';
import { OIDC_DELEGATED_READ_SCOPE, OIDC_SESSION_EXCHANGE_SCOPE } from '../scopes.js';

/**
 * APW-12 T8 — `verifyAccessToken` against FR-40, FR-45 and the two acceptance
 * criteria that name it:
 *
 * > **ACC-12-29** The exchange refuses a token from an unlisted client, without
 * > the exchange scope, older than 300 seconds, or with a reused `jti`.
 *
 * > **ACC-12-35** A token with lifetime over 3,600 seconds or a wrong audience is
 * > refused.
 *
 * Every clause of both sentences has a case below. So does every other rule plan
 * §4.3 states for the two access-token rows — the audience row, the scope row, the
 * issuer rule FR-45 adopts from FR-11 — plus the edges the criteria do not name:
 * a lifetime of exactly 3,600 s (accepted) against 3,601 (refused), an `iat` of
 * exactly 300 s (accepted) against 301 (refused), a future `iat`, an unreadable and
 * an absent `exp`, and the two structural refusals (`badAlg`, `badSignature`) that
 * come from T6's key cache.
 *
 * ## What this file does not prove
 *
 * The `jti` half of ACC-12-29 is **not** here, and deliberately: the 600-second
 * replay window needs a store with a unique index, so it is T13's
 * `ever-id-replay.service.ts` and the API's endpoint (T20/T25). What this file
 * pins is the plugin's half — the `jti` is answered verbatim, or `null` when the
 * provider sent none, and is **never** a refusal. Nor is FR-40's last clause ("its
 * pair is connected", 403 `notConnected` — a database question) or FR-46's
 * endpoint marking: those are the API's.
 *
 * ## The clock, and the numbers
 *
 * `BASE_TIME_MS` is injected and moved per case; nothing sleeps and nothing reads
 * `Date.now`. The numbers in the behavioural cases are **literals** — `300`, `301`,
 * `3_600`, `3_601`, `60` — never the module's own constants: a case that advanced
 * the clock by the constant it asserts would follow a mutant instead of catching
 * it, which is the self-referential trap both T6 and T7 recorded. The exported
 * constants are cross-checked separately, at the end of this file, against those
 * literals **and** against `EVER_ID_LIMITS` read off disk.
 *
 * ## Real signatures
 *
 * Tokens are signed by `jose` with freshly generated ES256 key pairs and verified
 * through the plugin's real key cache and a real `compactVerify`. Nothing stubs
 * the signature layer: FR-45's first clause is about signature verification, and
 * `badSignature`/`badAlg` are only meaningful if a real verification produced them.
 */

const ISSUER = 'https://auth.ever.co';
const AUTHORIZATION_ENDPOINT = `${ISSUER}/oauth/v2/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/v2/token`;
const JWKS_URI = `${ISSUER}/oauth/v2/keys`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = 'ever-works-web';
const SECRET = 'ever-id-client-secret-0123456789abcdef-do-not-print';
const API_AUDIENCE = 'ever-works';
const LOCAL_CLIENT = 'ever-works-cli';
const UNLISTED_CLIENT = 'some-other-app';
const DELEGATED_SCOPE = 'apps:read';
const EXCHANGE_SCOPE = 'ever-works:session';

/** FR-40's, FR-45's and FR-2's numbers, written as literals (see the header). */
const FR45_MAX_LIFETIME_SECONDS = 3_600;
const FR40_MAX_AGE_SECONDS = 300;
const FR33_REPLAY_WINDOW_SECONDS = 600;
const FR2_SKEW_SECONDS = 60;
const FR13_MAX_STALE_SECONDS = 21_600;

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
const healthyDocument = (issuer = ISSUER, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	issuer,
	authorization_endpoint: `${issuer}/oauth/v2/authorize`,
	token_endpoint: `${issuer}/oauth/v2/token`,
	jwks_uri: `${issuer}/oauth/v2/keys`,
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
 * The claims a valid access token carries, in one place, so each case reads as
 * "everything is valid, except this".
 *
 * The defaults describe FR-45's delegated read (the API audience and `apps:read`)
 * with the local-client `azp` already present, so the FR-40 cases are the ones
 * that pass `requiredScopes`/`allowedAuthorizedParties` explicitly.
 */
const validClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	iss: ISSUER,
	sub: 'subject-1',
	aud: API_AUDIENCE,
	scope: DELEGATED_SCOPE,
	azp: LOCAL_CLIENT,
	iat: BASE_TIME_SECONDS,
	exp: BASE_TIME_SECONDS + 300,
	jti: 'replay-key-1',
	...overrides
});

/** Sign a claim set with a real private key, the way the provider signs it. */
const signAccessToken = (claims: Record<string, unknown>, key: TestKey, alg = 'ES256'): Promise<string> =>
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
 * A provider with a key set and a discovery document.
 *
 * `mode` is the whole vocabulary the verification path has to survive at this
 * boundary — a normal answer, an error status and a transport error — and
 * `jwksFails` isolates the key-set read from the document read, which is the only
 * way to tell "the document is fine, the keys are not" from "nothing answered".
 * Every call is recorded, so the cases that care about *which* endpoints were read
 * can assert on what actually went out.
 */
interface FakeProvider {
	readonly calls: FakeCall[];
	readonly fetch: OidcFetchImpl;
	readonly issuer: string;
	document: Record<string, unknown>;
	keys: JWK[];
	mode: 'ok' | 'http500' | 'reject';
	jwksFails: boolean;
}

const jsonAnswer = (body: unknown): OidcHttpResponse => ({ ok: true, status: 200, json: async () => body });

const fakeProvider = (issuer = ISSUER): FakeProvider => {
	const provider: FakeProvider = {
		calls: [],
		issuer,
		document: healthyDocument(issuer),
		keys: [],
		mode: 'ok',
		jwksFails: false,
		fetch: async (url, init): Promise<OidcHttpResponse> => {
			provider.calls.push({ url, method: init.method, body: init.body, headers: init.headers });
			if (provider.mode === 'reject') throw new Error('connect ECONNREFUSED (transport)');
			if (provider.mode === 'http500') return { ok: false, status: 500, json: async () => ({}) };
			if (provider.jwksFails && url === `${issuer}/oauth/v2/keys`) {
				return { ok: false, status: 500, json: async () => ({}) };
			}
			if (url === `${issuer}/.well-known/openid-configuration`) return jsonAnswer(provider.document);
			if (url === `${issuer}/oauth/v2/keys`) return jsonAnswer({ keys: provider.keys });
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

/** The input FR-40's exchange and FR-45's delegated read hand the verifier. */
interface VerifyInput {
	readonly requiredScopes?: string[];
	readonly maxLifetimeSeconds?: number;
	readonly maxAgeSeconds?: number;
	readonly allowedAuthorizedParties?: string[];
}

/** What FR-45's delegated read asks for: the API audience and `apps:read`, no age rule, no `azp` list. */
const delegatedRead = (overrides: VerifyInput = {}): VerifyInput => ({
	requiredScopes: [DELEGATED_SCOPE],
	maxLifetimeSeconds: FR45_MAX_LIFETIME_SECONDS,
	...overrides
});

/** What FR-40's exchange asks for: the exchange scope, a 300-second age and the local-client list. */
const exchange = (overrides: VerifyInput = {}): VerifyInput => ({
	requiredScopes: [EXCHANGE_SCOPE],
	maxLifetimeSeconds: FR45_MAX_LIFETIME_SECONDS,
	maxAgeSeconds: FR40_MAX_AGE_SECONDS,
	allowedAuthorizedParties: [LOCAL_CLIENT],
	...overrides
});

const verify = (plugin: OidcIdentityPlugin, token: string, input: VerifyInput): Promise<unknown> =>
	plugin.verifyAccessToken(token, {
		requiredScopes: input.requiredScopes ?? [],
		maxLifetimeSeconds: input.maxLifetimeSeconds ?? FR45_MAX_LIFETIME_SECONDS,
		...(input.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: input.maxAgeSeconds }),
		...(input.allowedAuthorizedParties === undefined
			? {}
			: { allowedAuthorizedParties: input.allowedAuthorizedParties })
	});

/** Sign `claims` with `key`, publish `key`, and answer them from the provider. */
const tokenCase = async (
	claims: Record<string, unknown>,
	options: {
		key?: TestKey;
		published?: JWK[];
		settings?: Record<string, unknown>;
		input?: VerifyInput;
		provider?: FakeProvider;
	} = {}
): Promise<{
	plugin: OidcIdentityPlugin;
	provider: FakeProvider;
	logger: CapturedLogger;
	token: string;
	run: () => Promise<unknown>;
}> => {
	const key = options.key ?? (await makeKey('key-a'));
	const provider = options.provider ?? fakeProvider();
	provider.keys = options.published ?? [key.jwk];
	const token = await signAccessToken(claims, key);
	const { plugin, logger } = await pluginFor(provider, options.settings ?? settings());
	return {
		plugin,
		provider,
		logger,
		token,
		run: () => verify(plugin, token, options.input ?? delegatedRead())
	};
};

/** The refusal every claim rule raises: one code, and nothing else in the message (FR-16). */
const expectRefusal = async (work: Promise<unknown>, code: string): Promise<void> => {
	await expect(work, code).rejects.toMatchObject({ code, message: code });
};

afterEach(() => {
	clockMs = BASE_TIME_MS;
	vi.useRealTimers();
});

describe('the accepted token (FR-45) — everything valid, and the claims both callers branch on', () => {
	it('answers the eight claims of VerifiedAccessTokenClaims', async () => {
		const { run } = await tokenCase(validClaims());

		await expect(run()).resolves.toEqual({
			issuer: ISSUER,
			subject: 'subject-1',
			audience: [API_AUDIENCE],
			scopes: [DELEGATED_SCOPE],
			authorizedParty: LOCAL_CLIENT,
			issuedAt: BASE_TIME_SECONDS,
			expiresAt: BASE_TIME_SECONDS + 300,
			jti: 'replay-key-1'
		});
	});

	it('accepts an `aud` array that contains the API audience, and answers it whole', async () => {
		const { run } = await tokenCase(validClaims({ aud: [API_AUDIENCE, 'another-api'] }));

		await expect(run()).resolves.toMatchObject({ audience: [API_AUDIENCE, 'another-api'] });
	});

	it('parses a multi-scope string, drops duplicates and keeps the order the provider sent', async () => {
		const { run } = await tokenCase(validClaims({ scope: 'apps:read profile apps:read' }));

		await expect(run()).resolves.toMatchObject({ scopes: ['apps:read', 'profile'] });
	});

	it('answers `jti: null` when the provider sent none, and never refuses for it', async () => {
		const claims = validClaims();
		delete claims.jti;
		const { run } = await tokenCase(claims);

		await expect(run()).resolves.toMatchObject({ jti: null });
	});

	it('answers `authorizedParty: null` when the provider sent no `azp`', async () => {
		const claims = validClaims();
		delete claims.azp;
		const { run } = await tokenCase(claims);

		await expect(run()).resolves.toMatchObject({ authorizedParty: null });
	});
});

describe('FR-45 — the delegated read: audience, scope, lifetime ceiling, expiry', () => {
	it('refuses a token whose `aud` is another API, with badAudience (ACC-12-35)', async () => {
		const { run } = await tokenCase(validClaims({ aud: 'another-api' }));

		await expectRefusal(run(), 'badAudience');
	});

	it('refuses a token whose `aud` array misses the API audience, with badAudience', async () => {
		const { run } = await tokenCase(validClaims({ aud: ['other-1', 'other-2'] }));

		await expectRefusal(run(), 'badAudience');
	});

	it('refuses a token with no readable `aud` at all, with badAudience', async () => {
		const { run } = await tokenCase(validClaims({ aud: 42 }));

		await expectRefusal(run(), 'badAudience');
	});

	it('accepts a lifetime of exactly 3,600 seconds and refuses 3,601, with lifetimeTooLong (ACC-12-35)', async () => {
		// `exp − iat` is the rule; the token is presented at `iat`, so this is the
		// whole window and not "the time left".
		const accepted = await tokenCase(validClaims({ iat: BASE_TIME_SECONDS, exp: BASE_TIME_SECONDS + 3_600 }));
		await expect(accepted.run()).resolves.toMatchObject({ issuedAt: BASE_TIME_SECONDS });

		const refused = await tokenCase(validClaims({ iat: BASE_TIME_SECONDS, exp: BASE_TIME_SECONDS + 3_601 }));
		await expectRefusal(refused.run(), 'lifetimeTooLong');
	});

	it('refuses a long lifetime even when the token was minted long ago and is still unexpired', async () => {
		// Presented 3,000 s after it was minted: `exp` is still in the future, so a
		// check on the *remaining* life would pass this token. FR-45 bounds the
		// window, not what is left of it.
		at(3_000);
		const { run } = await tokenCase(
			validClaims({ iat: BASE_TIME_SECONDS, exp: BASE_TIME_SECONDS + 3_601, jti: 'replay-key-long' })
		);

		await expectRefusal(run(), 'lifetimeTooLong');
	});

	it('refuses a token with no scope for the endpoint, with missingScope', async () => {
		const { run } = await tokenCase(validClaims({ scope: 'profile email' }));

		await expectRefusal(run(), 'missingScope');
	});

	it('refuses a token with no readable scope claim, with missingScope', async () => {
		const { run } = await tokenCase(validClaims({ scope: ['apps:read'] }));

		await expectRefusal(run(), 'missingScope');
	});

	it('accepts an empty `requiredScopes`, because the caller asked for nothing', async () => {
		const { run } = await tokenCase(validClaims({ scope: undefined }), {
			input: delegatedRead({ requiredScopes: [] })
		});

		await expect(run()).resolves.toMatchObject({ scopes: [] });
	});

	it('refuses an `exp` at the skew and beyond it, and accepts one second inside it', async () => {
		// FR-11's clause is strict — "`exp` is later than now minus the skew" — so a
		// token that expired exactly 60 seconds ago is refused and one that expired 59
		// seconds ago is accepted. FR-45 adopts the clause by reference.
		const edge = await tokenCase(validClaims({ iat: BASE_TIME_SECONDS - 300, exp: BASE_TIME_SECONDS - 59 }));
		await expect(edge.run()).resolves.toMatchObject({ expiresAt: BASE_TIME_SECONDS - 59 });

		const atSkew = await tokenCase(
			validClaims({ iat: BASE_TIME_SECONDS - 300, exp: BASE_TIME_SECONDS - 60, jti: 'replay-key-skew' })
		);
		await expectRefusal(atSkew.run(), 'expired');

		const expired = await tokenCase(
			validClaims({ iat: BASE_TIME_SECONDS - 300, exp: BASE_TIME_SECONDS - 61, jti: 'replay-key-exp' })
		);
		await expectRefusal(expired.run(), 'expired');
	});

	it('refuses an access token with no readable `exp`, with expired', async () => {
		const claims = validClaims();
		delete claims.exp;
		const { run } = await tokenCase(claims);

		await expectRefusal(run(), 'expired');
	});

	it('refuses a future `iat` beyond the skew, with notYetValid', async () => {
		const { run } = await tokenCase(validClaims({ iat: BASE_TIME_SECONDS + 61, exp: BASE_TIME_SECONDS + 361 }));

		await expectRefusal(run(), 'notYetValid');
	});

	it('has no age rule on the delegated path: a token issued an hour ago and unexpired is accepted', async () => {
		// FR-45 states no age bound at all — its bound is the lifetime ceiling — so a
		// token minted 3,600 seconds ago with a 3,600-second window is still good. The
		// exchange path, which passes `maxAgeSeconds`, is the one that refuses it.
		const { run } = await tokenCase(
			validClaims({ iat: BASE_TIME_SECONDS - 3_600, exp: BASE_TIME_SECONDS, jti: 'replay-key-hour' })
		);
		await expect(run()).resolves.toMatchObject({ issuedAt: BASE_TIME_SECONDS - 3_600 });

		const exchangeView = await tokenCase(
			validClaims({
				scope: EXCHANGE_SCOPE,
				iat: BASE_TIME_SECONDS - 3_600,
				exp: BASE_TIME_SECONDS,
				jti: 'replay-key-hour-2'
			}),
			{ input: exchange() }
		);
		await expectRefusal(exchangeView.run(), 'tooOld');
	});
});

describe('FR-40 — the exchange: age, authorised party and the exchange scope', () => {
	it('accepts an exchange token from a listed local client', async () => {
		const { run } = await tokenCase(validClaims({ scope: EXCHANGE_SCOPE, azp: LOCAL_CLIENT }), {
			input: exchange()
		});

		await expect(run()).resolves.toMatchObject({ scopes: [EXCHANGE_SCOPE], authorizedParty: LOCAL_CLIENT });
	});

	it('refuses an `iat` of exactly 301 seconds with tooOld, and accepts 300 (ACC-12-29)', async () => {
		const edge = await tokenCase(
			validClaims({ scope: EXCHANGE_SCOPE, iat: BASE_TIME_SECONDS - 300, exp: BASE_TIME_SECONDS }),
			{
				input: exchange()
			}
		);
		await expect(edge.run()).resolves.toMatchObject({ issuedAt: BASE_TIME_SECONDS - 300 });

		const old = await tokenCase(
			validClaims({
				scope: EXCHANGE_SCOPE,
				iat: BASE_TIME_SECONDS - 301,
				exp: BASE_TIME_SECONDS,
				jti: 'replay-key-old'
			}),
			{ input: exchange() }
		);
		await expectRefusal(old.run(), 'tooOld');
	});

	it('honours the skew on the age bound: 300 + 60 is inside it, 361 is not', async () => {
		// FR-11's `iat` future edge is widened by the skew and its past edge is not —
		// but the *age* bound the exchange passes is a different rule from FR-11's
		// 600-second freshness window, and it is not widened either.
		const inside = await tokenCase(
			validClaims({ scope: EXCHANGE_SCOPE, iat: BASE_TIME_SECONDS - 300, exp: BASE_TIME_SECONDS }),
			{ input: exchange({ maxAgeSeconds: FR40_MAX_AGE_SECONDS }) }
		);
		await expect(inside.run()).resolves.toBeDefined();

		const outside = await tokenCase(
			validClaims({
				scope: EXCHANGE_SCOPE,
				iat: BASE_TIME_SECONDS - 361,
				exp: BASE_TIME_SECONDS,
				jti: 'replay-key-361'
			}),
			{ input: exchange({ maxAgeSeconds: FR40_MAX_AGE_SECONDS }) }
		);
		await expectRefusal(outside.run(), 'tooOld');
	});

	it('refuses a token minted for an unlisted client, with badAuthorizedParty (ACC-12-29)', async () => {
		const { run } = await tokenCase(validClaims({ scope: EXCHANGE_SCOPE, azp: UNLISTED_CLIENT }), {
			input: exchange()
		});

		await expectRefusal(run(), 'badAuthorizedParty');
	});

	it('refuses a token that names no authorised party at all, when the caller gave a list', async () => {
		const claims = validClaims({ scope: EXCHANGE_SCOPE });
		delete claims.azp;
		const { run } = await tokenCase(claims, { input: exchange() });

		await expectRefusal(run(), 'badAuthorizedParty');
	});

	it('refuses every token — including a well-formed one — when the allow-list is empty', async () => {
		// "The installation configured no local client" is the fail-closed reading:
		// there is nothing to compare `azp` against, so nothing may pass.
		const { run } = await tokenCase(validClaims({ scope: EXCHANGE_SCOPE }), {
			input: exchange({ allowedAuthorizedParties: [] })
		});

		await expectRefusal(run(), 'badAuthorizedParty');
	});

	it('does not read `azp` on the delegated path, where FR-45 states no such rule', async () => {
		const { run } = await tokenCase(validClaims({ azp: UNLISTED_CLIENT }), { input: delegatedRead() });

		await expect(run()).resolves.toMatchObject({ authorizedParty: UNLISTED_CLIENT });
	});

	it('refuses a delegated token that carries the exchange scope only', async () => {
		const { run } = await tokenCase(validClaims({ scope: EXCHANGE_SCOPE }), { input: delegatedRead() });

		await expectRefusal(run(), 'missingScope');
	});
});

describe('the rules FR-45 adopts from FR-11 and FR-13 — issuer, signature, algorithm', () => {
	it('refuses a token from another issuer, with badIssuer', async () => {
		const { run } = await tokenCase(validClaims({ iss: 'https://evil.example' }));

		await expectRefusal(run(), 'badIssuer');
	});

	it('accepts a token from a second configured issuer, and refuses one that is not listed', async () => {
		// FR-2's allow-list is what makes a planned provider move reversible: the
		// installation is configured for one issuer, the document advertises that one,
		// and a token carrying an **allow-listed** issuer is still accepted.
		const second = 'https://auth-2.ever.co';
		const secondProvider = fakeProvider(second);
		const key = await makeKey('key-a');
		secondProvider.keys = [key.jwk];
		const { plugin } = await pluginFor(
			secondProvider,
			settings({ issuerUrl: second, allowedIssuers: [ISSUER, second] })
		);
		const accepted = await signAccessToken(validClaims({ iss: second }), key);
		await expect(verify(plugin, accepted, delegatedRead())).resolves.toMatchObject({ issuer: second });

		// The same allow-list does not widen which issuer the *document* may name: a
		// token from ISSUER is refused, because the document this installation read
		// advertises the second issuer and FR-12's equality is exact.
		const fromFirst = await signAccessToken(validClaims({ iss: ISSUER }), key);
		await expectRefusal(verify(plugin, fromFirst, delegatedRead()), 'badIssuer');

		const unlisted = await signAccessToken(validClaims({ iss: 'https://auth-9.ever.co' }), key);
		await expectRefusal(verify(plugin, unlisted, delegatedRead()), 'badIssuer');
	});

	it('accepts a token signed by a key the provider publishes, and refuses one signed by another key', async () => {
		const published = await makeKey('key-a');
		const other = await makeKey('key-b');
		const cases = await tokenCase(validClaims(), { key: published, published: [published.jwk] });
		await expect(cases.run()).resolves.toBeDefined();

		const forged = await tokenCase(validClaims({ jti: 'replay-key-forged' }), {
			key: other,
			published: [published.jwk]
		});
		await expectRefusal(forged.run(), 'badSignature');
	});

	it('refuses `alg: none` and a symmetric algorithm before any key lookup, with badAlg', async () => {
		// Neither token can be produced by a signer, so both are assembled by hand:
		// the point is that the protected header alone is enough to refuse them, and
		// that nothing was looked up to reach that answer.
		const { plugin, provider } = await tokenCase(validClaims());
		const claims = Buffer.from(JSON.stringify(validClaims())).toString('base64url');
		const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-a' })).toString('base64url');
		await expectRefusal(verify(plugin, `${noneHeader}.${claims}.`, delegatedRead()), 'badAlg');

		const hmacHeader = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'key-a' })).toString('base64url');
		await expectRefusal(verify(plugin, `${hmacHeader}.${claims}.c2lnbmF0dXJl`, delegatedRead()), 'badAlg');
		// The document was read — the `jwks_uri` is how the flow learns where keys
		// live — and the key set was **not**: FR-11's "`none` and `HS*` rejected
		// before key lookup" is what this asserts.
		expect(provider.calls.map((call) => call.url)).toEqual([DISCOVERY_URL]);
	});

	it('refuses a value that is not a compact JWS at all, with badSignature', async () => {
		const { plugin } = await tokenCase(validClaims());

		await expectRefusal(verify(plugin, 'not-a-token', delegatedRead()), 'badSignature');
	});

	it('refuses a `sub` that is not 1–255 characters, with badSignature', async () => {
		const { run } = await tokenCase(validClaims({ sub: '' }));

		await expectRefusal(run(), 'badSignature');
	});

	it('never puts a token, a claim or the secret in the message (FR-16)', async () => {
		const { run, logger } = await tokenCase(validClaims({ scope: 'profile' }));

		await expect(run(), 'missingScope').rejects.toMatchObject({ message: 'missingScope' });
		// The refusal path logs nothing at all: it is the API's callback that records
		// the detail code server-side (plan §5.2), and none of it may carry material.
		expect(logger.lines.join('\n')).not.toContain('ever-id-client-secret');
		expect(logger.lines.join('\n')).not.toContain('apps:read');
	});
});

describe('the provider cannot be asked (FR-14, FR-15)', () => {
	it('answers providerUnavailable when the integration is not configured', async () => {
		const provider = fakeProvider();
		const plugin = new OidcIdentityPlugin({ fetchImpl: provider.fetch, now: () => clockMs });
		await plugin.onLoad(contextFor({ issuerUrl: ISSUER }));

		await expectRefusal(verify(plugin, 'any-token', delegatedRead()), 'providerUnavailable');
	});

	it('answers providerUnavailable when the discovery document cannot be read', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		provider.mode = 'reject';
		const token = await signAccessToken(validClaims(), key);
		const { plugin } = await pluginFor(provider);

		await expectRefusal(verify(plugin, token, delegatedRead()), 'providerUnavailable');
	});

	it('answers providerUnavailable when the document names no key set', async () => {
		const document = healthyDocument();
		delete document.jwks_uri;
		const provider = fakeProvider();
		provider.document = document;
		const { plugin } = await pluginFor(provider);

		await expectRefusal(verify(plugin, 'any-token', delegatedRead()), 'providerUnavailable');
	});

	it('answers providerUnavailable when the key set cannot be fetched', async () => {
		const key = await makeKey('key-a');
		const provider = fakeProvider();
		provider.keys = [key.jwk];
		const token = await signAccessToken(validClaims(), key);
		const { plugin } = await pluginFor(provider);
		// The document read is left healthy and only the key fetch fails, so this case
		// fails for the reason it names rather than because nothing answered.
		provider.jwksFails = true;

		await expectRefusal(verify(plugin, token, delegatedRead()), 'providerUnavailable');
		// One document read (FR-14's 3,600-second cache then serves it) and FR-15's
		// single retry of the key fetch, which is the two attempts the ladder allows.
		expect(provider.calls.map((call) => call.url)).toEqual([DISCOVERY_URL, JWKS_URI, JWKS_URI]);
	});

	it('reads the document and the key set from the configured issuer only (FR-14)', async () => {
		const { provider, run } = await tokenCase(validClaims());

		await expect(run()).resolves.toBeDefined();
		expect(provider.calls.map((call) => call.url)).toEqual([DISCOVERY_URL, JWKS_URI]);
	});
});

describe('the numbers, transcribed — a cross-check, never the source of a case above', () => {
	const contracts = readFileSync(new URL('../../../../contracts/src/apps/ever-id.ts', import.meta.url), 'utf8');

	const limitValue = (key: string): number => {
		const match = new RegExp(`${key}:\\s*([0-9_]+)`).exec(contracts);
		if (match === null) throw new Error(`EVER_ID_LIMITS.${key} not found in the contracts source`);
		return Number(match[1].replace(/_/gu, ''));
	};

	const scopeValue = (key: string): string => {
		const match = new RegExp(`${key}:\\s*'([^']+)'`).exec(contracts);
		if (match === null) throw new Error(`EVER_ID_SCOPES.${key} not found in the contracts source`);
		return match[1];
	};

	it('holds FR-45’s lifetime ceiling and FR-40’s age bound as the contracts file states them', () => {
		expect(OIDC_ACCESS_TOKEN_MAX_LIFETIME_SECONDS).toBe(FR45_MAX_LIFETIME_SECONDS);
		expect(OIDC_ACCESS_TOKEN_MAX_LIFETIME_SECONDS).toBe(limitValue('delegatedTokenMaxLifetimeSeconds'));
		expect(OIDC_ACCESS_TOKEN_MAX_AGE_SECONDS).toBe(FR40_MAX_AGE_SECONDS);
		expect(OIDC_ACCESS_TOKEN_MAX_AGE_SECONDS).toBe(limitValue('exchangeTokenMaxAgeSeconds'));
		expect(FR33_REPLAY_WINDOW_SECONDS).toBe(limitValue('replayWindowSeconds'));
		expect(FR13_MAX_STALE_SECONDS).toBe(limitValue('jwksMaxStaleSeconds'));
		expect(FR2_SKEW_SECONDS).toBe(limitValue('defaultClockSkewSeconds'));
		expect(OIDC_DEFAULT_CLOCK_SKEW_SECONDS).toBe(FR2_SKEW_SECONDS);
	});

	it('holds FR-2’s default API audience and FR-44/FR-40’s scope strings', () => {
		expect(OIDC_DEFAULT_API_AUDIENCE).toBe(API_AUDIENCE);
		expect(OIDC_DELEGATED_READ_SCOPE).toBe(DELEGATED_SCOPE);
		expect(OIDC_DELEGATED_READ_SCOPE).toBe(scopeValue('APPS_READ'));
		expect(OIDC_SESSION_EXCHANGE_SCOPE).toBe(EXCHANGE_SCOPE);
		expect(OIDC_SESSION_EXCHANGE_SCOPE).toBe(scopeValue('SESSION_EXCHANGE'));
	});

	it('is what the platform’s own capability guard answers `true` for, now that every method exists', async () => {
		const { plugin, provider } = await tokenCase(validClaims());

		expect(isIdentityProviderPlugin(plugin)).toBe(true);
		// The guard checks the manifest's capability **and** the seven methods; a plugin
		// missing any one of them is not an identity provider (T4's contract), which is
		// what kept this plugin inert until T8. The negative control inherits the
		// prototype, so only the one method is missing.
		const withoutVerifier = Object.create(plugin) as { verifyAccessToken?: unknown };
		withoutVerifier.verifyAccessToken = undefined;
		expect(isIdentityProviderPlugin(withoutVerifier as never)).toBe(false);
		expect(isIdentityProviderPlugin(provider as never)).toBe(false);
	});
});
