import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfisicalSecretStorePlugin } from '../infisical-secret-store.plugin.js';

describe('InfisicalSecretStorePlugin (EW-742 P3.2 T20.8 plugin package)', () => {
	let plugin: InfisicalSecretStorePlugin;
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	const origToken = process.env.INFISICAL_TOKEN;
	const origHost = process.env.INFISICAL_HOST;

	beforeEach(() => {
		plugin = new InfisicalSecretStorePlugin();
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			throw new Error('fetch not mocked for this test');
		});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		process.env.INFISICAL_TOKEN = 'inf-test-token';
		delete process.env.INFISICAL_HOST;
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		warnSpy.mockRestore();
		process.env.INFISICAL_TOKEN = origToken;
		if (origHost === undefined) delete process.env.INFISICAL_HOST;
		else process.env.INFISICAL_HOST = origHost;
	});

	function mockResponse(opts: { ok?: boolean; status?: number; body?: unknown }): Response {
		const status = opts.status ?? (opts.ok === false ? 500 : 200);
		return {
			ok: opts.ok ?? (status >= 200 && status < 300),
			status,
			json: () => Promise.resolve(opts.body)
		} as unknown as Response;
	}

	it('declares manifest fields', () => {
		expect(plugin.id).toBe('secret-store-infisical');
		expect(plugin.category).toBe('secret-store-resolver');
		expect(plugin.capabilities).toContain('secret-store-resolve');
	});

	it('returns null for non-infisical: scheme', async () => {
		expect(await plugin.resolveSecret('vault:secret/foo')).toBeNull();
	});

	it('returns null for malformed pointer', async () => {
		expect(await plugin.resolveSecret('infisical:ws-abc')).toBeNull();
	});

	it('returns null when INFISICAL_TOKEN missing', async () => {
		delete process.env.INFISICAL_TOKEN;
		expect(await plugin.resolveSecret('infisical:ws-abc/prod/x')).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns null on fetch error', async () => {
		fetchSpy.mockRejectedValue(new Error('ETIMEDOUT'));
		expect(await plugin.resolveSecret('infisical:ws-abc/prod/x')).toBeNull();
	});

	it('returns null on HTTP 404', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
		expect(await plugin.resolveSecret('infisical:ws-abc/prod/x')).toBeNull();
	});

	it('returns null when .secrets missing', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: {} }));
		expect(await plugin.resolveSecret('infisical:ws-abc/prod/x')).toBeNull();
	});

	it('returns bag built from secrets array', async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				ok: true,
				body: {
					secrets: [
						{ secretKey: 'accessToken', secretValue: 'tr_dev_xxx' },
						{ secretKey: 'region', secretValue: 'us-east-1' }
					]
				}
			})
		);
		const result = await plugin.resolveSecret('infisical:ws-abc/prod/tenants/acme');
		expect(result).toEqual({ accessToken: 'tr_dev_xxx', region: 'us-east-1' });
	});

	it('returns empty bag for empty secrets array', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: [] } }));
		expect(await plugin.resolveSecret('infisical:ws-abc/prod/empty')).toEqual({});
	});

	it('uses INFISICAL_HOST when set', async () => {
		process.env.INFISICAL_HOST = 'https://infisical.corp/';
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: [] } }));
		await plugin.resolveSecret('infisical:ws-abc/prod/x');
		const [calledUrl] = fetchSpy.mock.calls[0] as [string];
		expect(calledUrl).toMatch(/^https:\/\/infisical\.corp\/api\/v3\/secrets\/raw\?/);
	});

	it('defaults to app.infisical.com', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: [] } }));
		await plugin.resolveSecret('infisical:ws-abc/prod/x');
		const [calledUrl] = fetchSpy.mock.calls[0] as [string];
		expect(calledUrl).toMatch(/^https:\/\/app\.infisical\.com\/api\/v3\/secrets\/raw\?/);
	});

	it('sends Bearer token in Authorization header', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: [] } }));
		await plugin.resolveSecret('infisical:ws-abc/prod/x');
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers['Authorization']).toBe('Bearer inf-test-token');
	});
});
