import { afterEach, describe, expect, it } from 'vitest';

import type { PluginContext } from '@ever-works/plugin';

import { OidcIdentityPlugin } from '../oidc-identity.plugin.js';
import { FakeOidcProvider } from '../testing/fake-oidc-provider.js';

/**
 * The optional hint claims (`urn:ever:` namespace) an ID token may carry: passed
 * through on the verified claims as `hints`, never required (FR-53), never mixed
 * with a claim from any other namespace, and absent altogether when the provider
 * sends none — so a provider without them yields exactly the claims it always did.
 */

const REDIRECT_URI = 'https://app.example.test/api/auth/ever-id/callback';
let provider: FakeOidcProvider | null = null;

afterEach(async () => {
	await provider?.stop();
	provider = null;
});

function pluginFor(fake: FakeOidcProvider): OidcIdentityPlugin {
	const plugin = new OidcIdentityPlugin({ nodeEnv: 'test' });
	const context = {
		pluginId: 'oidc-identity',
		logger: { log: () => undefined, error: () => undefined, warn: () => undefined, debug: () => undefined },
		getSettings: async () => ({
			issuerUrl: fake.issuer,
			clientId: fake.clientId,
			clientSecret: fake.clientSecret
		})
	} as unknown as PluginContext;
	void plugin.onLoad(context);
	return plugin;
}

async function signIn(fake: FakeOidcProvider) {
	const plugin = pluginFor(fake);
	const request = await plugin.buildAuthorizationRequest({ redirectUri: REDIRECT_URI });
	const redirect = await fetch(request.url, { redirect: 'manual' });
	const location = new URL(String(redirect.headers.get('location')));
	return plugin.exchangeAuthorizationCode({
		code: String(location.searchParams.get('code')),
		redirectUri: REDIRECT_URI,
		codeVerifier: request.codeVerifier,
		expectedNonce: request.nonce,
		receivedIssuer: location.searchParams.get('iss') ?? undefined
	});
}

describe('ID token hint claims', () => {
	it('passes the urn:ever: claims through as hints, and nothing else', async () => {
		provider = await FakeOidcProvider.start();
		provider.setIdTokenClaims({
			'urn:ever:claims_ver': 1,
			'urn:ever:orgs': [{ id: 'org-1', links: [{ product_org_id: 'p-1' }] }],
			'urn:ever:orgs_filtered': [],
			'urn:zitadel:iam:user:resourceowner:id': 'not-a-hint',
			given_name: 'Not a hint either'
		});

		const claims = await signIn(provider);

		expect(claims.hints).toEqual({
			'urn:ever:claims_ver': 1,
			'urn:ever:orgs': [{ id: 'org-1', links: [{ product_org_id: 'p-1' }] }],
			'urn:ever:orgs_filtered': []
		});
		expect(Object.isFrozen(claims.hints)).toBe(true);
	});

	it('leaves the claims exactly as before when the provider sends no hint', async () => {
		provider = await FakeOidcProvider.start();

		const claims = await signIn(provider);

		expect('hints' in claims).toBe(false);
		expect(Object.keys(claims).sort()).toEqual(
			['authTime', 'email', 'emailVerified', 'issuer', 'name', 'sid', 'subject'].sort()
		);
	});
});
