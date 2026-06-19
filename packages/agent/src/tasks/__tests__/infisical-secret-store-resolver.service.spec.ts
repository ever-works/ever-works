import { Logger } from '@nestjs/common';
import { InfisicalSecretStoreResolver } from '../infisical-secret-store-resolver.service';

/**
 * EW-742 P3.2 follow-up — InfisicalSecretStoreResolver unit tests.
 */
describe('InfisicalSecretStoreResolver (EW-742 P3.2 follow-up)', () => {
    let resolver: InfisicalSecretStoreResolver;
    let fetchSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    const origToken = process.env.INFISICAL_TOKEN;
    const origHost = process.env.INFISICAL_HOST;

    beforeEach(() => {
        resolver = new InfisicalSecretStoreResolver();
        fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
            throw new Error('fetch not mocked for this test');
        });
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
            json: () => Promise.resolve(opts.body),
        } as unknown as Response;
    }

    it('returns null + warn for non-infisical: scheme', async () => {
        const result = await resolver.resolve('vault:secret/foo');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/scheme "vault:"/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null + warn for malformed pointer (no workspace)', async () => {
        const result = await resolver.resolve('infisical:');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/malformed pointer/);
    });

    it('returns null + warn for malformed pointer (workspace but no env)', async () => {
        const result = await resolver.resolve('infisical:ws-abc');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/malformed pointer/);
    });

    it('returns null + warn when INFISICAL_TOKEN is missing', async () => {
        delete process.env.INFISICAL_TOKEN;
        const result = await resolver.resolve('infisical:ws-abc/prod/tenants/acme');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/INFISICAL_TOKEN/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null + warn on fetch network error', async () => {
        fetchSpy.mockRejectedValue(new Error('ETIMEDOUT'));
        const result = await resolver.resolve('infisical:ws-abc/prod/tenants/acme');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/fetch failed.*ETIMEDOUT/);
    });

    it('returns null + warn on HTTP 404', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
        const result = await resolver.resolve('infisical:ws-abc/prod/missing');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/responded 404/);
    });

    it('returns null + warn on non-JSON response', async () => {
        fetchSpy.mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.reject(new Error('Unexpected token')),
        } as unknown as Response);
        const result = await resolver.resolve('infisical:ws-abc/prod/tenants/acme');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not JSON/);
    });

    it('returns null + warn when response missing .secrets array', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { foo: 'bar' } }));
        const result = await resolver.resolve('infisical:ws-abc/prod/tenants/acme');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/missing \.secrets/);
    });

    it('returns bag built from secrets array on success', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({
                ok: true,
                body: {
                    secrets: [
                        { secretKey: 'accessToken', secretValue: 'tr_dev_xxx' },
                        { secretKey: 'region', secretValue: 'us-east-1' },
                    ],
                },
            }),
        );
        const result = await resolver.resolve('infisical:ws-abc/prod/tenants/acme');
        expect(result).toEqual({ accessToken: 'tr_dev_xxx', region: 'us-east-1' });
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('skips non-string keys/values in the secrets array', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({
                ok: true,
                body: {
                    secrets: [
                        { secretKey: 'good', secretValue: 'yes' },
                        { secretKey: 42, secretValue: 'bad-key' },
                        { secretKey: 'bad-val', secretValue: { nested: 'object' } },
                        null,
                        'malformed',
                    ],
                },
            }),
        );
        const result = await resolver.resolve('infisical:ws-abc/prod/tenants/acme');
        expect(result).toEqual({ good: 'yes' });
    });

    it('returns empty object when secrets array is empty (folder exists but no entries)', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: [] } }));
        const result = await resolver.resolve('infisical:ws-abc/prod/tenants/acme');
        expect(result).toEqual({});
    });

    it('uses INFISICAL_HOST when set for self-hosted instances', async () => {
        process.env.INFISICAL_HOST = 'https://infisical.internal.corp/';
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: [] } }));
        await resolver.resolve('infisical:ws-abc/prod/tenants/acme');
        const [calledUrl] = fetchSpy.mock.calls[0] as [string];
        expect(calledUrl).toMatch(/^https:\/\/infisical\.internal\.corp\/api\/v3\/secrets\/raw\?/);
    });

    it('defaults INFISICAL_HOST to app.infisical.com when unset', async () => {
        delete process.env.INFISICAL_HOST;
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: [] } }));
        await resolver.resolve('infisical:ws-abc/prod/tenants/acme');
        const [calledUrl] = fetchSpy.mock.calls[0] as [string];
        expect(calledUrl).toMatch(/^https:\/\/app\.infisical\.com\/api\/v3\/secrets\/raw\?/);
    });

    it('URL-encodes path components and includes them as query params', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: [] } }));
        await resolver.resolve('infisical:ws-abc-123/prod/tenants/acme');
        const [calledUrl] = fetchSpy.mock.calls[0] as [string];
        expect(calledUrl).toContain('workspaceId=ws-abc-123');
        expect(calledUrl).toContain('environment=prod');
        expect(calledUrl).toContain('secretPath=%2Ftenants%2Facme');
    });

    it('sends Bearer token in Authorization header', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: [] } }));
        await resolver.resolve('infisical:ws-abc/prod/tenants/acme');
        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer inf-test-token');
    });
});
