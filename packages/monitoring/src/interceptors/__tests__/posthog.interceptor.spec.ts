const captureMock = jest.fn();
const identifyMock = jest.fn();
const shutdownMock = jest.fn().mockResolvedValue(undefined);

jest.mock('posthog-node', () => ({
    PostHog: jest.fn().mockImplementation(() => ({
        capture: captureMock,
        identify: identifyMock,
        shutdown: shutdownMock,
    })),
}));

import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, lastValueFrom } from 'rxjs';
import { initPostHog, shutdownPostHog } from '../../posthog/posthog.config';
import { PostHogInterceptor } from '../posthog.interceptor';

const buildExecCtx = (req: any, response: any = { statusCode: 200 }): ExecutionContext =>
    ({
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => response }),
    }) as unknown as ExecutionContext;

describe('PostHogInterceptor', () => {
    let interceptor: PostHogInterceptor;

    beforeEach(async () => {
        await shutdownPostHog();
        captureMock.mockClear();
        identifyMock.mockClear();
        interceptor = new PostHogInterceptor();
    });

    it('does not throw when PostHog is not initialized', async () => {
        const req = { method: 'GET', originalUrl: '/x', headers: {}, body: undefined };
        const next: CallHandler = { handle: () => of({}) };
        await expect(lastValueFrom(interceptor.intercept(buildExecCtx(req), next))).resolves.toEqual({});
        expect(captureMock).not.toHaveBeenCalled();
    });

    it('emits two events (api_request and per-endpoint) on success with user', async () => {
        initPostHog({ apiKey: 'k' });
        const req = {
            method: 'GET',
            originalUrl: '/works/42',
            headers: { 'user-agent': 'jest' },
            body: undefined,
            ip: '1.2.3.4',
            user: { id: 'u-1' },
        };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req, { statusCode: 201 }), next));

        expect(captureMock).toHaveBeenCalledTimes(2);

        const apiRequestCall = captureMock.mock.calls.find((c) => c[0].event === 'api_request');
        expect(apiRequestCall).toBeDefined();
        const apiReq = apiRequestCall![0];
        expect(apiReq.distinctId).toBe('u-1');
        expect(apiReq.properties.method).toBe('GET');
        expect(apiReq.properties.endpoint).toBe('/works/42');
        expect(apiReq.properties.statusCode).toBe(201);
        expect(apiReq.properties.userAgent).toBe('jest');
        expect(apiReq.properties.ip).toBe('1.2.3.4');
        expect(typeof apiReq.properties.duration).toBe('number');
        expect(apiReq.groups).toEqual({ endpoint: '/works/42' });

        const namedCall = captureMock.mock.calls.find((c) => c[0].event !== 'api_request');
        expect(namedCall).toBeDefined();
        // /works/42 -> /works/:id -> get_works_:id (lowercased) — but ":" is a non-alphanumeric and gets replaced with "_"
        // works -> works, /:id -> _:id is filtered to /_id, leading slash trimmed, "/" replaced with "_"
        expect(namedCall![0].event).toMatch(/^api_get_works/);
    });

    it('uses "anonymous" as distinctId when no user is attached', async () => {
        initPostHog({ apiKey: 'k' });
        const req = { method: 'POST', originalUrl: '/auth/login', headers: {}, body: undefined };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));

        const apiRequestCall = captureMock.mock.calls.find((c) => c[0].event === 'api_request');
        expect(apiRequestCall![0].distinctId).toBe('anonymous');
    });

    it('falls back to connection.remoteAddress when request.ip is missing', async () => {
        initPostHog({ apiKey: 'k' });
        const req = {
            method: 'GET',
            originalUrl: '/x',
            headers: {},
            body: undefined,
            connection: { remoteAddress: '10.0.0.1' },
        };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));

        const apiRequestCall = captureMock.mock.calls.find((c) => c[0].event === 'api_request');
        expect(apiRequestCall![0].properties.ip).toBe('10.0.0.1');
    });

    it('replaces numeric IDs with :id and lowercases the named-event slug', async () => {
        initPostHog({ apiKey: 'k' });
        const req = {
            method: 'PATCH',
            originalUrl: '/Users/123/Posts/456',
            headers: {},
            body: undefined,
        };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));

        const namedCall = captureMock.mock.calls.find((c) => c[0].event !== 'api_request')!;
        // expected: api_patch_users_:id_posts_:id with non-alphanumerics → "_"
        expect(namedCall[0].event).toMatch(/^api_patch_/);
        // numeric ids are replaced with :id, then ":" -> "_" via the second replace
        expect(namedCall[0].event).not.toMatch(/123|456/);
    });
});
