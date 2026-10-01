import { readFileSync } from 'node:fs';

import type { PluginContext } from '@ever-works/plugin';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { OidcProviderUnavailableError, type OidcFetchImpl, type OidcHttpResponse } from '../discovery.js';
import * as packageEntry from '../index.js';
import {
	OIDC_DEFAULT_CLOCK_SKEW_SECONDS,
	OIDC_MAX_CLOCK_SKEW_SECONDS,
	OidcIdentityPlugin
} from '../oidc-identity.plugin.js';
import { oidcIdentitySettingsSchema } from '../settings.schema.js';

/**
 * FR-2's clock-skew bound, **re-checked at run time**.
 *
 * ## Why this file exists
 *
 * FR-2 bounds `clockSkewSeconds` to 0–120 seconds, and the settings schema says
 * so (`minimum: 0`, `maximum: 120`). But the plugin applied the stored value
 * unchecked, as `settings.clockSkewSeconds ?? OIDC_DEFAULT_CLOCK_SKEW_SECONDS`, in
 * all three token verifiers. The schema bound was assumed to have run. For this
 * key it never does:
 *
 *   - `clockSkewSeconds` is `x-envVar` and not `x-secret`, so
 *     `PluginSettingsService.filterEnvVarFields` strips it from every settings
 *     write. The schema validator never sees it.
 *   - Its only live source is `EVER_ID_CLOCK_SKEW_SECONDS`, which
 *     `PluginSettingsService.parseEnvValue` turns into a value with `Number(value)`.
 *     There is no bound and no integer check, and a typo such as `60s` gives `NaN`.
 *   - A row written before the key was `x-envVar`, or by anything that is not the
 *     settings API, is returned as stored.
 *
 * Out of bounds, the value fails OPEN. The verifiers compare `exp <= now - skew` and
 * `iat > now + skew`, so:
 *
 *   - `3600` accepts a token that expired up to an hour ago;
 *   - `NaN` makes every comparison false and accepts any `exp` and any `iat`;
 *   - the string `'60'` turns `now + skew` into string concatenation, so the
 *     future edge of `iat` never refuses.
 *
 * `resolveSettings` is the chokepoint every public method goes through, and it now
 * refuses such a value in the same way it refuses a non-TLS issuer in production
 * (see `insecure-issuer-gate.spec.ts`): `notConfigured`, before the network, with
 * the field name logged and the value never logged (FR-4, FR-16).
 *
 * The numbers in the behavioural cases are FR-2's literals. The exported constant
 * is pinned against `EVER_ID_LIMITS` and the schema at the end of the file.
 */

const ISSUER = 'https://auth.ever.co';
const CLIENT_ID = 'ever-works-web';
const SECRET = 'ever-id-client-secret-0123456789abcdef-do-not-print';
const REDIRECT_URI = 'https://ever.works/api/auth/ever-id/callback';
const NONCE = 'the-nonce-the-transaction-sealed';

const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/v2/token`;
const JWKS_URI = `${ISSUER}/oauth/v2/keys`;

/** FR-2's bound and default, written as literals rather than read from the module. */
const FR2_MAX_SKEW_SECONDS = 120;
const FR2_DEFAULT_SKEW_SECONDS = 60;

const BASE_TIME_MS = Date.parse('2026-09-25T09:00:00.000Z');
const BASE_TIME_SECONDS = Math.floor(BASE_TIME_MS / 1_000);

interface FakeProvider {
	readonly requests: string[];
	readonly fetch: OidcFetchImpl;
	idToken: string | null;
	keys: unknown[];
}

const jsonAnswer = (body: unknown): OidcHttpResponse => ({ ok: true, status: 200, json: async () => body });

const fakeProvider = (): FakeProvider => {
	const provider: FakeProvider = {
		requests: [],
		idToken: null,
		keys: [],
		fetch: async (url): Promise<OidcHttpResponse> => {
			provider.requests.push(url);
			if (url === DISCOVERY_URL) {
				return jsonAnswer({
					issuer: ISSUER,
					authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
					token_endpoint: TOKEN_ENDPOINT,
					jwks_uri: JWKS_URI,
					end_session_endpoint: `${ISSUER}/oidc/v1/end_session`,
					code_challenge_methods_supported: ['S256'],
					id_token_signing_alg_values_supported: ['ES256']
				});
			}
			if (url === JWKS_URI) return jsonAnswer({ keys: provider.keys });
			if (url === TOKEN_ENDPOINT) {
				return jsonAnswer({ id_token: provider.idToken, access_token: 'at', token_type: 'Bearer' });
			}
			throw new Error(`unexpected request: ${url}`);
		}
	};
	return provider;
};

/** `undefined` means "the key is not in the stored settings at all". */
const settingsWith = (clockSkewSeconds: unknown): Record<string, unknown> => {
	const values: Record<string, unknown> = { issuerUrl: ISSUER, clientId: CLIENT_ID, clientSecret: SECRET };
	if (clockSkewSeconds !== undefined) values.clockSkewSeconds = clockSkewSeconds;
	return values;
};

const contextFor = (values: Record<string, unknown>, errorLines: string[]): PluginContext =>
	({
		pluginId: 'oidc-identity',
		logger: {
			log: () => undefined,
			warn: () => undefined,
			debug: () => undefined,
			error: (message: string) => {
				errorLines.push(message);
			}
		},
		cache: {},
		http: {},
		env: {},
		envVars: {},
		services: {},
		getSettings: vi.fn().mockResolvedValue(values)
	}) as unknown as PluginContext;

const pluginFor = async (
	clockSkewSeconds: unknown
): Promise<{ plugin: OidcIdentityPlugin; provider: FakeProvider; errorLines: string[] }> => {
	const provider = fakeProvider();
	const errorLines: string[] = [];
	const plugin = new OidcIdentityPlugin({
		fetchImpl: provider.fetch,
		now: () => BASE_TIME_MS,
		nodeEnv: 'production'
	});
	await plugin.onLoad(contextFor(settingsWith(clockSkewSeconds), errorLines));
	return { plugin, provider, errorLines };
};

/** A plugin whose provider answers the code exchange with a real ES256-signed ID token carrying `claims`. */
const pluginAnswering = async (
	clockSkewSeconds: unknown,
	claims: Record<string, unknown>
): Promise<{ plugin: OidcIdentityPlugin; provider: FakeProvider }> => {
	const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
	const jwk = await exportJWK(publicKey);
	const { plugin, provider } = await pluginFor(clockSkewSeconds);
	provider.keys = [{ ...jwk, kid: 'key-a', alg: 'ES256', use: 'sig' }];
	provider.idToken = await new SignJWT({
		iss: ISSUER,
		sub: 'subject-1',
		aud: CLIENT_ID,
		nonce: NONCE,
		...claims
	})
		.setProtectedHeader({ alg: 'ES256', kid: 'key-a' })
		.sign(privateKey);
	return { plugin, provider };
};

const exchange = (plugin: OidcIdentityPlugin) =>
	plugin.exchangeAuthorizationCode({
		code: 'authorization-code-1',
		redirectUri: REDIRECT_URI,
		codeVerifier: 'a-64-character-code-verifier-0123456789abcdefghijklmnopqrstuvwxyzABCD',
		expectedNonce: NONCE
	});

/**
 * The values FR-2's bound refuses, each with the way it reaches the plugin:
 *
 *   - `121` and `-1` are one step outside each edge;
 *   - `1.5` is not a whole number of seconds (the schema's `type: 'integer'`);
 *   - `3600` is the stale or foreign row that would widen every window to an hour;
 *   - `'60'` is a string that was never parsed;
 *   - `NaN` is what `Number('60s')` gives for `EVER_ID_CLOCK_SKEW_SECONDS=60s`;
 *   - `Infinity` is what `Number('1e999')` gives.
 */
const OUT_OF_BOUNDS: ReadonlyArray<readonly [string, unknown]> = [
	['121', 121],
	['-1', -1],
	['1.5', 1.5],
	['3600', 3_600],
	["'60' (a string)", '60'],
	['NaN', Number.NaN],
	['Infinity', Number.POSITIVE_INFINITY]
];

describe('FR-2 — a clockSkewSeconds outside 0–120 turns the integration off', () => {
	describe.each(OUT_OF_BOUNDS)('clockSkewSeconds = %s', (_label, value) => {
		it('refuses to build a sign-in request, before the network', async () => {
			const { plugin, provider } = await pluginFor(value);

			const refusal = plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });

			await expect(refusal).rejects.toBeInstanceOf(OidcProviderUnavailableError);
			await expect(refusal).rejects.toMatchObject({ reason: 'notConfigured' });
			expect(provider.requests).toEqual([]);
		});

		it('refuses every token verifier as providerUnavailable, before the network', async () => {
			const { plugin, provider } = await pluginFor(value);

			await expect(exchange(plugin)).rejects.toMatchObject({ code: 'providerUnavailable' });
			await expect(
				plugin.verifyAccessToken('a.b.c', { requiredScopes: ['apps:read'], maxLifetimeSeconds: 3_600 })
			).rejects.toMatchObject({ code: 'providerUnavailable' });
			await expect(plugin.verifyLogoutToken('a.b.c')).rejects.toMatchObject({ code: 'providerUnavailable' });
			await expect(
				plugin.buildEndSessionUrl({ postLogoutRedirectUri: REDIRECT_URI, state: 's' })
			).rejects.toMatchObject({ reason: 'notConfigured' });
			// No discovery read, no key fetch and no token call.
			expect(provider.requests).toEqual([]);
		});

		it('names the field (never the value) in Test connection and in the log', async () => {
			const { plugin, provider, errorLines } = await pluginFor(value);

			const checks = await plugin.testConnection();

			expect(checks.every((check) => check.ok === false)).toBe(true);
			expect(checks[0]?.detail).toBe('Not configured: clockSkewSeconds.');
			expect(errorLines.some((line) => line.includes('`clockSkewSeconds`'))).toBe(true);
			// FR-4's "field names only" and FR-16: neither surface echoes the stored value.
			const surfaces = JSON.stringify({ checks, errorLines });
			expect(surfaces).not.toContain(String(value));
			expect(provider.requests).toEqual([]);
		});

		it('reports the configuration as unhealthy', async () => {
			const { plugin } = await pluginFor(value);

			const health = await plugin.healthCheck();

			expect(health.status).toBe('unhealthy');
			expect(health.checks?.find((check) => check.name === 'configuration')?.status).toBe('unhealthy');
		});

		it('names the refused field (never the value) in the health row, as Test connection does', async () => {
			const { plugin } = await pluginFor(value);

			const health = await plugin.healthCheck();
			const configuration = health.checks?.find((check) => check.name === 'configuration');

			// The gate refuses `clockSkewSeconds`; the issuer, client id and client secret
			// are all set, so a row that blames them sends the operator to the wrong field.
			expect(configuration?.message).toBe('Not configured: clockSkewSeconds.');
			// The row, not the whole view: the other rows carry cache constants (3600 s)
			// that would collide with the probe values.
			expect(JSON.stringify(configuration)).not.toContain(String(value));
		});
	});

	describe('what the gate closes: the time checks used to fail open', () => {
		// `iat`'s past edge is FR-11's fixed 600 seconds, which no skew relaxes, so every
		// token below is issued inside it. What an out-of-range skew widened is `exp`'s
		// edge and `iat`'s future edge.
		it('3600: an ID token that expired 400 seconds ago is not accepted', async () => {
			const { plugin, provider } = await pluginAnswering(3_600, {
				iat: BASE_TIME_SECONDS - 500,
				exp: BASE_TIME_SECONDS - 400
			});

			await expect(exchange(plugin)).rejects.toMatchObject({ code: 'providerUnavailable' });
			expect(provider.requests).not.toContain(TOKEN_ENDPOINT);
		});

		it('3600: an ID token issued 30 minutes in the future is not accepted', async () => {
			const { plugin, provider } = await pluginAnswering(3_600, {
				iat: BASE_TIME_SECONDS + 1_800,
				exp: BASE_TIME_SECONDS + 2_100
			});

			await expect(exchange(plugin)).rejects.toMatchObject({ code: 'providerUnavailable' });
			expect(provider.requests).not.toContain(TOKEN_ENDPOINT);
		});

		it('NaN (EVER_ID_CLOCK_SKEW_SECONDS=60s): an expired ID token is not accepted', async () => {
			const { plugin, provider } = await pluginAnswering(Number('60s'), {
				iat: BASE_TIME_SECONDS - 500,
				exp: BASE_TIME_SECONDS - 400
			});

			await expect(exchange(plugin)).rejects.toMatchObject({ code: 'providerUnavailable' });
			expect(provider.requests).not.toContain(TOKEN_ENDPOINT);
		});

		it('NaN (EVER_ID_CLOCK_SKEW_SECONDS=60s): an ID token issued a day in the future is not accepted', async () => {
			const { plugin, provider } = await pluginAnswering(Number('60s'), {
				iat: BASE_TIME_SECONDS + 86_400,
				exp: BASE_TIME_SECONDS + 86_400 + 300
			});

			await expect(exchange(plugin)).rejects.toMatchObject({ code: 'providerUnavailable' });
			expect(provider.requests).not.toContain(TOKEN_ENDPOINT);
		});

		it("'60' (a string): an ID token issued a day in the future is not accepted", async () => {
			const { plugin, provider } = await pluginAnswering('60', {
				iat: BASE_TIME_SECONDS + 86_400,
				exp: BASE_TIME_SECONDS + 86_400 + 300
			});

			await expect(exchange(plugin)).rejects.toMatchObject({ code: 'providerUnavailable' });
			expect(provider.requests).not.toContain(TOKEN_ENDPOINT);
		});
	});
});

describe('FR-2 — a clockSkewSeconds inside 0–120 (or absent) is used as before', () => {
	it.each([0, 1, FR2_DEFAULT_SKEW_SECONDS, FR2_MAX_SKEW_SECONDS])(
		'builds a sign-in request with clockSkewSeconds = %s and logs nothing',
		async (value) => {
			const { plugin, errorLines } = await pluginFor(value);

			const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });

			expect(request.url.startsWith(`${ISSUER}/oauth/v2/authorize`)).toBe(true);
			expect(errorLines).toEqual([]);
		}
	);

	it('applies a configured 120 at the edge: 120 seconds past exp is refused, 119 is accepted', async () => {
		const inside = await pluginAnswering(FR2_MAX_SKEW_SECONDS, {
			iat: BASE_TIME_SECONDS - 300,
			exp: BASE_TIME_SECONDS - (FR2_MAX_SKEW_SECONDS - 1)
		});
		await expect(exchange(inside.plugin)).resolves.toMatchObject({ subject: 'subject-1' });

		const outside = await pluginAnswering(FR2_MAX_SKEW_SECONDS, {
			iat: BASE_TIME_SECONDS - 300,
			exp: BASE_TIME_SECONDS - FR2_MAX_SKEW_SECONDS
		});
		await expect(exchange(outside.plugin)).rejects.toMatchObject({ code: 'expired' });
	});

	// `null` is treated as absent, the same answer the verifiers' `?? default` already
	// gave it. A null falls back to the bounded default, so accepting it cannot widen a
	// window. Refusing it would turn a harmless cleared key into a sign-in outage.
	it.each([
		['absent', undefined],
		['null', null]
	])('falls back to the 60-second default when the key is %s', async (_label, value) => {
		const inside = await pluginAnswering(value, {
			iat: BASE_TIME_SECONDS - 300,
			exp: BASE_TIME_SECONDS - (FR2_DEFAULT_SKEW_SECONDS - 1)
		});
		await expect(exchange(inside.plugin)).resolves.toMatchObject({ subject: 'subject-1' });

		const outside = await pluginAnswering(value, {
			iat: BASE_TIME_SECONDS - 300,
			exp: BASE_TIME_SECONDS - FR2_DEFAULT_SKEW_SECONDS
		});
		await expect(exchange(outside.plugin)).rejects.toMatchObject({ code: 'expired' });
	});
});

describe('the transcribed FR-2 bound still matches EVER_ID_LIMITS and the schema', () => {
	const contractsSource = readFileSync(
		new URL('../../../../contracts/src/apps/ever-id.ts', import.meta.url),
		'utf-8'
	);

	const limitValue = (key: string): number => {
		const match = new RegExp(`\\b${key}:\\s*([0-9_]+)`, 'u').exec(contractsSource);
		expect(match, `${key} not found in EVER_ID_LIMITS`).not.toBeNull();
		return Number((match as RegExpExecArray)[1].replaceAll('_', ''));
	};

	it('mirrors EVER_ID_LIMITS.maxClockSkewSeconds, and FR-2 literally', () => {
		expect(OIDC_MAX_CLOCK_SKEW_SECONDS).toBe(limitValue('maxClockSkewSeconds'));
		expect(OIDC_MAX_CLOCK_SKEW_SECONDS).toBe(120);
		// The default must sit inside the bound it is checked against.
		expect(OIDC_DEFAULT_CLOCK_SKEW_SECONDS).toBeLessThanOrEqual(OIDC_MAX_CLOCK_SKEW_SECONDS);
	});

	it('agrees with the schema, so the write-time bound and the run-time bound are one bound', () => {
		const properties = oidcIdentitySettingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(properties.clockSkewSeconds.maximum).toBe(OIDC_MAX_CLOCK_SKEW_SECONDS);
		expect(properties.clockSkewSeconds.minimum).toBe(0);
		expect(properties.clockSkewSeconds.type).toBe('integer');
	});

	it('is part of the package entry, next to the default', () => {
		expect(packageEntry.OIDC_MAX_CLOCK_SKEW_SECONDS).toBe(FR2_MAX_SKEW_SECONDS);
		expect(packageEntry.OIDC_DEFAULT_CLOCK_SKEW_SECONDS).toBe(FR2_DEFAULT_SKEW_SECONDS);
	});

	it('the schema names the function that re-checks the bound at run time', () => {
		// The schema file's own rule: "Do not restate a gate here without naming the
		// function that enforces it." A docstring that claims a run-time check has to
		// point at a function that exists.
		const schemaText = readFileSync(new URL('../settings.schema.ts', import.meta.url), 'utf8');
		const pluginText = readFileSync(new URL('../oidc-identity.plugin.ts', import.meta.url), 'utf8');

		expect(schemaText).toContain('isClockSkewInBounds');
		expect(pluginText).toContain('function isClockSkewInBounds(');
	});
});
