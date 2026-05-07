// Mock Sentry SDK and the profiling integration BEFORE importing the module.
const sentryInitMock = jest.fn();
const profilingIntegrationMock = jest.fn(() => ({ name: 'ProfilingIntegration' }));

jest.mock('@sentry/nestjs', () => {
    const original = {
        init: sentryInitMock,
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

import { createSentryConfig, initSentry, getSentryInstance } from '../sentry.config';

describe('sentry.config', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        delete process.env.SENTRY_DSN;
        delete process.env.NODE_ENV;
        sentryInitMock.mockClear();
        profilingIntegrationMock.mockClear();
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
            expect(cfg.profilesSampleRate).toBe(1.0);
            expect(cfg.enableLogs).toBe(true);
            expect(Array.isArray(cfg.integrations)).toBe(true);
            expect(profilingIntegrationMock).toHaveBeenCalledTimes(1);
        });

        it('uses 0.1 sample rates when NODE_ENV=production', () => {
            process.env.SENTRY_DSN = 'https://example@sentry.io/1';
            process.env.NODE_ENV = 'production';
            const cfg = createSentryConfig();
            expect(cfg.tracesSampleRate).toBe(0.1);
            expect(cfg.profilesSampleRate).toBe(0.1);
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

        it('beforeSend filters out /auth events but keeps others', () => {
            const cfg = createSentryConfig();
            expect(cfg.beforeSend({ request: { url: 'https://api.example/auth/login' } })).toBeNull();
            const kept = cfg.beforeSend({ request: { url: 'https://api.example/works' } });
            expect(kept).toEqual({ request: { url: 'https://api.example/works' } });
        });

        it('beforeSendTransaction filters out /auth transactions but keeps others', () => {
            const cfg = createSentryConfig();
            expect(
                cfg.beforeSendTransaction({ request: { url: 'https://api.example/auth/refresh' } }),
            ).toBeNull();
            const kept = cfg.beforeSendTransaction({ request: { url: 'https://api.example/works' } });
            expect(kept).toEqual({ request: { url: 'https://api.example/works' } });
        });

        it('beforeSend tolerates events without a request.url', () => {
            const cfg = createSentryConfig();
            const ev = { level: 'error' };
            expect(cfg.beforeSend(ev)).toBe(ev);
            expect(cfg.beforeSendTransaction(ev)).toBe(ev);
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
            expect(sentryInitMock).toHaveBeenCalledWith(expect.objectContaining({
                dsn: 'cfg-dsn',
                environment: 'staging',
            }));
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
