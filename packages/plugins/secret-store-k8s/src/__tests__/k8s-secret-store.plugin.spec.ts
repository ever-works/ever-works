import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { K8sSecretStorePlugin } from '../k8s-secret-store.plugin.js';

vi.mock('node:fs/promises', () => ({
	readFile: vi.fn()
}));
import { readFile } from 'node:fs/promises';
const readFileMock = vi.mocked(readFile);

describe('K8sSecretStorePlugin (EW-742 P3.2 T20.7 plugin package)', () => {
	let plugin: K8sSecretStorePlugin;
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	const origHost = process.env.KUBERNETES_SERVICE_HOST;
	const origPort = process.env.KUBERNETES_SERVICE_PORT;

	beforeEach(() => {
		plugin = new K8sSecretStorePlugin();
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			throw new Error('fetch not mocked for this test');
		});
		readFileMock.mockReset();
		readFileMock.mockImplementation(((path: string) => {
			if (typeof path === 'string') {
				if (path.endsWith('/token')) return Promise.resolve('sa-bearer-token\n');
				if (path.endsWith('/ca.crt')) return Promise.resolve('-----BEGIN CERT-----\n...');
				if (path.endsWith('/namespace')) return Promise.resolve('ever-works\n');
			}
			return Promise.reject(new Error('ENOENT'));
		}) as never);
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
		process.env.KUBERNETES_SERVICE_PORT = '443';
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		warnSpy.mockRestore();
		process.env.KUBERNETES_SERVICE_HOST = origHost;
		process.env.KUBERNETES_SERVICE_PORT = origPort;
	});

	function mockResponse(opts: { ok?: boolean; status?: number; body?: unknown }): Response {
		const status = opts.status ?? (opts.ok === false ? 500 : 200);
		return {
			ok: opts.ok ?? (status >= 200 && status < 300),
			status,
			json: () => Promise.resolve(opts.body)
		} as unknown as Response;
	}

	function encodeSecretData(plain: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(plain)) {
			out[k] = Buffer.from(v, 'utf8').toString('base64');
		}
		return out;
	}

	describe('IPlugin contract', () => {
		it('declares the expected manifest fields', () => {
			expect(plugin.id).toBe('secret-store-k8s');
			expect(plugin.category).toBe('secret-store-resolver');
			expect(plugin.capabilities).toContain('secret-store-resolve');
		});
	});

	describe('resolveSecret()', () => {
		it('returns null + warn for non-k8s: scheme', async () => {
			const result = await plugin.resolveSecret('vault:secret/foo');
			expect(result).toBeNull();
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('returns null + warn for empty payload', async () => {
			const result = await plugin.resolveSecret('k8s:');
			expect(result).toBeNull();
		});

		it('returns null + warn when KUBERNETES_SERVICE_HOST is missing', async () => {
			delete process.env.KUBERNETES_SERVICE_HOST;
			const result = await plugin.resolveSecret('k8s:my-secret');
			expect(result).toBeNull();
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('returns null + warn for malformed pointer (trailing slash)', async () => {
			const result = await plugin.resolveSecret('k8s:my-ns/');
			expect(result).toBeNull();
		});

		it('returns null + warn when token file is unreadable', async () => {
			readFileMock.mockImplementation(((path: string) => {
				if (typeof path === 'string' && path.endsWith('/token')) {
					return Promise.reject(new Error('EACCES'));
				}
				return Promise.resolve('default');
			}) as never);
			const result = await plugin.resolveSecret('k8s:ever-works/my-secret');
			expect(result).toBeNull();
		});

		it('returns null + warn on HTTP 404', async () => {
			fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
			const result = await plugin.resolveSecret('k8s:ever-works/missing');
			expect(result).toBeNull();
		});

		it('returns null + warn on HTTP 401', async () => {
			fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 401 }));
			const result = await plugin.resolveSecret('k8s:ever-works/forbidden');
			expect(result).toBeNull();
		});

		it('returns base64-decoded bag on HTTP 200', async () => {
			const plain = { accessToken: 'tr_dev_xxx', region: 'us-east-1' };
			fetchSpy.mockResolvedValue(
				mockResponse({
					ok: true,
					body: { kind: 'Secret', data: encodeSecretData(plain) }
				})
			);
			const result = await plugin.resolveSecret('k8s:ever-works/tenant-acme');
			expect(result).toEqual(plain);
		});

		it('returns empty object when .data is missing', async () => {
			fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { kind: 'Secret' } }));
			const result = await plugin.resolveSecret('k8s:ever-works/empty');
			expect(result).toEqual({});
		});

		it('uses explicit namespace from pointer in URL', async () => {
			fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { data: encodeSecretData({ k: 'v' }) } }));
			await plugin.resolveSecret('k8s:custom-ns/my-secret');
			const [calledUrl] = fetchSpy.mock.calls[0] as [string];
			expect(calledUrl).toBe('https://10.0.0.1:443/api/v1/namespaces/custom-ns/secrets/my-secret');
		});

		it('uses default namespace from SA mount when pointer omits it', async () => {
			fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { data: encodeSecretData({ k: 'v' }) } }));
			await plugin.resolveSecret('k8s:my-secret');
			const [calledUrl] = fetchSpy.mock.calls[0] as [string];
			expect(calledUrl).toBe('https://10.0.0.1:443/api/v1/namespaces/ever-works/secrets/my-secret');
		});

		it('sends Bearer token in Authorization header', async () => {
			fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { data: encodeSecretData({ k: 'v' }) } }));
			await plugin.resolveSecret('k8s:ever-works/my-secret');
			const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
			const headers = init.headers as Record<string, string>;
			expect(headers['Authorization']).toBe('Bearer sa-bearer-token');
		});
	});
});
