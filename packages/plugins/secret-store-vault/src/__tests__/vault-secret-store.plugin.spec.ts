import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultSecretStorePlugin } from '../vault-secret-store.plugin.js';

describe('VaultSecretStorePlugin (EW-742 P3.2 plugin package)', () => {
	let plugin: VaultSecretStorePlugin;
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	const origAddr = process.env.VAULT_ADDR;
	const origToken = process.env.VAULT_TOKEN;

	beforeEach(() => {
		plugin = new VaultSecretStorePlugin();
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			throw new Error('fetch not mocked for this test');
		});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		process.env.VAULT_ADDR = 'https://vault.test:8200';
		process.env.VAULT_TOKEN = 'hvs.test-token';
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		warnSpy.mockRestore();
		process.env.VAULT_ADDR = origAddr;
		process.env.VAULT_TOKEN = origToken;
	});

	function mockResponse(opts: { ok?: boolean; status?: number; body?: unknown; notJson?: boolean }): Response {
		const status = opts.status ?? (opts.ok === false ? 500 : 200);
		return {
			ok: opts.ok ?? (status >= 200 && status < 300),
			status,
			json: opts.notJson
				? () => Promise.reject(new Error('Unexpected token in JSON'))
				: () => Promise.resolve(opts.body)
		} as unknown as Response;
	}

	describe('IPlugin contract', () => {
		it('declares the expected manifest fields', () => {
			expect(plugin.id).toBe('secret-store-vault');
			expect(plugin.name).toBe('HashiCorp Vault Secret Store');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('secret-store-resolver');
			expect(plugin.capabilities).toContain('secret-store-resolve');
			expect(plugin.settingsSchema.type).toBe('object');
		});

		it('lifecycle hooks are no-ops without crashing', async () => {
			const ctx = { logger: { warn: vi.fn() } } as never;
			await plugin.onLoad(ctx);
			await plugin.onUnload();
		});
	});

	describe('resolveSecret()', () => {
		it('returns null + warn for non-vault: scheme', async () => {
			const result = await plugin.resolveSecret('inline:eyJhIjoxfQ==');
			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalled();
		});

		it('returns null + warn for empty path', async () => {
			const result = await plugin.resolveSecret('vault:');
			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalled();
		});

		it('returns null + warn when VAULT_ADDR is missing', async () => {
			delete process.env.VAULT_ADDR;
			const result = await plugin.resolveSecret('vault:secret/foo');
			expect(result).toBeNull();
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('returns null + warn when VAULT_TOKEN is missing', async () => {
			delete process.env.VAULT_TOKEN;
			const result = await plugin.resolveSecret('vault:secret/foo');
			expect(result).toBeNull();
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('returns null + warn on fetch network error', async () => {
			fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
			const result = await plugin.resolveSecret('vault:secret/foo');
			expect(result).toBeNull();
		});

		it('returns null + warn on HTTP 404', async () => {
			fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
			const result = await plugin.resolveSecret('vault:secret/missing');
			expect(result).toBeNull();
		});

		it('returns null + warn on non-JSON response', async () => {
			fetchSpy.mockResolvedValue(mockResponse({ ok: true, notJson: true }));
			const result = await plugin.resolveSecret('vault:secret/foo');
			expect(result).toBeNull();
		});

		it('returns null + warn when response missing .data field', async () => {
			fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { errors: ['nope'] } }));
			const result = await plugin.resolveSecret('vault:secret/foo');
			expect(result).toBeNull();
		});

		it('returns inner bag for KV v2 envelope (data.data nested)', async () => {
			const credentials = { accessToken: 'tr_dev_xxx', region: 'us-east-1' };
			fetchSpy.mockResolvedValue(
				mockResponse({
					ok: true,
					body: {
						data: {
							data: credentials,
							metadata: { version: 3, created_time: '2026-06-19T00:00:00Z' }
						}
					}
				})
			);
			const result = await plugin.resolveSecret('vault:secret/data/trigger');
			expect(result).toEqual(credentials);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('returns outer .data for KV v1 envelope (data flat)', async () => {
			const credentials = { username: 'foo', password: 'bar' };
			fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { data: credentials } }));
			const result = await plugin.resolveSecret('vault:secret/legacy');
			expect(result).toEqual(credentials);
		});

		it('sends X-Vault-Token header and composes URL with trailing-slash tolerance', async () => {
			process.env.VAULT_ADDR = 'https://vault.test:8200/';
			fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { data: { x: 1 } } }));
			await plugin.resolveSecret('vault:/secret/foo');
			const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
			expect(calledUrl).toBe('https://vault.test:8200/v1/secret/foo');
			const headers = init.headers as Record<string, string>;
			expect(headers['X-Vault-Token']).toBe('hvs.test-token');
		});
	});
});
