import { readFileSync } from 'node:fs';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JWK } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginContext } from '@ever-works/plugin';

import { type OidcFetchImpl, type OidcHttpResponse } from '../discovery.js';
import {
	OIDC_BACKCHANNEL_LOGOUT_EVENT,
	OIDC_LOGOUT_TOKEN_MAX_AGE_SECONDS,
	OIDC_LOGOUT_TOKEN_REPLAY_WINDOW_SECONDS,
	OidcIdentityPlugin
} from '../oidc-identity.plugin.js';

/**
 * APW-12 T8 — `verifyLogoutToken` against FR-33 and **ACC-12-24**:
 *
 * > A notice with a reused `jti`, a `nonce`, or an `iat` older than 300 seconds
 * > answers 400.
 *
 * The `nonce` and the `iat` halves are proven here; the **reused `jti` half is
 * not**, and the file says so rather than implying otherwise. FR-33's replay window
 * needs a store with a unique index, so it is T13's `ever-id-replay.service.ts` and
 * the API's `/backchannel-logout` handler (T20/T25). What this file pins is the
 * plugin's half of that contract: the `jti` is **required** — a notice without one
 * is `badLogoutEvent`, because a notice that cannot be bounded must not be treated
 * as new — and it is answered verbatim so the caller can key its window on it. The
 * case below that presents the same `jti` twice states the split explicitly.
 *
 * Everything else FR-33 says is here too: "validated like FR-11 and FR-13" (the
 * algorithm allow-list, the signature, the issuer rule, FR-13's key ladder), the
 * back-channel logout event, "no `nonce`", "`sid` or `sub` present", and the
 * `iat` bound. FR-34 and FR-35 — which sessions end, and that a notice never ends a
 * session opened another way — are the API's and are not claimed.
 *
 * ## The clock, and the numbers
 *
 * The clock is injected (`BASE_TIME_MS`) and moved per case by **literals** —
 * `300`, `301`, `60`, `61` — never by the module's constants, and the samples below
 * are signed by real ES256 keys and verified through the real key cache. The
 * exported constants are cross-checked at the end of the file against those
 * literals and against `EVER_ID_LIMITS` / `EVER_ID_SCOPES` read off disk.
 *
 * ## The one reading that is not literal in the plan
 *
 * `exp` is **checked when present and not required** (see the case group "the
 * `exp` a logout token may or may not carry"). OpenID Connect Back-Channel Logout
 * 1.0 §2.4 does not put `exp` in the claim set a logout token must carry, and FR-53
 * promises any standards-compliant provider works; FR-33 states the freshness bound
 * it does want — `iat` within the skew and no older than 300 seconds — and that is
 * enforced either way. The choice is pinned in both directions below, and reported.
 */

const ISSUER = 'https://auth.ever.co';
const AUTHORIZATION_ENDPOINT = `${ISSUER}/oauth/v2/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/v2/token`;
const JWKS_URI = `${ISSUER}/oauth/v2/keys`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = 'ever-works-web';
const SECRET = 'ever-id-client-secret-0123456789abcdef-do-not-print';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const SID = 'ever-id-session-1';
const SUBJECT = 'subject-1';

/** FR-33's numbers and FR-2's skew, written as literals (see the header). */
const FR33_MAX_AGE_SECONDS = 300;
const FR33_REPLAY_WINDOW_SECONDS = 600;
const FR2_SKEW_SECONDS = 60;

const BASE_TIME_MS = Date.parse('2026-09-17T09:00:00.000Z');
const BASE_TIME_SECONDS = Math.floor(BASE_TIME_MS / 1_000);

let clockMs = BASE_TIME_MS;

const at = (offsetSeconds: number): void => {
	clockMs = BASE_TIME_MS + offsetSeconds * 1_000;
};

interface TestKey {
	readonly kid: string;
	readonly jwk: JWK;
	readonly privateKey: CryptoKey;
}

const makeKey = async (kid: string): Promise<TestKey> => {
	const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
	const jwk = await exportJWK(publicKey);
	return { kid, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' }, privateKey };
};

const healthyDocument = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	issuer: ISSUER,
	authorization_endpoint: AUTHORIZATION_ENDPOINT,
	token_endpoint: TOKEN_ENDPOINT,
	jwks_uri: JWKS_URI,
	code_challenge_methods_supported: ['S256'],
	id_token_signing_alg_values_supported: ['ES256'],
	backchannel_logout_supported: true,
	backchannel_logout_session_supported: true,
	...overrides
});

const settings = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	issuerUrl: ISSUER,
	clientId: CLIENT_ID,
	clientSecret: SECRET,
	...overrides
});

/**
 * The claims a valid sign-out notice carries — ZITADEL's shape and the OIDC
 * Back-Channel Logout 1.0 §2.4 claim set: `iss`, `aud`, `iat`, `jti`, `events`, and
 * `sid` (or `sub`).
 *
 * `exp` is deliberately **absent** by default: this provider is the
 * standards-compliant one FR-53 promises to work with. The cases that care about
 * `exp` add it.
 */
const validClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	iss: ISSUER,
	aud: CLIENT_ID,
	iat: BASE_TIME_SECONDS,
	jti: 'logout-replay-key-1',
	events: { [LOGOUT_EVENT]: {} },
	sid: SID,
	...overrides
});

const signLogoutToken = (claims: Record<string, unknown>, key: TestKey, alg = 'ES256'): Promise<string> =>
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
}

/**
 * A provider with a key set and a discovery document.
 *
 * The sign-out notice arrives **from** the provider, so the path that verifies one
 * reads exactly two endpoints — FR-14's document and FR-13's keys. Plan §9.2 says
 * the same thing operationally: "honouring logouts must not depend on a fresh key
 * fetch", which is what FR-13's 21,600-second ladder is for.
 */
interface FakeProvider {
	readonly calls: FakeCall[];
	readonly fetch: OidcFetchImpl;
	document: Record<string, unknown>;
	keys: JWK[];
	mode: 'ok' | 'reject';
}

const jsonAnswer = (body: unknown): OidcHttpResponse => ({ ok: true, status: 200, json: async () => body });

const fakeProvider = (): FakeProvider => {
	const provider: FakeProvider = {
		calls: [],
		document: healthyDocument(),
		keys: [],
		mode: 'ok',
		fetch: async (url, init): Promise<OidcHttpResponse> => {
			provider.calls.push({ url, method: init.method });
			if (provider.mode === 'reject') throw new Error('connect ECONNREFUSED (transport)');
			if (url === DISCOVERY_URL) return jsonAnswer(provider.document);
			if (url === JWKS_URI) return jsonAnswer({ keys: provider.keys });
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
	const plugin = new OidcIdentityPlugin({ fetchImpl: provider.fetch, now: () => clockMs });
	await plugin.onLoad(contextFor(values, logger));
	return { plugin, logger };
};

/** Sign `claims` with `key`, publish `key`, and hand the notice to the plugin. */
const noticeCase = async (
	claims: Record<string, unknown>,
	options: { key?: TestKey; published?: JWK[]; settings?: Record<string, unknown> } = {}
): Promise<{
	plugin: OidcIdentityPlugin;
	provider: FakeProvider;
	logger: CapturedLogger;
	token: string;
	run: () => Promise<unknown>;
}> => {
	const key = options.key ?? (await makeKey('key-a'));
	const provider = fakeProvider();
	provider.keys = options.published ?? [key.jwk];
	const token = await signLogoutToken(claims, key);
	const { plugin, logger } = await pluginFor(provider, options.settings ?? settings());
	return { plugin, provider, logger, token, run: () => plugin.verifyLogoutToken(token) };
};

/** The refusal every rule raises: one code, and nothing else in the message (FR-16). */
const expectRefusal = async (work: Promise<unknown>, code: string): Promise<void> => {
	await expect(work, code).rejects.toMatchObject({ code, message: code });
};

afterEach(() => {
	clockMs = BASE_TIME_MS;
	vi.useRealTimers();
});

describe('the accepted notice (FR-33) — the three claims the teardown keys on', () => {
	it('answers the issuer, the `sid` and the `jti` of a notice that names a session', async () => {
		const { run } = await noticeCase(validClaims());

		await expect(run()).resolves.toEqual({
			issuer: ISSUER,
			subject: null,
			sid: SID,
			jti: 'logout-replay-key-1'
		});
	});

	it('answers the `sub` when the notice names the person instead of the session', async () => {
		const claims = validClaims({ sub: SUBJECT, jti: 'logout-sub-1' });
		delete claims.sid;
		const { run } = await noticeCase(claims);

		await expect(run()).resolves.toEqual({
			issuer: ISSUER,
			subject: SUBJECT,
			sid: null,
			jti: 'logout-sub-1'
		});
	});

	it('answers both when the provider sent both', async () => {
		const { run } = await noticeCase(validClaims({ sub: SUBJECT, jti: 'logout-both-1' }));

		await expect(run()).resolves.toMatchObject({ subject: SUBJECT, sid: SID, jti: 'logout-both-1' });
	});
});

describe('ACC-12-24 — the `nonce`, and the `iat` older than 300 seconds', () => {
	it('refuses a notice carrying a `nonce`, with nonceInLogoutToken', async () => {
		const { run } = await noticeCase(validClaims({ nonce: 'a-nonce-that-should-not-be-here' }));

		await expectRefusal(run(), 'nonceInLogoutToken');
	});

	it('refuses an empty and a null `nonce` too: the claim being present is the rule', async () => {
		const empty = await noticeCase(validClaims({ nonce: '', jti: 'logout-nonce-empty' }));
		await expectRefusal(empty.run(), 'nonceInLogoutToken');

		const explicitNull = await noticeCase(validClaims({ nonce: null, jti: 'logout-nonce-null' }));
		await expectRefusal(explicitNull.run(), 'nonceInLogoutToken');
	});

	it('refuses an `iat` of 301 seconds with tooOld, and accepts 300', async () => {
		const edge = await noticeCase(validClaims({ iat: BASE_TIME_SECONDS - 300, jti: 'logout-age-edge' }));
		await expect(edge.run()).resolves.toMatchObject({ jti: 'logout-age-edge' });

		const old = await noticeCase(validClaims({ iat: BASE_TIME_SECONDS - 301, jti: 'logout-age-old' }));
		await expectRefusal(old.run(), 'tooOld');
	});

	it('refuses a future `iat` beyond the skew, with notYetValid, and accepts one inside it', async () => {
		const inside = await noticeCase(validClaims({ iat: BASE_TIME_SECONDS + 60, jti: 'logout-future-edge' }));
		await expect(inside.run()).resolves.toMatchObject({ jti: 'logout-future-edge' });

		const future = await noticeCase(validClaims({ iat: BASE_TIME_SECONDS + 61, jti: 'logout-future' }));
		await expectRefusal(future.run(), 'notYetValid');
	});

	it('measures the 300-second bound on the injected clock, not on the token (FR-2, FR-33)', async () => {
		// The same notice, verified now and then three minutes later: the claims never
		// changed, so only the clock can have made the difference — and the numbers
		// (`300`, `301`) are literals rather than the module's constants.
		const cases = await noticeCase(validClaims({ iat: BASE_TIME_SECONDS, jti: 'logout-clock-1' }));
		await expect(cases.run()).resolves.toBeDefined();

		at(300);
		await expect(cases.run()).resolves.toMatchObject({ jti: 'logout-clock-1' });

		at(301);
		await expectRefusal(cases.run(), 'tooOld');
	});

	it('refuses a notice with no readable `iat`, with tooOld', async () => {
		const claims = validClaims();
		delete claims.iat;
		const { run } = await noticeCase(claims);

		await expectRefusal(run(), 'tooOld');
	});

	it('does **not** refuse a reused `jti`: the 600-second window is the caller’s (T13)', async () => {
		// ACC-12-24's `jti` half is the API's, and this case states the split instead
		// of leaving it to be inferred: the same notice verifies twice, and the answer
		// carries the key the replay store has to hold.
		const cases = await noticeCase(validClaims({ jti: 'logout-reused-key' }));

		await expect(cases.run()).resolves.toMatchObject({ jti: 'logout-reused-key' });
		await expect(cases.run()).resolves.toMatchObject({ jti: 'logout-reused-key' });
	});
});

describe('FR-33 — the back-channel logout event, `sid`/`sub` and the required `jti`', () => {
	it('refuses a notice with no `events` member, with badLogoutEvent', async () => {
		const claims = validClaims();
		delete claims.events;
		const { run } = await noticeCase(claims);

		await expectRefusal(run(), 'badLogoutEvent');
	});

	it('refuses an `events` object that carries another event, with badLogoutEvent', async () => {
		const { run } = await noticeCase(validClaims({ events: { 'https://schemas.openid.net/event/other': {} } }));

		await expectRefusal(run(), 'badLogoutEvent');
	});

	it('refuses an `events` that is not an object at all, with badLogoutEvent', async () => {
		const list = await noticeCase(validClaims({ events: [LOGOUT_EVENT], jti: 'logout-events-list' }));
		await expectRefusal(list.run(), 'badLogoutEvent');

		const text = await noticeCase(validClaims({ events: LOGOUT_EVENT, jti: 'logout-events-text' }));
		await expectRefusal(text.run(), 'badLogoutEvent');

		const empty = await noticeCase(validClaims({ events: {}, jti: 'logout-events-empty' }));
		await expectRefusal(empty.run(), 'badLogoutEvent');
	});

	it('refuses a notice naming neither a session nor a person, with badLogoutEvent', async () => {
		const claims = validClaims();
		delete claims.sid;
		const { run } = await noticeCase(claims);

		await expectRefusal(run(), 'badLogoutEvent');
	});

	it('refuses an empty `sid` and an empty `sub` as if they were absent, with badLogoutEvent', async () => {
		const blankSid = await noticeCase(validClaims({ sid: '   ', jti: 'logout-blank-sid' }));
		await expectRefusal(blankSid.run(), 'badLogoutEvent');

		const blankSub = await noticeCase(validClaims({ sid: null, sub: '   ', jti: 'logout-blank-sub' }));
		await expectRefusal(blankSub.run(), 'badLogoutEvent');
	});

	it('refuses a notice with no `jti`, with badLogoutEvent rather than treating it as new', async () => {
		const claims = validClaims();
		delete claims.jti;
		const { run } = await noticeCase(claims);

		await expectRefusal(run(), 'badLogoutEvent');
	});

	it('refuses an empty `jti`, with badLogoutEvent', async () => {
		const { run } = await noticeCase(validClaims({ jti: '' }));

		await expectRefusal(run(), 'badLogoutEvent');
	});
});

describe('the `exp` a logout token may or may not carry (the one documented reading)', () => {
	it('accepts a notice with no `exp` at all, because FR-33 states no such requirement', async () => {
		const { run } = await noticeCase(validClaims({ jti: 'logout-no-exp' }));

		await expect(run()).resolves.toMatchObject({ jti: 'logout-no-exp' });
	});

	it('accepts a notice with an `exp` in the future', async () => {
		const { run } = await noticeCase(validClaims({ exp: BASE_TIME_SECONDS + 120, jti: 'logout-exp-future' }));

		await expect(run()).resolves.toMatchObject({ jti: 'logout-exp-future' });
	});

	it('refuses a notice with an `exp` past the skew, with expired', async () => {
		const { run } = await noticeCase(
			validClaims({ exp: BASE_TIME_SECONDS - 61, iat: BASE_TIME_SECONDS - 300, jti: 'logout-exp-past' })
		);

		await expectRefusal(run(), 'expired');
	});
});

describe('the rules FR-33 adopts from FR-11 and FR-13 — issuer, signature, algorithm', () => {
	it('refuses a notice from another issuer, with badIssuer', async () => {
		const { run } = await noticeCase(validClaims({ iss: 'https://evil.example' }));

		await expectRefusal(run(), 'badIssuer');
	});

	it('refuses a notice signed by a key the provider does not publish, with badSignature', async () => {
		const published = await makeKey('key-a');
		const other = await makeKey('key-b');
		const { run } = await noticeCase(validClaims(), { key: other, published: [published.jwk] });

		await expectRefusal(run(), 'badSignature');
	});

	it('refuses a notice signed with `alg: none`, with badAlg, before any key lookup', async () => {
		const { plugin, provider } = await noticeCase(validClaims());
		const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-a' })).toString('base64url');
		const payload = Buffer.from(JSON.stringify(validClaims())).toString('base64url');

		await expectRefusal(plugin.verifyLogoutToken(`${header}.${payload}.`), 'badAlg');
		expect(provider.calls.map((call) => call.url)).toEqual([DISCOVERY_URL]);
	});

	it('refuses a value that is not a compact JWS at all, with badSignature', async () => {
		const { plugin } = await noticeCase(validClaims());

		await expectRefusal(plugin.verifyLogoutToken('not-a-token'), 'badSignature');
	});

	it('uses the cached key set, so a sign-out notice survives a provider that is down (plan §9.2)', async () => {
		const cases = await noticeCase(validClaims({ jti: 'logout-cached-keys' }));
		await expect(cases.run()).resolves.toBeDefined();
		const callsAfterFirst = cases.provider.calls.length;

		// The provider goes away; FR-13's ladder keeps the fetched keys usable.
		cases.provider.mode = 'reject';
		await expect(cases.run()).resolves.toMatchObject({ jti: 'logout-cached-keys' });
		expect(cases.provider.calls.length).toBe(callsAfterFirst);
	});

	it('never puts a token, a claim or the secret in the message (FR-16)', async () => {
		const { run, logger } = await noticeCase(validClaims({ nonce: 'a-nonce' }));

		await expect(run(), 'nonceInLogoutToken').rejects.toMatchObject({ message: 'nonceInLogoutToken' });
		expect(logger.lines.join('\n')).not.toContain('ever-id-client-secret');
		expect(logger.lines.join('\n')).not.toContain('a-nonce');
	});
});

describe('the provider cannot be asked (FR-14, FR-15)', () => {
	it('answers providerUnavailable when the integration is not configured', async () => {
		const provider = fakeProvider();
		const plugin = new OidcIdentityPlugin({ fetchImpl: provider.fetch, now: () => clockMs });
		await plugin.onLoad(contextFor({ issuerUrl: ISSUER }));

		await expectRefusal(plugin.verifyLogoutToken('any-token'), 'providerUnavailable');
	});

	it('answers providerUnavailable when the discovery document cannot be read', async () => {
		const cases = await noticeCase(validClaims());
		cases.provider.mode = 'reject';

		await expectRefusal(cases.run(), 'providerUnavailable');
	});

	it('answers providerUnavailable when the document names no key set', async () => {
		const document = healthyDocument();
		delete document.jwks_uri;
		const provider = fakeProvider();
		provider.document = document;
		const { plugin } = await pluginFor(provider);

		await expectRefusal(plugin.verifyLogoutToken('any-token'), 'providerUnavailable');
	});
});

describe('the numbers, transcribed — a cross-check, never the source of a case above', () => {
	const contracts = readFileSync(new URL('../../../../contracts/src/apps/ever-id.ts', import.meta.url), 'utf8');

	const limitValue = (key: string): number => {
		const match = new RegExp(`${key}:\\s*([0-9_]+)`).exec(contracts);
		if (match === null) throw new Error(`EVER_ID_LIMITS.${key} not found in the contracts source`);
		return Number(match[1].replace(/_/gu, ''));
	};

	it('holds FR-33’s notice age and replay window as the contracts file states them', () => {
		expect(OIDC_LOGOUT_TOKEN_MAX_AGE_SECONDS).toBe(FR33_MAX_AGE_SECONDS);
		expect(OIDC_LOGOUT_TOKEN_MAX_AGE_SECONDS).toBe(limitValue('logoutTokenMaxAgeSeconds'));
		expect(OIDC_LOGOUT_TOKEN_REPLAY_WINDOW_SECONDS).toBe(FR33_REPLAY_WINDOW_SECONDS);
		expect(OIDC_LOGOUT_TOKEN_REPLAY_WINDOW_SECONDS).toBe(limitValue('replayWindowSeconds'));
		expect(FR2_SKEW_SECONDS).toBe(limitValue('defaultClockSkewSeconds'));
	});

	it('holds the back-channel logout event identifier OpenID Connect defines', () => {
		expect(OIDC_BACKCHANNEL_LOGOUT_EVENT).toBe(LOGOUT_EVENT);
		expect(OIDC_BACKCHANNEL_LOGOUT_EVENT).toBe('http://schemas.openid.net/event/backchannel-logout');
	});
});
