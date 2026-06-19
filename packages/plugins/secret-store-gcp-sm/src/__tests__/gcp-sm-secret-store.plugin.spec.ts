import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GcpSmSecretStorePlugin } from '../gcp-sm-secret-store.plugin.js';

describe('GcpSmSecretStorePlugin (EW-742 P3.2 T20.10b plugin package)', () => {
	let plugin: GcpSmSecretStorePlugin;
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	const origToken = process.env.GCP_ACCESS_TOKEN;

	beforeEach(() => {
		plugin = new GcpSmSecretStorePlugin();
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			throw new Error('fetch not mocked');
		});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		process.env.GCP_ACCESS_TOKEN = 'ya29.a0Test-Token';
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		warnSpy.mockRestore();
		process.env.GCP_ACCESS_TOKEN = origToken;
	});

	function mockResponse(opts: { ok?: boolean; status?: number; body?: unknown }): Response {
		const status = opts.status ?? (opts.ok === false ? 500 : 200);
		return {
			ok: opts.ok ?? (status >= 200 && status < 300),
			status,
			json: () => Promise.resolve(opts.body)
		} as unknown as Response;
	}

	function b64(s: string): string {
		return Buffer.from(s, 'utf8').toString('base64');
	}

	it('declares manifest fields', () => {
		expect(plugin.id).toBe('secret-store-gcp-sm');
		expect(plugin.category).toBe('secret-store-resolver');
		expect(plugin.capabilities).toContain('secret-store-resolve');
	});

	it('returns null for non-gcp-sm: scheme', async () => {
		expect(await plugin.resolveSecret('vault:secret/foo')).toBeNull();
	});

	it('returns null for malformed pointer', async () => {
		expect(await plugin.resolveSecret('gcp-sm:my-project')).toBeNull();
	});

	it('returns null when GCP_ACCESS_TOKEN missing', async () => {
		delete process.env.GCP_ACCESS_TOKEN;
		expect(await plugin.resolveSecret('gcp-sm:my-project/my-secret')).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns null on fetch error', async () => {
		fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
		expect(await plugin.resolveSecret('gcp-sm:my-project/x')).toBeNull();
	});

	it('returns null on HTTP 404', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
		expect(await plugin.resolveSecret('gcp-sm:my-project/missing')).toBeNull();
	});

	it('returns null on HTTP 403', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 403 }));
		expect(await plugin.resolveSecret('gcp-sm:my-project/forbidden')).toBeNull();
	});

	it('returns null when payload.data missing', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { name: 'x' } }));
		expect(await plugin.resolveSecret('gcp-sm:my-project/x')).toBeNull();
	});

	it('returns null when payload.data is not valid JSON after base64 decode', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { payload: { data: b64('not json') } } }));
		expect(await plugin.resolveSecret('gcp-sm:my-project/x')).toBeNull();
	});

	it('returns parsed bag from base64-encoded JSON payload', async () => {
		const credentials = { accessToken: 'tr_dev_xxx', region: 'us-central1' };
		fetchSpy.mockResolvedValue(
			mockResponse({ ok: true, body: { payload: { data: b64(JSON.stringify(credentials)) } } })
		);
		expect(await plugin.resolveSecret('gcp-sm:my-project/tenants/acme')).toEqual(credentials);
	});

	it('composes URL with project + secretName URL-encoded', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { payload: { data: b64('{"k":"v"}') } } }));
		await plugin.resolveSecret('gcp-sm:my-project/my-secret');
		const [calledUrl] = fetchSpy.mock.calls[0] as [string];
		expect(calledUrl).toBe(
			'https://secretmanager.googleapis.com/v1/projects/my-project/secrets/my-secret/versions/latest:access'
		);
	});

	it('sends Bearer token in Authorization header', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { payload: { data: b64('{"k":"v"}') } } }));
		await plugin.resolveSecret('gcp-sm:my-project/x');
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers['Authorization']).toBe('Bearer ya29.a0Test-Token');
	});
});
