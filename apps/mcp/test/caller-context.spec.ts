import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallerContextService } from '../src/context/caller-context.service.js';
import { CallerContextMiddleware } from '../src/context/caller-context.middleware.js';
import { ApiClientService } from '../src/api-client/api-client.service.js';
import { McpConfigService } from '../src/config/mcp-config.service.js';

describe('CallerContextService', () => {
	it('returns null outside any frame — the stdio transport has no HTTP request', () => {
		const ctx = new CallerContextService();
		expect(ctx.getCallerJwt()).toBeNull();
	});

	it('is a no-op outside a frame, so a token can never escape the request that produced it', () => {
		const ctx = new CallerContextService();
		expect(() => ctx.setCallerJwt('orphan-token')).not.toThrow();
		expect(ctx.getCallerJwt()).toBeNull();
	});

	it('starts each frame empty rather than inheriting the previous caller', () => {
		const ctx = new CallerContextService();
		ctx.run(() => ctx.setCallerJwt('first'));
		ctx.run(() => {
			expect(ctx.getCallerJwt()).toBeNull();
		});
	});

	it('lets a later reader in the same frame see what the guard seeded', () => {
		const ctx = new CallerContextService();
		ctx.run(() => {
			expect(ctx.getCallerJwt()).toBeNull();
			ctx.setCallerJwt('seeded-by-guard');
			expect(ctx.getCallerJwt()).toBe('seeded-by-guard');
		});
	});

	it('keeps interleaved async frames isolated from one another', async () => {
		const ctx = new CallerContextService();
		const observed: Array<string | null> = [];

		// Deliberately interleave: each frame yields the event loop *between*
		// seeding and reading, so a shared mutable field would cross over.
		const caller = (token: string, delay: number) =>
			new Promise<void>((resolve) => {
				ctx.run(async () => {
					ctx.setCallerJwt(token);
					await new Promise((r) => setTimeout(r, delay));
					observed.push(ctx.getCallerJwt());
					resolve();
				});
			});

		await Promise.all([caller('token-a', 20), caller('token-b', 5), caller('token-c', 12)]);

		expect(observed.sort()).toEqual(['token-a', 'token-b', 'token-c']);
	});

	it('survives many concurrent frames without cross-talk', async () => {
		const ctx = new CallerContextService();
		const results = await Promise.all(
			Array.from(
				{ length: 200 },
				(_, i) =>
					new Promise<string | null>((resolve) =>
						ctx.run(async () => {
							ctx.setCallerJwt(`token-${i}`);
							await new Promise((r) => setTimeout(r, i % 7));
							resolve(ctx.getCallerJwt());
						})
					)
			)
		);
		expect(results).toEqual(Array.from({ length: 200 }, (_, i) => `token-${i}`));
	});
});

describe('CallerContextMiddleware', () => {
	it('wraps next() so downstream work runs inside the frame', () => {
		const ctx = new CallerContextService();
		const middleware = new CallerContextMiddleware(ctx);
		let insideFrame = false;

		middleware.use({}, {}, () => {
			// A guard running here can seed; a service running later can read.
			ctx.setCallerJwt('from-guard');
			insideFrame = ctx.getCallerJwt() === 'from-guard';
		});

		expect(insideFrame).toBe(true);
		// ...and the frame closes with the request.
		expect(ctx.getCallerJwt()).toBeNull();
	});
});

describe('ApiClientService credential selection', () => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			headers: new Headers({ 'content-type': 'application/json' }),
			json: () => Promise.resolve({})
		});
		globalThis.fetch = fetchSpy;
	});

	afterEach(() => vi.restoreAllMocks());

	const configWith = (apiKey: string | null) =>
		({ apiUrl: 'http://upstream.test/api', apiKey, httpPort: 3200, transport: 'stdio' }) as McpConfigService;

	function headersOfLastCall(): Record<string, string> {
		return fetchSpy.mock.calls.at(-1)![1].headers as Record<string, string>;
	}

	it('forwards the caller JWT as a Bearer token when a frame carries one', async () => {
		const ctx = new CallerContextService();
		const client = new ApiClientService(configWith('shared-platform-key'), ctx);

		await new Promise<void>((resolve) =>
			ctx.run(async () => {
				ctx.setCallerJwt('caller-jwt');
				await client.request('GET', '/works');
				resolve();
			})
		);

		expect(headersOfLastCall()['Authorization']).toBe('Bearer caller-jwt');
		// The caller's identity must REPLACE the platform key, not accompany it.
		expect(headersOfLastCall()['x-api-key']).toBeUndefined();
	});

	it('falls back to the shared key with no frame at all (stdio transport)', async () => {
		const client = new ApiClientService(configWith('shared-platform-key'), new CallerContextService());
		await client.request('GET', '/works');
		expect(headersOfLastCall()['x-api-key']).toBe('shared-platform-key');
		expect(headersOfLastCall()['Authorization']).toBeUndefined();
	});

	it('sends NO credential in per-user-jwt mode when the caller identity is missing', async () => {
		// per-user-jwt mode leaves `apiKey` null on the config. A missing JWT
		// must stay a rejection by the upstream — quietly substituting a
		// service key here would turn an auth bug into privilege escalation.
		const ctx = new CallerContextService();
		const client = new ApiClientService(configWith(null), ctx);

		await new Promise<void>((resolve) =>
			ctx.run(async () => {
				await client.request('GET', '/works');
				resolve();
			})
		);

		expect(headersOfLastCall()['Authorization']).toBeUndefined();
		expect(headersOfLastCall()['x-api-key']).toBeUndefined();
	});
});
