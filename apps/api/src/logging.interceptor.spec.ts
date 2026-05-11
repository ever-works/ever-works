import { of, throwError, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { LoggingInterceptor } from './logging.interceptor';

describe('LoggingInterceptor', () => {
    let interceptor: LoggingInterceptor;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    const buildContext = (req: { method: string; originalUrl: string }, statusCode = 200) => {
        const ctx: Partial<ExecutionContext> = {
            switchToHttp: () =>
                ({
                    getRequest: () => req,
                    getResponse: () => ({ statusCode }),
                }) as any,
        };
        return ctx as ExecutionContext;
    };

    beforeEach(() => {
        // Default to debug-OFF so each test opts in explicitly.
        delete process.env.HTTP_DEBUG;
        interceptor = new LoggingInterceptor();
        logSpy = jest.spyOn((interceptor as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest
            .spyOn((interceptor as any).logger, 'error')
            .mockImplementation(() => undefined);
    });

    afterEach(() => {
        delete process.env.HTTP_DEBUG;
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    describe('debug-off short-circuit', () => {
        it('returns next.handle() directly without logging when HTTP_DEBUG is unset', async () => {
            const next: CallHandler = { handle: () => of('payload') };
            const ctx = buildContext({ method: 'GET', originalUrl: '/x' });

            const result$ = interceptor.intercept(ctx, next);
            await expect(lastValueFrom(result$)).resolves.toBe('payload');

            expect(logSpy).not.toHaveBeenCalled();
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('returns next.handle() directly when HTTP_DEBUG is the literal "false"', async () => {
            process.env.HTTP_DEBUG = 'false';
            const next: CallHandler = { handle: () => of('payload') };
            const ctx = buildContext({ method: 'GET', originalUrl: '/x' });

            await lastValueFrom(interceptor.intercept(ctx, next));

            expect(logSpy).not.toHaveBeenCalled();
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('returns next.handle() directly when HTTP_DEBUG is "1" (only literal "true" enables)', async () => {
            // The config.debug() helper does a strict-equal check against
            // the literal 'true', so any other truthy-looking value like
            // '1' or 'TRUE' is treated as off. Pinned here so a casual
            // refactor to a loose-truthy check breaks loudly.
            process.env.HTTP_DEBUG = '1';
            const next: CallHandler = { handle: () => of('payload') };
            const ctx = buildContext({ method: 'GET', originalUrl: '/x' });

            await lastValueFrom(interceptor.intercept(ctx, next));

            expect(logSpy).not.toHaveBeenCalled();
        });
    });

    describe('debug-on logging (success path)', () => {
        beforeEach(() => {
            process.env.HTTP_DEBUG = 'true';
        });

        it('logs the incoming request line synchronously before subscribing', async () => {
            const next: CallHandler = { handle: () => of('payload') };
            const ctx = buildContext({ method: 'GET', originalUrl: '/api/health' });

            const result$ = interceptor.intercept(ctx, next);

            // Incoming-Request line fires synchronously inside `intercept`
            // before any subscription happens.
            expect(logSpy).toHaveBeenCalledWith('Incoming Request: GET /api/health');

            await lastValueFrom(result$);
        });

        it('logs the outgoing response line on success with statusCode + delay', async () => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
            const next: CallHandler = {
                handle: () => {
                    // Advance the fake clock between handle() invocation and the
                    // tap() so the latency math captures a non-zero delta.
                    jest.setSystemTime(new Date('2026-01-01T00:00:00.123Z'));
                    return of('payload');
                },
            };
            const ctx = buildContext({ method: 'POST', originalUrl: '/api/works' }, 201);

            await lastValueFrom(interceptor.intercept(ctx, next));

            expect(logSpy).toHaveBeenCalledWith('Outgoing Response: POST /api/works 201 - 123ms');
        });

        it('falls back to status 200 when response has no statusCode', async () => {
            const next: CallHandler = { handle: () => of('payload') };
            // statusCode 0 → falsy → fallback to 200 in the log line.
            const ctx = buildContext({ method: 'GET', originalUrl: '/api/x' }, 0);

            await lastValueFrom(interceptor.intercept(ctx, next));

            const outgoing = logSpy.mock.calls.find((c) =>
                String(c[0]).startsWith('Outgoing Response'),
            );
            expect(outgoing).toBeDefined();
            expect(outgoing![0]).toMatch(/^Outgoing Response: GET \/api\/x 200 - \d+ms$/);
        });

        it('does NOT call logger.error on the success path', async () => {
            const next: CallHandler = { handle: () => of('payload') };
            const ctx = buildContext({ method: 'GET', originalUrl: '/api/x' });

            await lastValueFrom(interceptor.intercept(ctx, next));

            expect(errorSpy).not.toHaveBeenCalled();
        });
    });

    describe('debug-on logging (error path)', () => {
        beforeEach(() => {
            process.env.HTTP_DEBUG = 'true';
        });

        it('logs the error line with statusCode from err.response and rethrows the original error', async () => {
            const err = { response: { statusCode: 404 }, message: 'not found' };
            const next: CallHandler = { handle: () => throwError(() => err) };
            const ctx = buildContext({ method: 'GET', originalUrl: '/api/missing' });

            await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);

            const errorCall = errorSpy.mock.calls.find((c) =>
                String(c[0]).startsWith('Error Response'),
            );
            expect(errorCall).toBeDefined();
            expect(errorCall![0]).toMatch(/^Error Response: GET \/api\/missing 404 - \d+ms$/);
        });

        it('falls back to statusCode 500 when err has no .response', async () => {
            const err = new Error('boom');
            const next: CallHandler = { handle: () => throwError(() => err) };
            const ctx = buildContext({ method: 'POST', originalUrl: '/api/x' });

            await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);

            const errorCall = errorSpy.mock.calls.find((c) =>
                String(c[0]).startsWith('Error Response'),
            );
            expect(errorCall).toBeDefined();
            expect(errorCall![0]).toMatch(/^Error Response: POST \/api\/x 500 - \d+ms$/);
        });

        it('falls back to 400 when statusCode is falsy (e.g. response present but no statusCode)', async () => {
            // The interceptor uses `${statusCode || 400}` for error logs, so a
            // missing/zero statusCode renders as "400" — distinct from the
            // "no err.response" branch which substitutes 500.
            const err = { response: {} };
            const next: CallHandler = { handle: () => throwError(() => err) };
            const ctx = buildContext({ method: 'GET', originalUrl: '/api/x' });

            await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);

            const errorCall = errorSpy.mock.calls.find((c) =>
                String(c[0]).startsWith('Error Response'),
            );
            expect(errorCall![0]).toMatch(/^Error Response: GET \/api\/x 400 - \d+ms$/);
        });

        it('does NOT log the outgoing response line on the error path', async () => {
            const err = new Error('boom');
            const next: CallHandler = { handle: () => throwError(() => err) };
            const ctx = buildContext({ method: 'GET', originalUrl: '/api/x' });

            await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);

            const outgoing = logSpy.mock.calls.find((c) =>
                String(c[0]).startsWith('Outgoing Response'),
            );
            expect(outgoing).toBeUndefined();
        });

        it('still logs the incoming request line before the error occurs', async () => {
            const err = new Error('boom');
            const next: CallHandler = { handle: () => throwError(() => err) };
            const ctx = buildContext({ method: 'GET', originalUrl: '/api/x' });

            await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);

            expect(logSpy).toHaveBeenCalledWith('Incoming Request: GET /api/x');
        });

        it('records elapsed milliseconds since incoming request (uses Date.now() pair)', async () => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
            const err = new Error('boom');
            const next: CallHandler = {
                handle: () => {
                    jest.setSystemTime(new Date('2026-01-01T00:00:00.250Z'));
                    return throwError(() => err);
                },
            };
            const ctx = buildContext({ method: 'GET', originalUrl: '/api/x' });

            await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);

            expect(errorSpy).toHaveBeenCalledWith('Error Response: GET /api/x 500 - 250ms');
        });
    });
});
