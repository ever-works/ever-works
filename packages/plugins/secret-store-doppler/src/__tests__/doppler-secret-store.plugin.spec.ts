import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DopplerSecretStorePlugin } from '../doppler-secret-store.plugin.js';

describe('DopplerSecretStorePlugin (EW-742 P3.2 T20.9 plugin package)', () => {
	let plugin: DopplerSecretStorePlugin;
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	const origToken = process.env.DOPPLER_TOKEN;

	beforeEach(() => {
		plugin = new DopplerSecretStorePlugin();
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			throw new Error('fetch not mocked for this test');
		});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		process.env.DOPPLER_TOKEN = 'dp.st.test-token';
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		warnSpy.mockRestore();
		process.env.DOPPLER_TOKEN = origToken;
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
		expect(plugin.id).toBe('secret-store-doppler');
		expect(plugin.category).toBe('secret-store-resolver');
		expect(plugin.capabilities).toContain('secret-store-resolve');
	});

	it('returns null for non-doppler: scheme', async () => {
		expect(await plugin.resolveSecret('vault:secret/foo')).toBeNull();
	});

	it('returns null for malformed pointer', async () => {
		expect(await plugin.resolveSecret('doppler:ever-works')).toBeNull();
	});

	it('returns null when DOPPLER_TOKEN missing', async () => {
		delete process.env.DOPPLER_TOKEN;
		expect(await plugin.resolveSecret('doppler:ever-works/prd_acme')).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns null on fetch error', async () => {
		fetchSpy.mockRejectedValue(new Error('ENOTFOUND'));
		expect(await plugin.resolveSecret('doppler:ever-works/prd_acme')).toBeNull();
	});

	it('returns null on HTTP 404', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
		expect(await plugin.resolveSecret('doppler:ever-works/missing')).toBeNull();
	});

	it('returns empty bag when .secrets is missing', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { project: 'ever-works' } }));
		expect(await plugin.resolveSecret('doppler:ever-works/prd_acme')).toEqual({});
	});

	it('returns bag using .raw precedence', async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				ok: true,
				body: {
					secrets: {
						ACCESS_TOKEN: { raw: 'tr_dev_xxx', computed: 'tr_dev_xxx' },
						REGION: { raw: 'us-east-1' }
					}
				}
			})
		);
		const result = await plugin.resolveSecret('doppler:ever-works/prd_acme');
		expect(result).toEqual({ ACCESS_TOKEN: 'tr_dev_xxx', REGION: 'us-east-1' });
	});

	it('falls back to .computed when .raw missing', async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				ok: true,
				body: { secrets: { TEMPLATED: { computed: 'expanded' } } }
			})
		);
		expect(await plugin.resolveSecret('doppler:ever-works/prd_acme')).toEqual({
			TEMPLATED: 'expanded'
		});
	});

	it('composes URL with project + config query params', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: {} } }));
		await plugin.resolveSecret('doppler:ever-works/prd_tenants_acme');
		const [calledUrl] = fetchSpy.mock.calls[0] as [string];
		expect(calledUrl).toBe(
			'https://api.doppler.com/v3/configs/config/secrets?project=ever-works&config=prd_tenants_acme'
		);
	});

	it('URL-encodes project/config slugs', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: {} } }));
		await plugin.resolveSecret('doppler:project with space/cfg-special&');
		const [calledUrl] = fetchSpy.mock.calls[0] as [string];
		expect(calledUrl).toContain('project=project%20with%20space');
		expect(calledUrl).toContain('config=cfg-special%26');
	});

	it('sends Bearer token in Authorization header', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: {} } }));
		await plugin.resolveSecret('doppler:ever-works/prd_acme');
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers['Authorization']).toBe('Bearer dp.st.test-token');
	});
});
