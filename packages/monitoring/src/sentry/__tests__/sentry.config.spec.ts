// Mock Sentry SDK and the profiling integration BEFORE importing the module.
const sentryInitMock = jest.fn();
const profilingIntegrationMock = jest.fn(() => ({ name: 'ProfilingIntegration' }));
const httpIntegrationMock = jest.fn((options: any) => ({ name: 'Http', options }));
const getClientMock = jest.fn((): any => undefined);

jest.mock('@sentry/nestjs', () => {
    const original = {
        init: sentryInitMock,
        httpIntegration: httpIntegrationMock,
        getClient: getClientMock,
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
    return original;
});

jest.mock('@sentry/profiling-node', () => ({
    nodeProfilingIntegration: profilingIntegrationMock,
}));

import {
    createSentryConfig,
    initSentry,
    getSentryInstance,
    isAuthPath,
    SENTRY_DATA_COLLECTION,
} from '../sentry.config';

describe('sentry.config', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        delete process.env.SENTRY_DSN;
        delete process.env.NODE_ENV;
        sentryInitMock.mockClear();
        profilingIntegrationMock.mockClear();
        httpIntegrationMock.mockClear();
        getClientMock.mockReset();
        getClientMock.mockReturnValue(undefined);
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('createSentryConfig', () => {
        it('falls back to env values and 1.0 sample rate in development', () => {
            process.env.SENTRY_DSN = 'https://example@sentry.io/1';
            process.env.NODE_ENV = 'development';
            const cfg = createSentryConfig();
            expect(cfg.dsn).toBe('https://example@sentry.io/1');
            expect(cfg.environment).toBe('development');
            expect(cfg.tracesSampleRate).toBe(1.0);
            // Sentry v11: profilesSampleRate -> profileSessionSampleRate + trace lifecycle.
            expect(cfg.profileSessionSampleRate).toBe(1.0);
            expect(cfg.profileLifecycle).toBe('trace');
            expect(cfg.profilesSampleRate).toBeUndefined();
            // Sentry v11 removed enableLogs (logs follow Sentry.logger usage).
            expect(cfg.enableLogs).toBeUndefined();
            // v11 no longer runs beforeSendTransaction; /auth is dropped by the HTTP integration.
            expect(cfg.beforeSendTransaction).toBeUndefined();
            expect(Array.isArray(cfg.integrations)).toBe(true);
            expect(profilingIntegrationMock).toHaveBeenCalledTimes(1);
            expect(httpIntegrationMock).toHaveBeenCalledTimes(1);
        });

        it('uses 0.1 sample rates when NODE_ENV=production', () => {
            process.env.SENTRY_DSN = 'https://example@sentry.io/1';
            process.env.NODE_ENV = 'production';
            const cfg = createSentryConfig();
            expect(cfg.tracesSampleRate).toBe(0.1);
            expect(cfg.profileSessionSampleRate).toBe(0.1);
            expect(cfg.environment).toBe('production');
        });

        it('defaults environment to "development" when NODE_ENV is unset', () => {
            const cfg = createSentryConfig();
            expect(cfg.environment).toBe('development');
        });

        it('overlays caller-supplied config on top of defaults', () => {
            const cfg = createSentryConfig({
                dsn: 'override-dsn',
                environment: 'staging',
                tracesSampleRate: 0.5,
                enableLogs: false,
            });
            expect(cfg.dsn).toBe('override-dsn');
            expect(cfg.environment).toBe('staging');
            expect(cfg.tracesSampleRate).toBe(0.5);
            expect(cfg.enableLogs).toBe(false);
        });

        it('maps a caller-supplied legacy profilesSampleRate onto profileSessionSampleRate', () => {
            const cfg = createSentryConfig({ profilesSampleRate: 0.25 });
            expect(cfg.profileSessionSampleRate).toBe(0.25);
            expect(cfg.profilesSampleRate).toBeUndefined();
        });

        it('an explicit undefined profileSessionSampleRate keeps the computed fallback (review fix)', () => {
            process.env.NODE_ENV = 'production';
            expect(
                createSentryConfig({ profileSessionSampleRate: undefined })
                    .profileSessionSampleRate,
            ).toBe(0.1);
            expect(
                createSentryConfig({ profileSessionSampleRate: undefined, profilesSampleRate: 0.3 })
                    .profileSessionSampleRate,
            ).toBe(0.3);
            expect(
                createSentryConfig({ profileSessionSampleRate: 0.05, profilesSampleRate: 0.3 })
                    .profileSessionSampleRate,
            ).toBe(0.05);
        });

        it('a caller beforeSendSpan runs first and cannot switch the URL redaction off (review fix)', () => {
            const token = 'Zb3kQ9x_T1-vYwP0aLmN8cR4sD6fG2hJ5kL7qW9eR1t';
            const callerHook = jest.fn((span: any) => ({
                ...span,
                attributes: { ...span.attributes, extra: 'kept' },
            }));
            const cfg = createSentryConfig({ beforeSendSpan: callerHook });
            const out = cfg.beforeSendSpan({
                name: `GET /share/${token}`,
                attributes: { 'url.path': `/share/${token}` },
            });
            expect(callerHook).toHaveBeenCalledTimes(1);
            expect(out.attributes.extra).toBe('kept');
            expect(JSON.stringify(out)).not.toContain(token);
            // A caller returning null (which Sentry ignores) still yields the redacted original.
            const cfg2 = createSentryConfig({ beforeSendSpan: () => null });
            expect(
                JSON.stringify(
                    cfg2.beforeSendSpan({ name: `GET /share/${token}`, attributes: {} }),
                ),
            ).not.toContain(token);
        });

        it('keeps the v10 privacy baseline: dataCollection is set explicitly, not left to the permissive v11 default', () => {
            const cfg = createSentryConfig();
            expect(cfg.dataCollection).toBe(SENTRY_DATA_COLLECTION);
            expect(cfg.dataCollection.userInfo).toBe(false);
            expect(cfg.dataCollection.cookies).toBe(false);
            expect(cfg.dataCollection.httpBodies).toEqual([]);
            expect(cfg.dataCollection.databaseQueryData).toBe(false);
            expect(cfg.dataCollection.genAI).toEqual({ inputs: false, outputs: false });
            expect(cfg.dataCollection.queues).toBe(false);
            expect(cfg.dataCollection.graphQL).toEqual({ document: false, variables: false });
            expect(cfg.dataCollection.httpHeaders.request.deny).toEqual(
                expect.arrayContaining(['forwarded', '-ip', 'remote-', 'via', '-user']),
            );
        });

        it('drops incoming /auth requests before a span exists (httpIntegration ignoreIncomingRequests)', () => {
            createSentryConfig();
            const ignore = httpIntegrationMock.mock.calls[0][0].ignoreIncomingRequests;
            expect(ignore('/auth')).toBe(true);
            expect(ignore('/auth/login')).toBe(true);
            expect(ignore('/auth/refresh?redirect=/works')).toBe(true);
            expect(ignore('/authentication/status')).toBe(false);
            expect(ignore('/works?next=/auth/login')).toBe(false);
            expect(ignore('/works')).toBe(false);
            expect(ignore('')).toBe(false);
        });

        it('the real API auth routes live under /api/auth and are matched too', () => {
            createSentryConfig();
            const ignore = httpIntegrationMock.mock.calls[0][0].ignoreIncomingRequests;
            expect(ignore('/api/auth')).toBe(true);
            expect(ignore('/api/auth/login')).toBe(true);
            expect(ignore('/api/auth/anonymous?x=1')).toBe(true);
            expect(ignore('/api/authentication')).toBe(false);
            expect(ignore('/api/works?next=/api/auth/login')).toBe(false);
            expect(ignore('/api/works')).toBe(false);
            const cfg = createSentryConfig();
            expect(
                cfg.beforeSend({ request: { url: 'https://api.example/api/auth/register' } }),
            ).toBeNull();
            const kept = { request: { url: 'https://api.example/api/authentication' } };
            expect(cfg.beforeSend(kept)).toBe(kept);
        });

        it('isAuthPath is path-anchored', () => {
            expect(isAuthPath('/auth')).toBe(true);
            expect(isAuthPath('/auth/x#frag')).toBe(true);
            expect(isAuthPath('/authx')).toBe(false);
            expect(isAuthPath(undefined)).toBe(false);
        });

        it('beforeSend filters out /auth events but keeps others', () => {
            const cfg = createSentryConfig();
            expect(
                cfg.beforeSend({ request: { url: 'https://api.example/auth/login' } }),
            ).toBeNull();
            const kept = cfg.beforeSend({ request: { url: 'https://api.example/works' } });
            expect(kept).toEqual({ request: { url: 'https://api.example/works' } });
        });

        it('beforeSend uses path-anchored /auth matching (not substring includes)', () => {
            const cfg = createSentryConfig();
            // /authentication is a DIFFERENT path and must NOT be scrubbed.
            const authn = { request: { url: 'https://api.example/authentication/status' } };
            expect(cfg.beforeSend(authn)).toBe(authn);
            // A path that merely contains "/auth" in a query string is NOT auth traffic.
            const query = { request: { url: 'https://api.example/works?next=/auth/login' } };
            expect(cfg.beforeSend(query)).toBe(query);
            // A real /auth path is still scrubbed.
            expect(cfg.beforeSend({ request: { url: 'https://api.example/auth' } })).toBeNull();
            // Non-URL / malformed strings fall back to substring matching.
            expect(cfg.beforeSend({ request: { url: 'not a url /auth/x' } })).toBeNull();
            const malformedKept = { request: { url: 'not a url at all' } };
            expect(cfg.beforeSend(malformedKept)).toBe(malformedKept);
        });

        it('beforeSend tolerates events without a request.url', () => {
            const cfg = createSentryConfig();
            const ev = { level: 'error' };
            expect(cfg.beforeSend(ev)).toBe(ev);
            const span = { name: 'GET /works', attributes: {} };
            expect(cfg.beforeSendSpan(span)).toBe(span);
            expect(cfg.beforeSendSpan(null)).toBeNull();
        });
        it('redacts share tokens from the request URL, transaction name and breadcrumbs', () => {
            const cfg = createSentryConfig();
            const token = 'Zb3kQ9x_T1-vYwP0aLmN8cR4sD6fG2hJ5kL7qW9eR1t';
            const event = {
                request: { url: `https://app.example/en/share/${token}` },
                transaction: `GET /share/${token}`,
                breadcrumbs: [
                    { data: { url: `https://app.example/share/${token}` } },
                    { message: `navigated to /share/${token}` },
                ],
            };
            const sent = cfg.beforeSend(event);
            expect(JSON.stringify(sent)).not.toContain(token);
            expect(sent.request.url).toBe('https://app.example/en/share/[redacted]');

            // Sentry v11 streams spans: the redaction now runs in beforeSendSpan.
            const span = cfg.beforeSendSpan({
                name: `GET /share/${token}`,
                is_segment: true,
                attributes: {
                    'url.full': `https://app.example/share/${token}`,
                    'url.path': `/share/${token}`,
                    'http.target': `/share/${token}`,
                    'sentry.op': 'http.server',
                },
            });
            expect(JSON.stringify(span)).not.toContain(token);
            expect(span.attributes['sentry.op']).toBe('http.server');
        });
    });

    describe('initSentry', () => {
        it('returns false and does NOT call Sentry.init when no DSN is configured', () => {
            const ok = initSentry();
            expect(ok).toBe(false);
            expect(sentryInitMock).not.toHaveBeenCalled();
        });

        it('calls Sentry.init and returns true when DSN is provided in env', () => {
            process.env.SENTRY_DSN = 'https://example@sentry.io/1';
            const ok = initSentry();
            expect(ok).toBe(true);
            expect(sentryInitMock).toHaveBeenCalledTimes(1);
            const arg = sentryInitMock.mock.calls[0][0];
            expect(arg.dsn).toBe('https://example@sentry.io/1');
        });

        it('calls Sentry.init when DSN is provided via config arg', () => {
            const ok = initSentry({ dsn: 'cfg-dsn', environment: 'staging' });
            expect(ok).toBe(true);
            expect(sentryInitMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    dsn: 'cfg-dsn',
                    environment: 'staging',
                }),
            );
        });
    });

    describe('initSentry idempotency', () => {
        it('does not call Sentry.init again when a client already exists (main.ts + SentryModule.forRoot)', () => {
            process.env.SENTRY_DSN = 'https://example@sentry.io/1';
            getClientMock.mockReturnValue({});
            expect(initSentry()).toBe(true);
            expect(sentryInitMock).not.toHaveBeenCalled();
        });
    });

    describe('getSentryInstance', () => {
        it('returns the (mocked) Sentry namespace', () => {
            const s = getSentryInstance();
            expect(s).toBeDefined();
            expect(typeof (s as any).captureException).toBe('function');
        });
    });
});
