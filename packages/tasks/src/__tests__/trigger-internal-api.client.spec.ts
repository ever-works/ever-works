import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import superjson from 'superjson';

const { triggerConfig } = vi.hoisted(() => ({
    triggerConfig: {
        getInternalBaseUrl: vi.fn(),
        getInternalSecret: vi.fn(),
    },
}));

vi.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: triggerConfig,
    },
}));

import { TriggerInternalApiClient } from '../trigger/worker/services/trigger-internal-api.client';

const okJsonResponse = (status: number, body: unknown): Response =>
    ({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
    }) as unknown as Response;

const okEmptyResponse = (status = 204): Response =>
    ({
        ok: true,
        status,
        text: () => Promise.resolve(''),
    }) as unknown as Response;

const errorResponse = (status: number, body = 'boom'): Response =>
    ({
        ok: false,
        status,
        text: () => Promise.resolve(body),
    }) as unknown as Response;

describe('TriggerInternalApiClient', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com/');
        triggerConfig.getInternalSecret.mockReturnValue('secret-1');

        fetchSpy = vi.fn();
        // @ts-expect-error - install fetch on global
        globalThis.fetch = fetchSpy;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('constructor', () => {
        it('throws when TRIGGER_INTERNAL_API_URL is not configured', () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue('');
            triggerConfig.getInternalSecret.mockReturnValue('s');

            expect(() => new TriggerInternalApiClient()).toThrow(
                'TRIGGER_INTERNAL_API_URL is not configured',
            );
        });

        it('throws when TRIGGER_INTERNAL_API_URL is null/undefined (treated as empty)', () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue(undefined as unknown as string);
            triggerConfig.getInternalSecret.mockReturnValue('s');

            expect(() => new TriggerInternalApiClient()).toThrow(
                'TRIGGER_INTERNAL_API_URL is not configured',
            );
        });

        it('throws when TRIGGER_INTERNAL_SECRET is not configured', () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com');
            triggerConfig.getInternalSecret.mockReturnValue('');

            expect(() => new TriggerInternalApiClient()).toThrow(
                'TRIGGER_INTERNAL_SECRET is not configured',
            );
        });

        it('throws when TRIGGER_INTERNAL_SECRET is null/undefined', () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com');
            triggerConfig.getInternalSecret.mockReturnValue(undefined as unknown as string);

            expect(() => new TriggerInternalApiClient()).toThrow(
                'TRIGGER_INTERNAL_SECRET is not configured',
            );
        });

        it('constructs successfully when both env values are present', () => {
            expect(() => new TriggerInternalApiClient()).not.toThrow();
        });
    });

    describe('URL composition', () => {
        it('strips a trailing slash on the base URL and a leading slash on the path', async () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com/');
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            await client.fetchWorkContext('w1', 'u1');

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url] = fetchSpy.mock.calls[0];
            expect(url).toBe('https://api.example.com/works/w1/context?userId=u1');
        });

        it('joins paths with no double-slash when base has no trailing slash', async () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com');
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            await client.fetchWorkContext('w1', 'u1');

            const [url] = fetchSpy.mock.calls[0];
            expect(url).toBe('https://api.example.com/works/w1/context?userId=u1');
        });

        it('encodes the userId via URLSearchParams (handles characters that need encoding)', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            await client.fetchWorkContext('work-1', 'user with spaces & symbols');

            const [url] = fetchSpy.mock.calls[0];
            expect(url).toContain('userId=user+with+spaces+%26+symbols');
        });
    });

    describe('fetchWorkContext', () => {
        it('issues a GET to /works/:workId/context?userId=:userId with auth header', async () => {
            const client = new TriggerInternalApiClient();
            const expected = { user: { id: 'u1' }, work: { id: 'w1' }, gitToken: 'tok' };
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, expected));

            const result = await client.fetchWorkContext('w1', 'u1');

            expect(result).toEqual(expected);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [, init] = fetchSpy.mock.calls[0];
            expect(init).toMatchObject({
                method: 'GET',
                headers: {
                    'content-type': 'application/json',
                    'x-trigger-secret': 'secret-1',
                },
            });
            expect(init.body).toBeUndefined();
        });

        it('returns undefined for a 204 No Content response', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okEmptyResponse(204));

            const result = await client.fetchWorkContext('w1', 'u1');

            expect(result).toBeUndefined();
        });

        it('returns undefined for a 200 with empty body', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okEmptyResponse(200));

            const result = await client.fetchWorkContext('w1', 'u1');

            expect(result).toBeUndefined();
        });
    });

    describe('callRemote', () => {
        it('issues a POST to /remote/call with the SuperJSON args envelope', async () => {
            const client = new TriggerInternalApiClient();

            // Server returns a SuperJSON-serialized envelope; the client deserializes it.
            const serverPayload = superjson.serialize({ value: 42, when: new Date('2026-01-01') });
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, { result: serverPayload }));

            const result = await client.callRemote('SomeService', 'doIt', {
                json: { foo: 'bar' },
            });

            expect(result).toEqual({ value: 42, when: new Date('2026-01-01') });
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            const [url, init] = fetchSpy.mock.calls[0];
            expect(url).toBe('https://api.example.com/remote/call');
            expect(init.method).toBe('POST');
            expect(JSON.parse(init.body)).toEqual({
                name: 'SomeService',
                method: 'doIt',
                args: { json: { foo: 'bar' } },
            });
        });

        it('forwards SuperJSON meta inside the args envelope', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(
                okJsonResponse(200, { result: superjson.serialize('ok') }),
            );

            await client.callRemote('S', 'm', {
                json: { d: 'pretend-date' },
                meta: { values: { d: ['Date'] } },
            });

            const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(body.args.meta).toEqual({ values: { d: ['Date'] } });
        });

        it('returns undefined when the server omits a `result` field', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, {}));

            const result = await client.callRemote('S', 'm', { json: null });

            expect(result).toBeUndefined();
        });
    });

    describe('retry behaviour', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        const flushAll = async () => {
            // Drain pending microtasks + timers in lock-step so the retry loop can
            // progress without us having to know the exact backoff schedule.
            for (let i = 0; i < 10; i++) {
                await vi.advanceTimersByTimeAsync(2000);
            }
        };

        it('retries once on a 5xx response then resolves on success', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy
                .mockResolvedValueOnce(errorResponse(500, 'down'))
                .mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            const promise = client.fetchWorkContext('w', 'u');
            await flushAll();
            const result = await promise;

            expect(result).toEqual({ ok: true });
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it('retries up to 3 times on persistent 5xx and throws the last status/text', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValue(errorResponse(503, 'unavailable'));

            const promise = client.fetchWorkContext('w', 'u');
            // Swallow the rejection here so the unhandled-rejection plugin in
            // vitest does not fail the test before we explicitly assert.
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow(
                'Trigger internal API request failed (503): unavailable',
            );
            // initial + 3 retries = 4 fetch calls
            expect(fetchSpy).toHaveBeenCalledTimes(4);
        });

        it('does NOT retry on 4xx — throws immediately after the first attempt', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(errorResponse(404, 'not found'));

            const promise = client.fetchWorkContext('w', 'u');
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow(
                'Trigger internal API request failed (404): not found',
            );
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('retries on a network error (fetch rejects) up to 3 times', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

            const promise = client.fetchWorkContext('w', 'u');
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow('ECONNREFUSED');
            expect(fetchSpy).toHaveBeenCalledTimes(4);
        });

        it('coerces non-Error fetch rejections into Error instances before the retry loop continues', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockRejectedValue('string-rejection');

            const promise = client.fetchWorkContext('w', 'u');
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow('string-rejection');
            expect(fetchSpy).toHaveBeenCalledTimes(4);
        });

        it('uses exponential backoff (500ms, 1000ms, 2000ms) between retries', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy
                .mockResolvedValueOnce(errorResponse(500))
                .mockResolvedValueOnce(errorResponse(500))
                .mockResolvedValueOnce(errorResponse(500))
                .mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            const promise = client.fetchWorkContext('w', 'u');

            // First attempt fires synchronously
            await Promise.resolve();
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // Backoff before attempt 2 = 500ms
            await vi.advanceTimersByTimeAsync(499);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetchSpy).toHaveBeenCalledTimes(2);

            // Backoff before attempt 3 = 1000ms
            await vi.advanceTimersByTimeAsync(999);
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetchSpy).toHaveBeenCalledTimes(3);

            // Backoff before attempt 4 = 2000ms
            await vi.advanceTimersByTimeAsync(1999);
            expect(fetchSpy).toHaveBeenCalledTimes(3);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetchSpy).toHaveBeenCalledTimes(4);

            const result = await promise;
            expect(result).toEqual({ ok: true });
        });
    });
});
