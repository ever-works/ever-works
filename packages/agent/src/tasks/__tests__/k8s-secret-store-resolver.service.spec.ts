import { Logger } from '@nestjs/common';
import { K8sSecretStoreResolver } from '../k8s-secret-store-resolver.service';

jest.mock('fs/promises', () => ({
    readFile: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsPromises = require('fs/promises') as { readFile: jest.Mock };

/**
 * EW-742 P3.2 follow-up — K8sSecretStoreResolver unit tests.
 *
 * Covers:
 *   - non-k8s: scheme → null + warn
 *   - empty payload → null + warn
 *   - KUBERNETES_SERVICE_HOST missing → null + warn
 *   - malformed ns/name (e.g. trailing slash) → null + warn
 *   - service account token file unreadable → null + warn
 *   - HTTP 404 → null + warn
 *   - HTTP 401 → null + warn
 *   - HTTP 200 with valid Secret → returns base64-decoded bag
 *   - Empty .data field → returns empty object
 *   - .data non-object → null + warn
 *   - explicit namespace pointer (k8s:my-ns/my-secret) → used in URL
 *   - default namespace pointer (k8s:my-secret) → reads namespace from SA mount
 */
describe('K8sSecretStoreResolver (EW-742 P3.2 follow-up)', () => {
    let resolver: K8sSecretStoreResolver;
    let fetchSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    const origHost = process.env.KUBERNETES_SERVICE_HOST;
    const origPort = process.env.KUBERNETES_SERVICE_PORT;

    beforeEach(() => {
        resolver = new K8sSecretStoreResolver();
        fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
            throw new Error('fetch not mocked for this test');
        });
        fsPromises.readFile.mockReset();
        fsPromises.readFile.mockImplementation((path: string) => {
            if (typeof path === 'string') {
                if (path.endsWith('/token')) return Promise.resolve('sa-bearer-token\n');
                if (path.endsWith('/ca.crt')) return Promise.resolve('-----BEGIN CERT-----\n...');
                if (path.endsWith('/namespace')) return Promise.resolve('ever-works\n');
            }
            return Promise.reject(new Error('ENOENT'));
        });
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
            json: () => Promise.resolve(opts.body),
        } as unknown as Response;
    }

    function encodeSecretData(plain: Record<string, string>): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(plain)) {
            out[k] = Buffer.from(v, 'utf8').toString('base64');
        }
        return out;
    }

    it('returns null + warn for non-k8s: scheme', async () => {
        const result = await resolver.resolve('vault:secret/foo');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/scheme "vault:"/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null + warn for empty payload', async () => {
        const result = await resolver.resolve('k8s:');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/empty payload/);
    });

    it('returns null + warn when KUBERNETES_SERVICE_HOST is missing', async () => {
        delete process.env.KUBERNETES_SERVICE_HOST;
        const result = await resolver.resolve('k8s:my-secret');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/KUBERNETES_SERVICE_HOST/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null + warn for malformed ns/name (trailing slash)', async () => {
        const result = await resolver.resolve('k8s:my-ns/');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/malformed pointer/);
    });

    it('returns null + warn when token file is unreadable', async () => {
        fsPromises.readFile.mockImplementation((path: string) => {
            if (typeof path === 'string' && path.endsWith('/token')) {
                return Promise.reject(new Error('EACCES: permission denied'));
            }
            return Promise.resolve('default');
        });
        const result = await resolver.resolve('k8s:ever-works/my-secret');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls.some((c) => /failed to read token/.test(c[0] as string))).toBe(
            true,
        );
    });

    it('returns null + warn on HTTP 404', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
        const result = await resolver.resolve('k8s:ever-works/missing');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls.some((c) => /responded 404/.test(c[0] as string))).toBe(true);
    });

    it('returns null + warn on HTTP 401', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 401 }));
        const result = await resolver.resolve('k8s:ever-works/forbidden');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls.some((c) => /responded 401/.test(c[0] as string))).toBe(true);
    });

    it('returns base64-decoded bag on HTTP 200 with valid Secret', async () => {
        const plain = { accessToken: 'tr_dev_xxx', region: 'us-east-1' };
        fetchSpy.mockResolvedValue(
            mockResponse({
                ok: true,
                body: {
                    kind: 'Secret',
                    metadata: { name: 'tenant-acme-trigger', namespace: 'ever-works' },
                    data: encodeSecretData(plain),
                    type: 'Opaque',
                },
            }),
        );
        const result = await resolver.resolve('k8s:ever-works/tenant-acme-trigger');
        expect(result).toEqual(plain);
    });

    it('returns empty object when .data is missing/null', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({
                ok: true,
                body: { kind: 'Secret', metadata: { name: 'empty' } },
            }),
        );
        const result = await resolver.resolve('k8s:ever-works/empty');
        expect(result).toEqual({});
    });

    it('returns null + warn when .data is not an object', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({ ok: true, body: { kind: 'Secret', data: 'not-an-object' } }),
        );
        const result = await resolver.resolve('k8s:ever-works/weird');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls.some((c) => /\.data is not an object/.test(c[0] as string))).toBe(
            true,
        );
    });

    it('uses explicit namespace from pointer in the URL', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({ ok: true, body: { data: encodeSecretData({ k: 'v' }) } }),
        );
        await resolver.resolve('k8s:custom-ns/my-secret');
        const [calledUrl] = fetchSpy.mock.calls[0] as [string];
        expect(calledUrl).toBe(
            'https://10.0.0.1:443/api/v1/namespaces/custom-ns/secrets/my-secret',
        );
    });

    it('uses default namespace from SA mount when pointer omits it', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({ ok: true, body: { data: encodeSecretData({ k: 'v' }) } }),
        );
        await resolver.resolve('k8s:my-secret');
        const [calledUrl] = fetchSpy.mock.calls[0] as [string];
        // SA mount default namespace is 'ever-works' per beforeEach mock.
        expect(calledUrl).toBe(
            'https://10.0.0.1:443/api/v1/namespaces/ever-works/secrets/my-secret',
        );
    });

    it('sends Bearer token from SA mount in Authorization header', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({ ok: true, body: { data: encodeSecretData({ k: 'v' }) } }),
        );
        await resolver.resolve('k8s:ever-works/my-secret');
        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer sa-bearer-token');
    });
});
