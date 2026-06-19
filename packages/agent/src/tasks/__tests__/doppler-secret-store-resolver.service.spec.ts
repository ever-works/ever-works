import { Logger } from '@nestjs/common';
import { DopplerSecretStoreResolver } from '../doppler-secret-store-resolver.service';

/**
 * EW-742 P3.2 follow-up — DopplerSecretStoreResolver unit tests.
 */
describe('DopplerSecretStoreResolver (EW-742 P3.2 follow-up)', () => {
    let resolver: DopplerSecretStoreResolver;
    let fetchSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    const origToken = process.env.DOPPLER_TOKEN;

    beforeEach(() => {
        resolver = new DopplerSecretStoreResolver();
        fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
            throw new Error('fetch not mocked for this test');
        });
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
            json: () => Promise.resolve(opts.body),
        } as unknown as Response;
    }

    it('returns null + warn for non-doppler: scheme', async () => {
        const result = await resolver.resolve('vault:secret/foo');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/scheme "vault:"/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null + warn for malformed pointer (no slash)', async () => {
        const result = await resolver.resolve('doppler:ever-works');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/malformed pointer/);
    });

    it('returns null + warn for malformed pointer (empty config)', async () => {
        const result = await resolver.resolve('doppler:ever-works/');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/malformed pointer/);
    });

    it('returns null + warn when DOPPLER_TOKEN is missing', async () => {
        delete process.env.DOPPLER_TOKEN;
        const result = await resolver.resolve('doppler:ever-works/prd_acme');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/DOPPLER_TOKEN/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null + warn on fetch network error', async () => {
        fetchSpy.mockRejectedValue(new Error('ENOTFOUND'));
        const result = await resolver.resolve('doppler:ever-works/prd_acme');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/fetch failed.*ENOTFOUND/);
    });

    it('returns null + warn on HTTP 404', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
        const result = await resolver.resolve('doppler:ever-works/missing');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/responded 404/);
    });

    it('returns null + warn on HTTP 401', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 401 }));
        const result = await resolver.resolve('doppler:ever-works/prd_acme');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/responded 401/);
    });

    it('returns null + warn on non-JSON response', async () => {
        fetchSpy.mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.reject(new Error('Unexpected token')),
        } as unknown as Response);
        const result = await resolver.resolve('doppler:ever-works/prd_acme');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not JSON/);
    });

    it('returns empty bag when .secrets is null/missing', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { project: 'ever-works' } }));
        const result = await resolver.resolve('doppler:ever-works/prd_acme');
        expect(result).toEqual({});
    });

    it('returns null + warn when .secrets is not an object', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: 'not-an-object' } }));
        const result = await resolver.resolve('doppler:ever-works/prd_acme');
        expect(result).toBeNull();
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/\.secrets is not an object/);
    });

    it('returns bag built from secrets object on success (uses .raw)', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({
                ok: true,
                body: {
                    secrets: {
                        ACCESS_TOKEN: { raw: 'tr_dev_xxx', computed: 'tr_dev_xxx' },
                        REGION: { raw: 'us-east-1', computed: 'us-east-1' },
                    },
                },
            }),
        );
        const result = await resolver.resolve('doppler:ever-works/prd_acme');
        expect(result).toEqual({ ACCESS_TOKEN: 'tr_dev_xxx', REGION: 'us-east-1' });
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('falls back to .computed when .raw is missing', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({
                ok: true,
                body: {
                    secrets: {
                        TEMPLATED: { computed: 'expanded-value' },
                        BOTH: { raw: 'r', computed: 'c' },
                    },
                },
            }),
        );
        const result = await resolver.resolve('doppler:ever-works/prd_acme');
        expect(result).toEqual({ TEMPLATED: 'expanded-value', BOTH: 'r' });
    });

    it('skips malformed entries', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({
                ok: true,
                body: {
                    secrets: {
                        GOOD: { raw: 'yes' },
                        NULL_ENTRY: null,
                        STRING_ENTRY: 'malformed',
                        EMPTY: {},
                        NON_STRING_RAW: { raw: 42 },
                    },
                },
            }),
        );
        const result = await resolver.resolve('doppler:ever-works/prd_acme');
        expect(result).toEqual({ GOOD: 'yes' });
    });

    it('composes URL with project + config as query params', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: {} } }));
        await resolver.resolve('doppler:ever-works/prd_tenants_acme');
        const [calledUrl] = fetchSpy.mock.calls[0] as [string];
        expect(calledUrl).toBe(
            'https://api.doppler.com/v3/configs/config/secrets' +
                '?project=ever-works&config=prd_tenants_acme',
        );
    });

    it('URL-encodes project/config slugs that need it', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: {} } }));
        await resolver.resolve('doppler:project with space/cfg-with-special&');
        const [calledUrl] = fetchSpy.mock.calls[0] as [string];
        expect(calledUrl).toContain('project=project%20with%20space');
        expect(calledUrl).toContain('config=cfg-with-special%26');
    });

    it('sends Bearer token in Authorization header', async () => {
        fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { secrets: {} } }));
        await resolver.resolve('doppler:ever-works/prd_acme');
        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer dp.st.test-token');
    });
});
