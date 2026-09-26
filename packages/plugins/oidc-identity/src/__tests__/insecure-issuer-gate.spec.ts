import { readFileSync } from 'node:fs';

import type { PluginContext } from '@ever-works/plugin';
import { describe, expect, it, vi } from 'vitest';

import { OidcProviderUnavailableError, type OidcFetchImpl, type OidcHttpResponse } from '../discovery.js';
import { OidcIdentityPlugin } from '../oidc-identity.plugin.js';

/**
 * FR-2's runtime half: **a non-TLS issuer is refused outside development.**
 *
 * ## Why this file exists
 *
 * `settings.schema.ts` carries the static half of FR-2's issuer rule — `https`
 * anywhere, `http` only for `localhost` / `127.0.0.1` — and said the remaining
 * half was "a `NODE_ENV` check that belongs with the discovery work in T6".
 * **T6 never wrote it.** Meanwhile `configurationFor` called
 * `allowInsecureRequests(configuration)` for any `http:` issuer, under a comment
 * asserting the schema had already answered "is this production?".
 *
 * So the plugin switched `openid-client`'s non-TLS refusal off in **every**
 * environment, and the comment was the reason nobody looked: a comment that
 * asserts a gate which was never written is worse than no comment at all.
 *
 * The gate exists now, and this file is what keeps it. It asserts the behaviour
 * in both directions and, at the end, asserts the two source claims themselves —
 * because the defect here was never a missing test, it was a false statement in
 * a comment, and prose is what has to be pinned.
 *
 * ## The allow-list, and why it is not `!== 'production'`
 *
 * The check only ever *relaxes* a rule. A deny-list gets that backwards: an
 * unset, empty or misspelt `NODE_ENV` would read as "not production" and quietly
 * turn TLS enforcement off on the one deployment that most needs it. The cases
 * below pin the fail-closed direction for empty and misspelt values.
 */

const INSECURE_ISSUER = 'http://127.0.0.1:8080';
const SECURE_ISSUER = 'https://auth.ever.co';
const CLIENT_ID = 'ever-works-web';
const SECRET = 'ever-id-client-secret-0123456789abcdef-do-not-print';
const REDIRECT_URI = 'https://ever.works/api/auth/ever-id/callback/';

const documentFor = (issuer: string): Record<string, unknown> => ({
	issuer,
	authorization_endpoint: `${issuer}/oauth/v2/authorize`,
	token_endpoint: `${issuer}/oauth/v2/token`,
	jwks_uri: `${issuer}/oauth/v2/keys`,
	code_challenge_methods_supported: ['S256'],
	id_token_signing_alg_values_supported: ['RS256']
});

interface FakeProvider {
	readonly requests: string[];
	readonly fetch: OidcFetchImpl;
}

const fakeProvider = (issuer: string): FakeProvider => {
	const requests: string[] = [];
	return {
		requests,
		fetch: async (url): Promise<OidcHttpResponse> => {
			requests.push(url);
			if (url.endsWith('/.well-known/openid-configuration')) {
				return { ok: true, status: 200, json: async () => documentFor(issuer) };
			}
			if (url.endsWith('/oauth/v2/keys')) {
				return { ok: true, status: 200, json: async () => ({ keys: [] }) };
			}
			throw new Error(`unexpected request: ${url}`);
		}
	};
};

const errorLines: string[] = [];

const contextFor = (issuerUrl: string): PluginContext =>
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
		getSettings: vi.fn().mockResolvedValue({ issuerUrl, clientId: CLIENT_ID, clientSecret: SECRET })
	}) as unknown as PluginContext;

const pluginFor = async (
	issuerUrl: string,
	nodeEnv: string
): Promise<{ plugin: OidcIdentityPlugin; provider: FakeProvider }> => {
	const provider = fakeProvider(issuerUrl);
	const plugin = new OidcIdentityPlugin({ fetchImpl: provider.fetch, nodeEnv });
	await plugin.onLoad(contextFor(issuerUrl));
	return { plugin, provider };
};

describe('FR-2 runtime half — a non-TLS issuer outside development', () => {
	describe('the relaxation still works where it is meant to', () => {
		it('builds a sign-in request against an http://127.0.0.1 issuer in development', async () => {
			const { plugin } = await pluginFor(INSECURE_ISSUER, 'development');

			const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });

			expect(request.url.startsWith(`${INSECURE_ISSUER}/oauth/v2/authorize`)).toBe(true);
			expect(new URL(request.url).searchParams.get('code_challenge_method')).toBe('S256');
		});

		it('builds a sign-in request against an http://127.0.0.1 issuer under NODE_ENV=test', async () => {
			// Vitest sets `NODE_ENV=test`, and this package's own fake provider listens on
			// `http://127.0.0.1:<port>`. If `test` were not on the allow-list, every other
			// spec in this package would refuse before it reached what it is about.
			const { plugin } = await pluginFor(INSECURE_ISSUER, 'test');

			await expect(plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI })).resolves.toBeTruthy();
		});

		it('leaves an https issuer alone in production — no false positive', async () => {
			const { plugin } = await pluginFor(SECURE_ISSUER, 'production');

			const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });

			expect(request.url.startsWith(`${SECURE_ISSUER}/oauth/v2/authorize`)).toBe(true);
		});
	});

	describe('the refusal', () => {
		it('refuses to build a sign-in request against an http issuer in production', async () => {
			const { plugin, provider } = await pluginFor(INSECURE_ISSUER, 'production');

			await expect(plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI })).rejects.toBeInstanceOf(
				OidcProviderUnavailableError
			);
			// Refused BEFORE the network: the chokepoint is `resolveSettings`, which every
			// public method goes through, so no discovery read, no key fetch, no token call.
			expect(provider.requests).toEqual([]);
		});

		it('reports the field name (never the value) through testConnection', async () => {
			const { plugin, provider } = await pluginFor(INSECURE_ISSUER, 'production');

			const checks = await plugin.testConnection();

			expect(checks.every((check) => check.ok === false)).toBe(true);
			expect(JSON.stringify(checks)).toContain('issuerUrl');
			// FR-16: the address itself is not echoed into the admin surface.
			expect(JSON.stringify(checks)).not.toContain(INSECURE_ISSUER);
			expect(provider.requests).toEqual([]);
		});

		it('names the refused field (never the value) in the health row', async () => {
			const { plugin, provider } = await pluginFor(INSECURE_ISSUER, 'production');

			const health = await plugin.healthCheck();

			expect(health.checks?.find((check) => check.name === 'configuration')?.message).toBe(
				'Not configured: issuerUrl.'
			);
			expect(JSON.stringify(health)).not.toContain(INSECURE_ISSUER);
			expect(provider.requests).toEqual([]);
		});

		it('logs why a configured integration reports "not configured", without the value', async () => {
			errorLines.length = 0;
			const { plugin } = await pluginFor(INSECURE_ISSUER, 'production');

			await plugin.testConnection();

			expect(errorLines.some((line) => line.includes('non-TLS'))).toBe(true);
			expect(errorLines.some((line) => line.includes(INSECURE_ISSUER))).toBe(false);
		});

		it.each(['', 'prodcution', 'PRODUCTION ', 'staging', 'dev', 'develop', 'testing'])(
			'fails CLOSED for NODE_ENV=%o — the allow-list property',
			async (nodeEnv) => {
				// None of these is `development` or `test`, so none of them may relax the rule.
				// A deny-list (`!== 'production'`) would let every one of them through.
				const { plugin, provider } = await pluginFor(INSECURE_ISSUER, nodeEnv);

				await expect(plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI })).rejects.toBeInstanceOf(
					OidcProviderUnavailableError
				);
				expect(provider.requests).toEqual([]);
			}
		);

		it('accepts the exact spellings the allow-list names, case- and space-insensitively', async () => {
			for (const nodeEnv of ['development', 'DEVELOPMENT', ' test ', 'Test', 'Development ']) {
				const { plugin } = await pluginFor(INSECURE_ISSUER, nodeEnv);
				await expect(plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI })).resolves.toBeTruthy();
			}
		});
	});

	describe('the two source claims that hid this for as long as they did', () => {
		const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

		it('the plugin no longer claims the schema answered the environment question', () => {
			const text = source('../oidc-identity.plugin.ts');

			// The false sentence, verbatim as it stood.
			expect(text).not.toContain('and outside production (settings.schema.ts:41-42)');
			// And the gate it claimed is really there.
			expect(text).toContain('function allowsInsecureIssuer(');
			expect(text).toContain('NON_PRODUCTION_NODE_ENVS');
		});

		it('the settings schema no longer defers the check to a task that never wrote it', () => {
			const text = source('../settings.schema.ts');

			expect(text).not.toContain('belongs with the discovery work in T6');
			expect(text).toContain('allowsInsecureIssuer');
		});
	});
});
