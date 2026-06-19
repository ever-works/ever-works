import { Logger } from '@nestjs/common';
import { VaultSecretStoreResolver } from '../vault-secret-store-resolver.service';

/**
 * EW-742 P3.2 follow-up — VaultSecretStoreResolver unit tests.
 *
 * Covers the contract's fail-open guarantee + KV v1/v2 envelope handling:
 *   - non-vault: scheme → null + warn
 *   - empty path → null + warn
 *   - VAULT_ADDR missing → null + warn
 *   - VAULT_TOKEN missing → null + warn
 *   - fetch network error → null + warn
 *   - HTTP 404 → null + warn
 *   - HTTP 500 → null + warn
 *   - non-JSON response → null + warn
 *   - response is JSON null → null + warn
 *   - response missing .data → null + warn
 *   - KV v2 envelope (data.data nested) → returns inner bag
 *   - KV v1 envelope (data flat) → returns outer .data
 *   - URL composition: trailing slash on VAULT_ADDR / leading slash on path
 */
describe('VaultSecretStoreResolver (EW-742 P3.2 follow-up)', () => {
    let resolver: VaultSecretStoreResolver;
    let fetchSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    const origAddr = process.env.VAULT_ADDR;
    const origToken = process.env.VAULT_TOKEN;

    beforeEach(() => {
        resolver = new VaultSecretStoreResolver();
        fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
            throw new Error('fetch not mocked for this test');
        });
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        process.env.VAULT_ADDR = 'https://vault.test:8200';
        process.env.VAULT_TOKEN = 'hvs.test-token';
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        warnSpy.mockRestore();
        process.env.VAULT_ADDR = origAddr;
        process.env.VAULT_TOKEN = origToken;
    });

    function mockResponse(opts: {
        ok?: boolean;
        status?: number;
        body?: unknown;
        notJson?: boolean;
    }): Response {
        const status = opts.status ?? (opts.ok === false ? 500 : 200);
        return {
            ok: opts.ok ?? (status >= 200 && status < 300),
            status,
            json: opts.notJson
                ? () => Promise.reject(new Error('Unexpected token in JSON'))
                : () => Promise.resolve(opts.body),
        } as unknown as Response;
    }

    it('returns null + warn for non-vault: scheme', async () => {
        const result = await resolver.resolve('inline:eyJhIjoxfQ==');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/pointer scheme "inline:"/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null + warn for empty path', async () => {
        const result = await resolver.resolve('vault:');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/empty path/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null + warn when VAULT_ADDR is missing', async () => {
        delete process.env.VAULT_ADDR;
        const result = await resolver.resolve('vault:secret/foo');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/VAULT_ADDR/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null + warn when VAULT_TOKEN is missing', async () => {
        delete process.env.VAULT_TOKEN;
        const result = await resolver.resolve('vault:secret/foo');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/VAULT_TOKEN/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null + warn on fetch network error', async () => {
        fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
        const result = await resolver.resolve('vault:secret/foo');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/fetch failed.*ECONNREFUSED/);
    });

    it('returns null + warn on HTTP 404', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
        const result = await resolver.resolve('vault:secret/missing');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/responded 404/);
    });

    it('returns null + warn on HTTP 500', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 500 }));
        const result = await resolver.resolve('vault:secret/foo');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/responded 500/);
    });

    it('returns null + warn on non-JSON response', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, notJson: true }));
        const result = await resolver.resolve('vault:secret/foo');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not JSON/);
    });

    it('returns null + warn when response is JSON null', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: null }));
        const result = await resolver.resolve('vault:secret/foo');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not a JSON object/);
    });

    it('returns null + warn when response missing .data field', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { errors: ['nope'] } }));
        const result = await resolver.resolve('vault:secret/foo');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/missing \.data/);
    });

    it('returns inner bag for KV v2 envelope (data.data nested)', async () => {
        const credentials = { accessToken: 'tr_dev_xxx', region: 'us-east-1' };
        fetchSpy.mockResolvedValue(
            mockResponse({
                ok: true,
                body: {
                    data: {
                        data: credentials,
                        metadata: { version: 3, created_time: '2026-06-19T00:00:00Z' },
                    },
                },
            }),
        );
        const result = await resolver.resolve('vault:secret/data/trigger');
        expect(result).toEqual(credentials);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns outer .data for KV v1 envelope (data flat)', async () => {
        const credentials = { username: 'foo', password: 'bar' };
        fetchSpy.mockResolvedValue(
            mockResponse({
                ok: true,
                body: { data: credentials },
            }),
        );
        const result = await resolver.resolve('vault:secret/legacy');
        expect(result).toEqual(credentials);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('composes URL correctly with trailing slash on VAULT_ADDR and leading slash on path', async () => {
        process.env.VAULT_ADDR = 'https://vault.test:8200/';
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { data: { x: 1 } } }));
        await resolver.resolve('vault:/secret/foo');
        const [calledUrl] = fetchSpy.mock.calls[0] as [string];
        expect(calledUrl).toBe('https://vault.test:8200/v1/secret/foo');
    });

    it('sends X-Vault-Token header', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { data: { x: 1 } } }));
        await resolver.resolve('vault:secret/foo');
        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['X-Vault-Token']).toBe('hvs.test-token');
    });
});
