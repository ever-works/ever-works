import { RetryUtils } from './retry.utils';

describe('RetryUtils', () => {
    describe('withRetry', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('returns the result of the first successful attempt without delay', async () => {
            const fn = jest.fn().mockResolvedValue('ok');

            const promise = RetryUtils.withRetry(fn);

            await expect(promise).resolves.toBe('ok');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('retries until success and applies exponential backoff between attempts', async () => {
            const fn = jest
                .fn()
                .mockRejectedValueOnce(new Error('e1'))
                .mockRejectedValueOnce(new Error('e2'))
                .mockResolvedValue('done');

            const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

            const promise = RetryUtils.withRetry(fn, 3, 100, 2);
            // Drive every queued backoff timer to completion. The function
            // resolves on the third attempt; advance until all microtasks
            // drained.
            await jest.runAllTimersAsync();
            await expect(promise).resolves.toBe('done');

            expect(fn).toHaveBeenCalledTimes(3);
            // Two backoff sleeps: 100 * 2^0 = 100ms, then 100 * 2^1 = 200ms.
            const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
            expect(delays).toEqual([100, 200]);
        });

        it('throws the last error after exhausting retries', async () => {
            const lastError = new Error('final');
            const fn = jest
                .fn()
                .mockRejectedValueOnce(new Error('first'))
                .mockRejectedValueOnce(new Error('second'))
                .mockRejectedValue(lastError);

            const promise = RetryUtils.withRetry(fn, 3, 10, 2);
            // Catch rejection up-front so unhandled rejection guards do not
            // fire while we drain timers.
            const settled = promise.catch((e) => e);
            await jest.runAllTimersAsync();
            await expect(settled).resolves.toBe(lastError);
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it('does not sleep when maxAttempts is 1', async () => {
            const fn = jest.fn().mockRejectedValue(new Error('boom'));
            const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

            const promise = RetryUtils.withRetry(fn, 1, 100, 2);
            await expect(promise).rejects.toThrow('boom');
            expect(fn).toHaveBeenCalledTimes(1);
            expect(setTimeoutSpy).not.toHaveBeenCalled();
        });

        it('uses default arguments when none are provided (3 attempts, 1000ms base, 2x backoff)', async () => {
            const fn = jest
                .fn()
                .mockRejectedValueOnce(new Error('a'))
                .mockRejectedValueOnce(new Error('b'))
                .mockResolvedValue('ok');

            const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
            const promise = RetryUtils.withRetry(fn);
            await jest.runAllTimersAsync();
            await expect(promise).resolves.toBe('ok');

            const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
            expect(delays).toEqual([1000, 2000]);
        });
    });

    describe('isRetryableError', () => {
        it('returns true for transient network errors (ECONNRESET / ETIMEDOUT / ENOTFOUND)', () => {
            expect(RetryUtils.isRetryableError({ code: 'ECONNRESET' })).toBe(true);
            expect(RetryUtils.isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
            expect(RetryUtils.isRetryableError({ code: 'ENOTFOUND' })).toBe(true);
        });

        it('returns true for HTTP 5xx responses (boundary at 500 and above)', () => {
            expect(RetryUtils.isRetryableError({ response: { status: 500 } })).toBe(true);
            expect(RetryUtils.isRetryableError({ response: { status: 502 } })).toBe(true);
            expect(RetryUtils.isRetryableError({ response: { status: 599 } })).toBe(true);
        });

        it('returns true for rate-limit (429) responses', () => {
            expect(RetryUtils.isRetryableError({ response: { status: 429 } })).toBe(true);
        });

        it('returns false for 4xx responses other than 429', () => {
            expect(RetryUtils.isRetryableError({ response: { status: 400 } })).toBe(false);
            expect(RetryUtils.isRetryableError({ response: { status: 401 } })).toBe(false);
            expect(RetryUtils.isRetryableError({ response: { status: 404 } })).toBe(false);
            expect(RetryUtils.isRetryableError({ response: { status: 499 } })).toBe(false);
        });

        it('returns false for 2xx responses', () => {
            expect(RetryUtils.isRetryableError({ response: { status: 200 } })).toBe(false);
        });

        it('returns false for unknown error codes and missing response', () => {
            expect(RetryUtils.isRetryableError({ code: 'EUNKNOWN' })).toBe(false);
            expect(RetryUtils.isRetryableError({})).toBe(false);
            expect(RetryUtils.isRetryableError(new Error('plain'))).toBe(false);
        });
    });

    describe('calculateRetryDelay', () => {
        beforeEach(() => {
            jest.spyOn(Math, 'random').mockReturnValue(0); // deterministic — no jitter
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        it('applies exponential backoff (baseDelay * multiplier^(attempt-1))', () => {
            expect(RetryUtils.calculateRetryDelay(100, 1, 2, 30000)).toBe(100); // 100 * 2^0
            expect(RetryUtils.calculateRetryDelay(100, 2, 2, 30000)).toBe(200); // 100 * 2^1
            expect(RetryUtils.calculateRetryDelay(100, 3, 2, 30000)).toBe(400); // 100 * 2^2
        });

        it('uses default multiplier of 2 and default cap of 30000ms', () => {
            // attempt 5 -> 100 * 2^4 = 1600
            expect(RetryUtils.calculateRetryDelay(100, 5)).toBe(1600);
        });

        it('caps the delay at maxDelayMs', () => {
            // 1000 * 2^9 = 512000, capped at 30000.
            expect(RetryUtils.calculateRetryDelay(1000, 10, 2, 30000)).toBe(30000);
        });

        it('supports custom backoff multipliers', () => {
            // 50 * 3^2 = 450
            expect(RetryUtils.calculateRetryDelay(50, 3, 3, 30000)).toBe(450);
        });

        it('adds up to 10% jitter when Math.random() returns its maximum', () => {
            (Math.random as jest.Mock).mockReturnValue(1);
            // delay = 100, jitter = 100 * 0.1 * 1 = 10, total = 110.
            expect(RetryUtils.calculateRetryDelay(100, 1, 2, 30000)).toBe(110);
        });

        it('caps delay+jitter at maxDelayMs even when jitter would push it over', () => {
            (Math.random as jest.Mock).mockReturnValue(1);
            // 1000 * 2^4 = 16000, jitter 1600 -> 17600, cap at 17000.
            expect(RetryUtils.calculateRetryDelay(1000, 5, 2, 17000)).toBe(17000);
        });
    });
});
