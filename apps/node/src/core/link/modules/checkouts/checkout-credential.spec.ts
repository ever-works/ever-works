import { describe, expect, it, vi } from 'vitest';
import {
	anonymousGitEnv,
	assertCredentialCovers,
	CheckoutCredentialError,
	checkoutCredentialEnv,
	withCheckoutCredential,
	type CheckoutCredentialClient
} from './checkout-credential';

const CREDENTIAL = {
	token: 'ghs_secret_token',
	username: 'x-access-token',
	expiresAt: '2026-10-21T12:00:00.000Z',
	repository: 'acme/api',
	access: 'read' as const
};

describe('the operation-scoped checkout credential (FL-14 spec FR-17, ACC-FL14-10)', () => {
	it('reaches git only through the child environment, keyed to the exact remote, with every other source off', () => {
		const env = checkoutCredentialEnv(CREDENTIAL, 'https://github.com/acme/api.git', {});
		expect(env.GIT_CONFIG_COUNT).toBe('4');
		expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
		expect(env.GIT_CONFIG_VALUE_0).toBe('');
		expect(env.GIT_CONFIG_KEY_1).toBe('core.askpass');
		expect(env.GIT_CONFIG_KEY_2).toBe('core.hooksPath');
		expect(env.GIT_CONFIG_KEY_3).toBe('http.https://github.com/acme/api.git.extraheader');
		expect(env.GIT_CONFIG_VALUE_3).toBe(
			`Authorization: Basic ${Buffer.from('x-access-token:ghs_secret_token').toString('base64')}`
		);
	});

	it('appends after an inherited GIT_CONFIG_COUNT instead of overwriting it', () => {
		const env = checkoutCredentialEnv(CREDENTIAL, 'https://github.com/acme/api.git', { GIT_CONFIG_COUNT: '2' });
		expect(env.GIT_CONFIG_COUNT).toBe('6');
		expect(env.GIT_CONFIG_KEY_2).toBe('credential.helper');
		expect(anonymousGitEnv({ GIT_CONFIG_COUNT: '1' }).GIT_CONFIG_COUNT).toBe('4');
	});

	it('is host-aware: a token for acme/api never authenticates another repository or host', () => {
		expect(() => assertCredentialCovers('https://github.com/acme/api.git', CREDENTIAL)).not.toThrow();
		expect(() => assertCredentialCovers('https://github.com/acme/web.git', CREDENTIAL)).toThrow(
			CheckoutCredentialError
		);
		expect(() => assertCredentialCovers('https://gitlab.com/acme/api.git', CREDENTIAL)).toThrow(
			CheckoutCredentialError
		);
	});

	it('revokes the token when the operation ends, success or failure', async () => {
		const client: CheckoutCredentialClient = {
			mint: vi.fn(async () => CREDENTIAL),
			revoke: vi.fn(async () => undefined)
		};
		await withCheckoutCredential(
			client,
			{ checkoutId: '11111111-1111-1111-1111-111111111111', access: 'read', remoteUrl: 'https://github.com/acme/api' },
			async () => 'done'
		);
		await expect(
			withCheckoutCredential(
				client,
				{ checkoutId: '11111111-1111-1111-1111-111111111111', access: 'read', remoteUrl: 'https://github.com/acme/web' },
				async () => 'never'
			)
		).rejects.toBeInstanceOf(CheckoutCredentialError);
		expect(client.revoke).toHaveBeenCalledTimes(2);
		expect(client.revoke).toHaveBeenCalledWith('ghs_secret_token');
	});
});
