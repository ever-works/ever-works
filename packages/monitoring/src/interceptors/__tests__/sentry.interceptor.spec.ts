const sentryMock = {
    init: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    setUser: jest.fn(),
    setContext: jest.fn(),
    setTag: jest.fn(),
    setTags: jest.fn(),
    logger: {
        trace: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        fatal: jest.fn(),
    },
};

jest.mock('@sentry/nestjs', () => sentryMock);

import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';
import { SentryInterceptor } from '../sentry.interceptor';

const buildExecCtx = (req: any): ExecutionContext =>
    ({
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    }) as unknown as ExecutionContext;

describe('SentryInterceptor', () => {
    let interceptor: SentryInterceptor;

    beforeEach(() => {
        Object.values(sentryMock).forEach((v) => {
            if (typeof v === 'function') (v as jest.Mock).mockClear();
        });
        interceptor = new SentryInterceptor();
    });

    it('sets user context when request.user is present', async () => {
        const req = {
            method: 'GET',
            originalUrl: '/works',
            headers: { 'user-agent': 'jest' },
            body: undefined,
            user: { id: 'u1', email: 'a@b.com', username: 'alice' },
        };
        const next: CallHandler = { handle: () => of({ ok: true }) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));

        expect(sentryMock.setUser).toHaveBeenCalledWith({
            id: 'u1',
            email: 'a@b.com',
            username: 'alice',
        });
    });

    it('does NOT set user context when request.user is missing', async () => {
        const req = { method: 'GET', originalUrl: '/works', headers: {}, body: undefined };
        const next: CallHandler = { handle: () => of({ ok: true }) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));
        expect(sentryMock.setUser).not.toHaveBeenCalled();
    });

    it('sets request context with sanitized headers (drops authorization, cookie)', async () => {
        const req = {
            method: 'POST',
            originalUrl: '/works/123',
            headers: {
                authorization: 'Bearer secret',
                cookie: 'session=abc',
                'content-type': 'application/json',
            },
            body: { foo: 'bar' },
        };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));

        expect(sentryMock.setContext).toHaveBeenCalledWith(
            'request',
            expect.objectContaining({
                method: 'POST',
                url: '/works/123',
                headers: expect.objectContaining({ 'content-type': 'application/json' }),
                body: { foo: 'bar' },
            }),
        );
        const ctx = sentryMock.setContext.mock.calls[0][1];
        expect(ctx.headers.authorization).toBeUndefined();
        expect(ctx.headers.cookie).toBeUndefined();
    });

    it('sanitizes body by dropping password/token/secret fields', async () => {
        const req = {
            method: 'POST',
            originalUrl: '/auth/login',
            headers: {},
            body: { email: 'a@b.com', password: 'pw', token: 't', secret: 's', other: 'ok' },
        };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));

        const ctx = sentryMock.setContext.mock.calls[0][1];
        expect(ctx.body.password).toBeUndefined();
        expect(ctx.body.token).toBeUndefined();
        expect(ctx.body.secret).toBeUndefined();
        expect(ctx.body.email).toBe('a@b.com');
        expect(ctx.body.other).toBe('ok');
    });

    it('recursively redacts sensitive fields in nested objects (keeps non-sensitive)', async () => {
        const req = {
            method: 'POST',
            originalUrl: '/auth/login',
            headers: {},
            body: {
                name: 'kept',
                user: { name: 'alice', password: 'pw', apiKey: 'k', access_token: 'a' },
                meta: { nested: { refreshToken: 'r', keepMe: 'yes' } },
            },
        };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));

        const ctx = sentryMock.setContext.mock.calls[0][1];
        expect(ctx.body.name).toBe('kept');
        expect(ctx.body.user.name).toBe('alice');
        expect(ctx.body.user.password).toBeUndefined();
        expect(ctx.body.user.apiKey).toBeUndefined();
        expect(ctx.body.user.access_token).toBeUndefined();
        expect(ctx.body.meta.nested.refreshToken).toBeUndefined();
        expect(ctx.body.meta.nested.keepMe).toBe('yes');
    });

    it('redacts sensitive fields inside array bodies', async () => {
        const req = {
            method: 'POST',
            originalUrl: '/auth/bulk',
            headers: {},
            body: [
                { email: 'a@b.com', password: 'pw1' },
                { email: 'c@d.com', token: 't2', name: 'keep' },
            ],
        };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));

        const ctx = sentryMock.setContext.mock.calls[0][1];
        expect(Array.isArray(ctx.body)).toBe(true);
        expect(ctx.body[0].password).toBeUndefined();
        expect(ctx.body[0].email).toBe('a@b.com');
        expect(ctx.body[1].token).toBeUndefined();
        expect(ctx.body[1].name).toBe('keep');
    });

    it('returns non-object bodies (string/number) unchanged without throwing', async () => {
        const req = { method: 'POST', originalUrl: '/raw', headers: {}, body: 'plain-string-body' };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));

        const ctx = sentryMock.setContext.mock.calls[0][1];
        expect(ctx.body).toBe('plain-string-body');
    });

    it('handles missing body without throwing', async () => {
        const req = { method: 'GET', originalUrl: '/x', headers: {}, body: undefined };
        const next: CallHandler = { handle: () => of({}) };
        await expect(
            lastValueFrom(interceptor.intercept(buildExecCtx(req), next)),
        ).resolves.toEqual({});
    });

    it('sets the transaction tag from method + originalUrl', async () => {
        const req = { method: 'GET', originalUrl: '/works', headers: {}, body: undefined };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));
        expect(sentryMock.setTag).toHaveBeenCalledWith('transaction', 'GET /works');
    });

    it('captures exception with sanitized request body and re-throws', async () => {
        const err: any = new Error('boom');
        err.status = 502;
        const req = {
            method: 'POST',
            originalUrl: '/works',
            headers: { 'user-agent': 'jest' },
            body: { password: 'pw', name: 'kept' },
        };
        const next: CallHandler = { handle: () => throwError(() => err) };

        await expect(lastValueFrom(interceptor.intercept(buildExecCtx(req), next))).rejects.toBe(
            err,
        );
        expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
        const [capturedErr, ctx] = sentryMock.captureException.mock.calls[0];
        expect(capturedErr).toBe(err);
        expect(ctx.tags).toEqual({ endpoint: 'POST /works', statusCode: 502 });
        expect(ctx.extra.userAgent).toBe('jest');
        expect(ctx.extra.requestBody.password).toBeUndefined();
        expect(ctx.extra.requestBody.name).toBe('kept');
    });

    it('falls back to statusCode 500 when error.status is missing', async () => {
        const err = new Error('mystery');
        const req = { method: 'GET', originalUrl: '/x', headers: {}, body: undefined };
        const next: CallHandler = { handle: () => throwError(() => err) };
        await expect(lastValueFrom(interceptor.intercept(buildExecCtx(req), next))).rejects.toBe(
            err,
        );
        const ctx = sentryMock.captureException.mock.calls[0][1];
        expect(ctx.tags.statusCode).toBe(500);
    });
});
