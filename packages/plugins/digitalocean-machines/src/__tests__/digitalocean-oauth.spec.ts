import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMachineProviderError, isOAuthPlugin } from '@ever-works/plugin';

import { DigitalOceanMachinesPlugin } from '../digitalocean-machines.plugin.js';
import { ENV_DIGITALOCEAN_OAUTH_CLIENT_ID, ENV_DIGITALOCEAN_OAUTH_CLIENT_SECRET } from '../digitalocean-oauth.js';
import { createFakeDigitalOceanApi, FAKE_OAUTH_CLIENT } from '../testing/fake-digitalocean-api.js';

/**
 * FL-17 P3 (T-28, spec FR-31) — "Sign in with DigitalOcean": the `oauth`
 * capability exists only while the operator configured an application (both
 * env values); the consent URL carries the client id, the state and the
 * scopes, never the secret; the code swap posts a form body (the secret never
 * in a URL) and a refusal never quotes the body; the signed-in account names
 * the user; an OAuth access token configures the plugin and works for every
 * call, and a saved API token still wins.
 */

const ACCESS = 'oauth-access-token';
const env = { ...process.env };

function plugin() {
	const fake = createFakeDigitalOceanApi(ACCESS);
	return {
		fake,
		provider: new DigitalOceanMachinesPlugin(
			fake.fetch,
			'https://fake.digitalocean.test',
			'https://fake-cloud.digitalocean.test'
		)
	};
}

describe('DigitalOceanMachinesPlugin sign-in (FL-17 P3)', () => {
	beforeEach(() => {
		delete process.env[ENV_DIGITALOCEAN_OAUTH_CLIENT_ID];
		delete process.env[ENV_DIGITALOCEAN_OAUTH_CLIENT_SECRET];
	});
	afterEach(() => {
		process.env = { ...env };
	});

	it('advertises oauth only while both halves of the application are configured', () => {
		const { provider } = plugin();
		expect(provider.capabilities).toEqual(['machine-provider']);
		expect(isOAuthPlugin(provider)).toBe(false);
		process.env[ENV_DIGITALOCEAN_OAUTH_CLIENT_ID] = FAKE_OAUTH_CLIENT.clientId;
		expect(provider.capabilities).toEqual(['machine-provider']);
		process.env[ENV_DIGITALOCEAN_OAUTH_CLIENT_SECRET] = FAKE_OAUTH_CLIENT.clientSecret;
		expect(provider.capabilities).toEqual(['machine-provider', 'oauth']);
		expect(isOAuthPlugin(provider)).toBe(true);
		expect(provider.getManifest().capabilities).toContain('oauth');
	});

	it('declares the operator application as admin-only global settings the OAuth service reads', () => {
		const { provider } = plugin();
		const properties = (provider.settingsSchema as { properties: Record<string, Record<string, unknown>> })
			.properties;
		expect(properties.clientId).toMatchObject({
			'x-adminOnly': true,
			'x-scope': 'global',
			'x-envVar': ENV_DIGITALOCEAN_OAUTH_CLIENT_ID
		});
		expect(properties.clientSecret).toMatchObject({
			'x-secret': true,
			'x-adminOnly': true,
			'x-scope': 'global',
			'x-envVar': ENV_DIGITALOCEAN_OAUTH_CLIENT_SECRET
		});
	});

	it('builds the consent URL with the client id, the state and read write — never the secret', () => {
		const { provider } = plugin();
		const url = new URL(
			provider.getAuthorizationUrl('state-123', {
				clientId: FAKE_OAUTH_CLIENT.clientId,
				clientSecret: FAKE_OAUTH_CLIENT.clientSecret,
				redirectUri: 'https://app.example.com/api/oauth/digitalocean-machines/callback/plugins'
			})
		);
		expect(`${url.origin}${url.pathname}`).toBe('https://fake-cloud.digitalocean.test/v1/oauth/authorize');
		expect(url.searchParams.get('client_id')).toBe(FAKE_OAUTH_CLIENT.clientId);
		expect(url.searchParams.get('state')).toBe('state-123');
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('scope')).toBe('read write');
		expect(url.toString()).not.toContain(FAKE_OAUTH_CLIENT.clientSecret);
	});

	it('swaps the code with a form body, and refuses without quoting the provider’s body', async () => {
		const { provider, fake } = plugin();
		const config = {
			clientId: FAKE_OAUTH_CLIENT.clientId,
			clientSecret: FAKE_OAUTH_CLIENT.clientSecret,
			redirectUri: 'https://app.example.com/cb'
		};
		const token = await provider.exchangeCodeForToken(FAKE_OAUTH_CLIENT.code, config);
		expect(token).toMatchObject({
			accessToken: ACCESS,
			tokenType: 'bearer',
			refreshToken: 'fake-refresh',
			expiresIn: 2592000
		});
		expect(fake.oauthForms[0].get('grant_type')).toBe('authorization_code');
		expect(fake.oauthForms[0].get('redirect_uri')).toBe('https://app.example.com/cb');
		// The secret travelled in the body, never in the URL.
		expect(fake.requests.every((request) => !request.path.includes(FAKE_OAUTH_CLIENT.clientSecret))).toBe(true);

		const refused = await provider.exchangeCodeForToken('wrong-code', config).catch((error: unknown) => error);
		expect(isMachineProviderError(refused)).toBe(true);
		expect((refused as Error).message).not.toContain('wrong-code');

		const refreshed = await provider.refreshAccessToken('fake-refresh', config);
		expect(refreshed.accessToken).toBe(ACCESS);
	});

	it('names the signed-in account, and works with the OAuth token alone', async () => {
		const { provider, fake } = plugin();
		await expect(provider.getAuthenticatedUser(ACCESS)).resolves.toEqual({
			id: 'b6fc48dbf6d9906cace5e2d4dbb6ae8e9b4b9d25',
			username: 'owner@example.com',
			email: 'owner@example.com',
			name: 'acme'
		});
		expect(provider.isConfigured({ oauthAccessToken: ACCESS })).toBe(true);
		const options = await provider.listOptions({ oauthAccessToken: ACCESS });
		expect(options.account.label).toBe('acme');
		expect(fake.requests.every((request) => request.authorized || request.path.startsWith('/v1/oauth'))).toBe(true);
	});

	it('prefers a saved API token over the sign-in', async () => {
		const { provider, fake } = plugin();
		const refused = await provider
			.listOptions({ apiToken: 'a-different-token', oauthAccessToken: ACCESS })
			.catch((e: unknown) => e);
		// The fake knows only the OAuth token, so the saved token being used shows as a refusal.
		expect(isMachineProviderError(refused)).toBe(true);
		expect(fake.requests.at(-1)?.authorized).toBe(false);
	});

	it('reports a machine’s region and size, as reconciliation prices an adopted one with them', async () => {
		const { provider } = plugin();
		const created = await provider.create(
			{
				name: 'nyc-ops',
				regionId: 'nyc3',
				sizeId: 's-2vcpu-4gb',
				bootstrapScript: '#cloud-config\n',
				tags: ['ever-works']
			},
			{ oauthAccessToken: ACCESS }
		);
		const machine = await provider.getMachine(created.machineRef, { oauthAccessToken: ACCESS });
		expect(machine).toMatchObject({ regionId: 'nyc3', sizeId: 's-2vcpu-4gb' });
		const tagged = await provider.listTagged('ever-works', { oauthAccessToken: ACCESS });
		expect(tagged[0]).toMatchObject({ regionId: 'nyc3', sizeId: 's-2vcpu-4gb', tags: ['ever-works'] });
	});
});
