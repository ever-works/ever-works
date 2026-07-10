import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AzureKvSecretStorePlugin } from '../azure-kv-secret-store.plugin.js';

describe('AzureKvSecretStorePlugin (EW-742 P3.2 T20.10c plugin package)', () => {
	let plugin: AzureKvSecretStorePlugin;
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	const origToken = process.env.AZURE_KV_TOKEN;

	beforeEach(() => {
		plugin = new AzureKvSecretStorePlugin();
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			throw new Error('fetch not mocked');
		});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		process.env.AZURE_KV_TOKEN = 'eyJ0eXAiOiJKV1Q.test';
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		warnSpy.mockRestore();
		process.env.AZURE_KV_TOKEN = origToken;
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
		expect(plugin.id).toBe('secret-store-azure-kv');
		expect(plugin.category).toBe('secret-store-resolver');
		expect(plugin.capabilities).toContain('secret-store-resolve');
	});

	it('returns null for non-azure-kv: scheme', async () => {
		expect(await plugin.resolveSecret('vault:secret/foo')).toBeNull();
	});

	it('returns null for malformed pointer', async () => {
		expect(await plugin.resolveSecret('azure-kv:my-vault')).toBeNull();
	});

	it('returns null when AZURE_KV_TOKEN missing', async () => {
		delete process.env.AZURE_KV_TOKEN;
		expect(await plugin.resolveSecret('azure-kv:my-vault/my-secret')).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns null on fetch error', async () => {
		fetchSpy.mockRejectedValue(new Error('ETIMEDOUT'));
		expect(await plugin.resolveSecret('azure-kv:my-vault/x')).toBeNull();
	});

	it('returns null on HTTP 404', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
		expect(await plugin.resolveSecret('azure-kv:my-vault/missing')).toBeNull();
	});

	it('returns null on HTTP 401', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 401 }));
		expect(await plugin.resolveSecret('azure-kv:my-vault/forbidden')).toBeNull();
	});

	it('returns null when response.value missing', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { id: 'x' } }));
		expect(await plugin.resolveSecret('azure-kv:my-vault/x')).toBeNull();
	});

	it('returns parsed bag from JSON-encoded value', async () => {
		const credentials = { accessToken: 'tr_dev_xxx', region: 'westus' };
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { value: JSON.stringify(credentials) } }));
		expect(await plugin.resolveSecret('azure-kv:my-vault/tenants-acme')).toEqual(credentials);
	});

	it('wraps non-JSON string value as { value }', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { value: 'simple-secret-string' } }));
		expect(await plugin.resolveSecret('azure-kv:my-vault/x')).toEqual({
			value: 'simple-secret-string'
		});
	});

	it('composes URL with vaultName + secretName + api-version', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { value: '{"k":"v"}' } }));
		await plugin.resolveSecret('azure-kv:my-vault/my-secret');
		const [calledUrl] = fetchSpy.mock.calls[0] as [string];
		expect(calledUrl).toBe('https://my-vault.vault.azure.net/secrets/my-secret?api-version=7.4');
	});

	it('sends Bearer token in Authorization header', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { value: '{"k":"v"}' } }));
		await plugin.resolveSecret('azure-kv:my-vault/x');
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers['Authorization']).toBe('Bearer eyJ0eXAiOiJKV1Q.test');
	});
});
