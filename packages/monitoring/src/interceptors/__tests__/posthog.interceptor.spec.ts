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

    let envBackup: NodeJS.ProcessEnv;

    beforeEach(async () => {
        envBackup = { ...process.env };
        delete process.env.POSTHOG_CAPTURE_ENABLED;
        delete process.env.POSTHOG_TRACK_PER_ENDPOINT_EVENTS;
        delete process.env.POSTHOG_ANALYTICS_EXCLUDE_PATHS;
        await shutdownPostHog();
        captureMock.mockClear();
        identifyMock.mockClear();
        interceptor = new PostHogInterceptor();
    });

    afterEach(() => {
        process.env = envBackup;
    });

    it('does not throw when PostHog is not initialized', async () => {
        const req = { method: 'GET', originalUrl: '/x', headers: {}, body: undefined };
        const next: CallHandler = { handle: () => of({}) };
        await expect(
            lastValueFrom(interceptor.intercept(buildExecCtx(req), next)),
        ).resolves.toEqual({});
        expect(captureMock).not.toHaveBeenCalled();
    });

    it('emits a single api_request event carrying the full request context', async () => {
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

        // ONE event per request: the per-endpoint companion is opt-in (see the
        // "machine-traffic suppression" block) because it duplicated this 1:1.
        expect(captureMock).toHaveBeenCalledTimes(1);

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

        // No second event: nothing else was captured for this request.
        expect(captureMock.mock.calls.filter((c) => c[0].event !== 'api_request')).toHaveLength(0);
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

    it.each(['/api/health', '/api/health/live', '/api/health/ready', '/api/health/'])(
        'does NOT capture any event for health/probe path %s',
        async (originalUrl) => {
            initPostHog({ apiKey: 'k' });
            const req = {
                method: 'GET',
                originalUrl,
                headers: { 'user-agent': 'kube-probe' },
                body: undefined,
            };
            const next: CallHandler = { handle: () => of({ ok: true }) };

            // The request still flows through untouched...
            await expect(
                lastValueFrom(interceptor.intercept(buildExecCtx(req), next)),
            ).resolves.toEqual({ ok: true });
            // ...but nothing is sent to PostHog.
            expect(captureMock).not.toHaveBeenCalled();
        },
    );

    it('still captures for non-probe paths that merely start with "health"', async () => {
        initPostHog({ apiKey: 'k' });
        const req = {
            method: 'GET',
            originalUrl: '/api/healthcheck-foo',
            headers: {},
            body: undefined,
        };
        const next: CallHandler = { handle: () => of({}) };
        await lastValueFrom(interceptor.intercept(buildExecCtx(req), next));

        // Exemption is narrow (exact `/api/health` or `/api/health/` prefix), so this
        // unrelated route is still tracked.
        expect(captureMock).toHaveBeenCalled();
    });

    it('replaces numeric IDs with :id and lowercases the named-event slug', async () => {
        // Slug generation only runs for the opt-in per-endpoint event.
        process.env.POSTHOG_TRACK_PER_ENDPOINT_EVENTS = 'true';
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

/**
 * Regression tests for the 2026-08-31 PostHog quota incident.
 *
 * The interceptor was emitting ~110k events/day against a 1M/month allowance
 * while real product events ran at 0-13/day. Three defects, all covered here:
 *   1. every request produced TWO events (a catch-all `api_request` AND a
 *      per-endpoint `api_<method>_<path>`) — exact 1:1 duplication;
 *   2. only `/api/health*` was exempt, so synthetic monitoring hitting
 *      `/api/version` (blackbox-exporter, 3 VMAgent replicas x 5 URLs x 60s)
 *      and machine-to-machine `/internal/*` calls were recorded as product
 *      analytics;
 *   3. there was no kill switch at all — the only "off" was an absent API key.
 */
describe('PostHogInterceptor — machine-traffic suppression', () => {
    let envBackup: NodeJS.ProcessEnv;
    let interceptor: PostHogInterceptor;

    beforeEach(async () => {
        envBackup = { ...process.env };
        delete process.env.POSTHOG_CAPTURE_ENABLED;
        delete process.env.POSTHOG_TRACK_PER_ENDPOINT_EVENTS;
        delete process.env.POSTHOG_ANALYTICS_EXCLUDE_PATHS;
        await shutdownPostHog();
        captureMock.mockClear();
        interceptor = new PostHogInterceptor();
        initPostHog({ apiKey: 'k' });
    });

    afterEach(() => {
        process.env = envBackup;
    });

    const run = async (originalUrl: string, method = 'GET') => {
        const req = { method, originalUrl, headers: {}, body: undefined };
        const next: CallHandler = { handle: () => of({}) };
        return lastValueFrom(interceptor.intercept(buildExecCtx(req), next));
    };

    it.each([
        '/api/version',
        '/api/info',
        '/internal/trigger/remote/call',
        '/.well-known/agent.json',
        '/metrics',
    ])('does NOT capture anything for ops/probe path %s', async (url) => {
        await expect(run(url)).resolves.toEqual({});
        expect(captureMock).not.toHaveBeenCalled();
    });

    it('emits exactly ONE event per tracked request (no per-endpoint duplicate)', async () => {
        await run('/api/works');
        expect(captureMock).toHaveBeenCalledTimes(1);
        expect(captureMock.mock.calls[0][0].event).toBe('api_request');
        // The endpoint is preserved as a PROPERTY, so nothing analytical is lost
        // by dropping the per-endpoint event name.
        expect(captureMock.mock.calls[0][0].properties.endpoint).toBe('/api/works');
    });

    it('restores the per-endpoint companion event when POSTHOG_TRACK_PER_ENDPOINT_EVENTS=true', async () => {
        process.env.POSTHOG_TRACK_PER_ENDPOINT_EVENTS = 'true';
        await run('/api/works');
        expect(captureMock).toHaveBeenCalledTimes(2);
        expect(captureMock.mock.calls.map((c) => c[0].event)).toEqual(
            expect.arrayContaining(['api_request', 'api_get_api_works']),
        );
    });

    it('captures nothing at all when POSTHOG_CAPTURE_ENABLED=false', async () => {
        process.env.POSTHOG_CAPTURE_ENABLED = 'false';
        await expect(run('/api/works')).resolves.toEqual({});
        expect(captureMock).not.toHaveBeenCalled();
    });

    it('honours extra prefixes from POSTHOG_ANALYTICS_EXCLUDE_PATHS', async () => {
        process.env.POSTHOG_ANALYTICS_EXCLUDE_PATHS = '/api/ops,/probe';
        await run('/api/ops/status');
        expect(captureMock).not.toHaveBeenCalled();
        await run('/api/works');
        expect(captureMock).toHaveBeenCalledTimes(1);
    });

    it('still tracks a normal product route that merely resembles an ops path', async () => {
        await run('/api/versions-of-my-doc');
        expect(captureMock).toHaveBeenCalledTimes(1);
    });
});
