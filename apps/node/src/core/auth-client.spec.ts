import { describe, expect, it, vi } from 'vitest';
import { PlatformAuthClient, credentialsLookUsable } from './auth-client';
import { FleetClientError, type FetchLike } from './fleet-client';
import { createLogger } from './logger';

/**
 * The authenticate leg (A14).
 *
 * What matters here is not that two HTTP calls happen — it is that the
 * password goes exactly one place and comes back nowhere, that the minted
 * token is protected the instant it exists, and that a rejected sign-in
 * produces a client-authored message rather than echoing whatever the
 * server said about the account.
 */

function jsonResponse(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body)
	};
}

function recordingFetch(handler: (url: string, init: Parameters<FetchLike>[1]) => ReturnType<FetchLike>): {
	fetchFn: FetchLike;
	calls: Array<{ url: string; init: Parameters<FetchLike>[1] }>;
} {
	const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
	return {
		calls,
		fetchFn: (url, init) => {
			calls.push({ url, init });
			return handler(url, init);
		}
	};
}

describe('credentialsLookUsable', () => {
	it('accepts a plausible address with a password', () => {
		expect(credentialsLookUsable('someone@example.com', 'hunter2')).toBe(true);
	});

	it('refuses input that cannot possibly be an address, or an empty password', () => {
		expect(credentialsLookUsable('', 'pw')).toBe(false);
		expect(credentialsLookUsable('nope', 'pw')).toBe(false);
		expect(credentialsLookUsable('someone@example.com', '')).toBe(false);
		expect(credentialsLookUsable(undefined, undefined)).toBe(false);
	});
});

describe('PlatformAuthClient.signIn', () => {
	it('posts the credentials once and returns the session token', async () => {
		const { fetchFn, calls } = recordingFetch(async () =>
			jsonResponse(200, { access_token: 'session-token-value', user: { id: 'u1', email: 'a@b.co' } })
		);
		const client = new PlatformAuthClient({ apiUrl: 'https://api.example.com', fetchFn, timeoutMs: 0 });

		const result = await client.signIn(' a@b.co ', 'hunter2');

		expect(result.sessionToken).toBe('session-token-value');
		expect(result.userId).toBe('u1');
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.example.com/api/auth/login');
		expect(JSON.parse(calls[0].init.body)).toEqual({ email: 'a@b.co', password: 'hunter2' });
	});

	it('registers the session token with the logger so it can never be printed', async () => {
		const logger = createLogger({ sink: () => undefined });
		const { fetchFn } = recordingFetch(async () => jsonResponse(200, { access_token: 'super-secret-session' }));
		const client = new PlatformAuthClient({
			apiUrl: 'https://api.example.com',
			fetchFn,
			logger,
			timeoutMs: 0
		});

		await client.signIn('a@b.co', 'pw');

		expect(logger.redact('token is super-secret-session')).not.toContain('super-secret-session');
	});

	it('refuses obviously empty input without making a request', async () => {
		const { fetchFn, calls } = recordingFetch(async () => jsonResponse(200, {}));
		const client = new PlatformAuthClient({ apiUrl: 'https://api.example.com', fetchFn, timeoutMs: 0 });

		await expect(client.signIn('', '')).rejects.toBeInstanceOf(FleetClientError);
		expect(calls).toHaveLength(0);
	});

	it('turns a 401 into a client-authored message, never the server body', async () => {
		const { fetchFn } = recordingFetch(async () => jsonResponse(401, { message: 'no user with email a@b.co' }));
		const client = new PlatformAuthClient({ apiUrl: 'https://api.example.com', fetchFn, timeoutMs: 0 });

		await expect(client.signIn('a@b.co', 'pw')).rejects.toMatchObject({
			kind: 'unauthorized'
		});
		await expect(client.signIn('a@b.co', 'pw')).rejects.not.toMatchObject({
			message: expect.stringContaining('no user with email')
		});
	});

	it('fails loudly when the response carries no token', async () => {
		const { fetchFn } = recordingFetch(async () => jsonResponse(200, { user: { id: 'u1' } }));
		const client = new PlatformAuthClient({ apiUrl: 'https://api.example.com', fetchFn, timeoutMs: 0 });

		await expect(client.signIn('a@b.co', 'pw')).rejects.toMatchObject({ kind: 'malformed' });
	});
});

describe('PlatformAuthClient.createEnrollmentToken', () => {
	it('sends the session token as a bearer credential and returns the minted token', async () => {
		const { fetchFn, calls } = recordingFetch(async () => jsonResponse(201, { token: 'one-time-token' }));
		const client = new PlatformAuthClient({ apiUrl: 'https://api.example.com', fetchFn, timeoutMs: 0 });

		const token = await client.createEnrollmentToken('session-value', {
			name: '  My laptop ',
			kind: 'desktop-node'
		});

		expect(token).toBe('one-time-token');
		expect(calls[0].url).toBe('https://api.example.com/api/fleet/nodes/enrollment-token');
		expect(calls[0].init.headers.Authorization).toBe('Bearer session-value');
		expect(JSON.parse(calls[0].init.body)).toEqual({ name: 'My laptop', kind: 'desktop-node' });
	});

	it('protects the minted token immediately', async () => {
		const logger = createLogger({ sink: () => undefined });
		const { fetchFn } = recordingFetch(async () => jsonResponse(201, { token: 'mintedtokenvalue' }));
		const client = new PlatformAuthClient({
			apiUrl: 'https://api.example.com',
			fetchFn,
			logger,
			timeoutMs: 0
		});

		await client.createEnrollmentToken('session-value', { name: 'n', kind: 'node' });

		expect(logger.redact('token mintedtokenvalue')).not.toContain('mintedtokenvalue');
	});

	it('refuses a blank node name without calling the API', async () => {
		const { fetchFn, calls } = recordingFetch(async () => jsonResponse(201, { token: 't' }));
		const client = new PlatformAuthClient({ apiUrl: 'https://api.example.com', fetchFn, timeoutMs: 0 });

		await expect(client.createEnrollmentToken('s', { name: '   ', kind: 'node' })).rejects.toMatchObject({
			kind: 'invalid-request'
		});
		expect(calls).toHaveLength(0);
	});

	it('maps 403 to a message about permissions rather than credentials', async () => {
		const { fetchFn } = recordingFetch(async () => jsonResponse(403, {}));
		const client = new PlatformAuthClient({ apiUrl: 'https://api.example.com', fetchFn, timeoutMs: 0 });

		await expect(client.createEnrollmentToken('s', { name: 'n', kind: 'node' })).rejects.toMatchObject({
			kind: 'forbidden'
		});
	});
});

describe('sign-in never leaks the password', () => {
	it('keeps the password out of every logged line, including failures', async () => {
		const logger = createLogger({ sink: () => undefined });
		const lines: string[] = [];
		const spy = vi.spyOn(logger, 'redact');
		const { fetchFn } = recordingFetch(async () => {
			throw new Error('connect ECONNREFUSED');
		});
		const client = new PlatformAuthClient({
			apiUrl: 'https://api.example.com',
			fetchFn,
			logger,
			timeoutMs: 0
		});

		await expect(client.signIn('a@b.co', 'my-secret-password')).rejects.toBeInstanceOf(FleetClientError);

		for (const call of spy.mock.calls) {
			lines.push(String(call[0]));
		}
		expect(lines.join('\n')).not.toContain('my-secret-password');
	});
});
