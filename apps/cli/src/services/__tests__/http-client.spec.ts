import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface MockedAxiosInstance {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    interceptors: {
        request: { use: ReturnType<typeof vi.fn> };
        response: { use: ReturnType<typeof vi.fn> };
    };
    defaults: { baseURL: string };
}

let lastInstance: MockedAxiosInstance | null = null;
let createdConfig: Record<string, unknown> | null = null;

vi.mock('axios', () => {
    const create = vi.fn((config: Record<string, unknown>) => {
        createdConfig = config;
        const instance: MockedAxiosInstance = {
            get: vi.fn().mockResolvedValue({ data: { ok: true } }),
            post: vi.fn().mockResolvedValue({ data: { ok: true } }),
            put: vi.fn().mockResolvedValue({ data: { ok: true } }),
            delete: vi.fn().mockResolvedValue({ data: { ok: true } }),
            patch: vi.fn().mockResolvedValue({ data: { ok: true } }),
            interceptors: {
                request: { use: vi.fn() },
                response: { use: vi.fn() },
            },
            defaults: { baseURL: (config?.baseURL as string) ?? '' },
        };
        lastInstance = instance;
        return instance;
    });
    return { default: { create }, create };
});

vi.mock('../../commands/auth', () => ({
    getCredentials: vi.fn().mockResolvedValue(null),
}));

import { getCredentials } from '../../commands/auth';

describe('HttpClient', () => {
    beforeEach(async () => {
        lastInstance = null;
        createdConfig = null;
        vi.clearAllMocks();
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('appends /api when constructed with a base URL that does not end with it', async () => {
        const { HttpClient } = await import('../http-client');
        new HttpClient('https://example.com');
        expect(createdConfig?.baseURL).toBe('https://example.com/api');
    });

    it('appends api (no extra slash) when base URL already ends with /', async () => {
        const { HttpClient } = await import('../http-client');
        new HttpClient('https://example.com/');
        expect(createdConfig?.baseURL).toBe('https://example.com/api');
    });

    it('preserves a base URL that already ends with /api', async () => {
        const { HttpClient } = await import('../http-client');
        new HttpClient('https://example.com/api');
        expect(createdConfig?.baseURL).toBe('https://example.com/api');
    });

    it('uses a 30-second timeout and JSON Content-Type by default', async () => {
        const { HttpClient } = await import('../http-client');
        new HttpClient('https://example.com');
        expect(createdConfig?.timeout).toBe(30000);
        expect((createdConfig?.headers as Record<string, string>)['Content-Type']).toBe(
            'application/json',
        );
    });

    it('proxies get/post/put/delete/patch to the underlying axios instance', async () => {
        const { HttpClient } = await import('../http-client');
        const client = new HttpClient('https://example.com');
        const inst = lastInstance!;

        await client.get('/works');
        await client.post('/works', { a: 1 });
        await client.put('/works/1', { a: 2 });
        await client.delete('/works/1');
        await client.patch('/works/1', { a: 3 });

        expect(inst.get).toHaveBeenCalledWith('/works', undefined);
        expect(inst.post).toHaveBeenCalledWith('/works', { a: 1 }, undefined);
        expect(inst.put).toHaveBeenCalledWith('/works/1', { a: 2 }, undefined);
        expect(inst.delete).toHaveBeenCalledWith('/works/1', undefined);
        expect(inst.patch).toHaveBeenCalledWith('/works/1', { a: 3 }, undefined);
    });

    it('registers a request interceptor that injects Bearer auth from credentials', async () => {
        const { HttpClient } = await import('../http-client');
        new HttpClient('https://example.com');
        const inst = lastInstance!;

        const requestInterceptor = inst.interceptors.request.use.mock.calls[0][0] as (
            cfg: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;

        (getCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
            token: 'abc.def.ghi',
            apiUrl: 'https://example.com',
        });

        const cfg = { headers: {} as Record<string, string>, baseURL: '' };
        const out = await requestInterceptor(cfg);
        expect((out.headers as Record<string, string>).Authorization).toBe('Bearer abc.def.ghi');
    });

    it('rewrites baseURL on the request when stored credentials.apiUrl differs', async () => {
        const { HttpClient } = await import('../http-client');
        new HttpClient('https://default.example.com');
        const inst = lastInstance!;

        const requestInterceptor = inst.interceptors.request.use.mock.calls[0][0] as (
            cfg: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;

        (getCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
            token: 'abc.def.ghi',
            apiUrl: 'https://prod.example.com',
        });

        const cfg = {
            headers: {} as Record<string, string>,
            baseURL: 'https://default.example.com/api',
        };
        const out = await requestInterceptor(cfg);
        expect(out.baseURL).toBe('https://prod.example.com/api');
    });

    it('does not set Authorization header when there are no credentials', async () => {
        const { HttpClient } = await import('../http-client');
        new HttpClient('https://example.com');
        const inst = lastInstance!;

        (getCredentials as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const requestInterceptor = inst.interceptors.request.use.mock.calls[0][0] as (
            cfg: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
        const cfg = { headers: {} as Record<string, string> };
        const out = await requestInterceptor(cfg);
        expect((out.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    it('rejects in the request interceptor error path (passthrough)', async () => {
        const { HttpClient } = await import('../http-client');
        new HttpClient('https://example.com');
        const inst = lastInstance!;

        const errHandler = inst.interceptors.request.use.mock.calls[0][1] as (
            err: unknown,
        ) => Promise<never>;
        const boom = new Error('xfail');
        await expect(errHandler(boom)).rejects.toBe(boom);
    });

    it('exits the process with code 1 on a 401 response', async () => {
        const { HttpClient } = await import('../http-client');
        new HttpClient('https://example.com');
        const inst = lastInstance!;

        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const exitSpy = vi
            .spyOn(process, 'exit')
            .mockImplementation((() => undefined as never) as typeof process.exit);

        const errHandler = inst.interceptors.response.use.mock.calls[0][1] as (
            err: unknown,
        ) => Promise<never>;
        // The handler will call process.exit then re-reject; we mock exit so it doesn't actually exit.
        const rejection = errHandler({ response: { status: 401 } });

        // The handler still calls Promise.reject after process.exit (which is mocked into a no-op)
        await expect(rejection).rejects.toMatchObject({ response: { status: 401 } });
        expect(errSpy).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);

        errSpy.mockRestore();
        exitSpy.mockRestore();
    });

    it('passes through non-401 errors without exit', async () => {
        const { HttpClient } = await import('../http-client');
        new HttpClient('https://example.com');
        const inst = lastInstance!;

        const exitSpy = vi
            .spyOn(process, 'exit')
            .mockImplementation((() => undefined as never) as typeof process.exit);

        const errHandler = inst.interceptors.response.use.mock.calls[0][1] as (
            err: unknown,
        ) => Promise<never>;
        await expect(errHandler({ response: { status: 500 } })).rejects.toMatchObject({
            response: { status: 500 },
        });
        expect(exitSpy).not.toHaveBeenCalled();

        exitSpy.mockRestore();
    });
});

describe('getHttpClient', () => {
    beforeEach(() => {
        lastInstance = null;
        createdConfig = null;
        vi.resetModules();
    });

    it('returns a singleton on repeat calls', async () => {
        const mod = await import('../http-client');
        const a = mod.getHttpClient();
        const b = mod.getHttpClient();
        expect(a).toBe(b);
    });
});
