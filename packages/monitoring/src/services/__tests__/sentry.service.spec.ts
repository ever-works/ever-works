// Mock Sentry SDK BEFORE importing the service. Each method should forward
// to the matching Sentry function/logger.
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

import { SentryService } from '../sentry.service';

describe('SentryService', () => {
    let svc: SentryService;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        delete process.env.SENTRY_DSN;
        Object.values(sentryMock).forEach((v) => {
            if (typeof v === 'function') (v as jest.Mock).mockClear();
        });
        Object.values(sentryMock.logger).forEach((m) => (m as jest.Mock).mockClear());
        svc = new SentryService();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('isInitialized', () => {
        it('returns false when SENTRY_DSN is not set', () => {
            expect(svc.isInitialized()).toBe(false);
        });

        it('returns true when SENTRY_DSN is set', () => {
            process.env.SENTRY_DSN = 'https://example@sentry.io/1';
            expect(svc.isInitialized()).toBe(true);
        });
    });

    describe('getLogger', () => {
        it('returns the Sentry logger', () => {
            const logger = svc.getLogger();
            expect(logger).toBe(sentryMock.logger);
        });
    });

    describe.each([
        ['trace' as const],
        ['debug' as const],
        ['info' as const],
        ['warn' as const],
        ['error' as const],
        ['fatal' as const],
    ])('log level %s', (level) => {
        it('forwards message and context to Sentry.logger.' + level, () => {
            svc[level]('hello', { ctx: 1 });
            expect(sentryMock.logger[level]).toHaveBeenCalledWith('hello', { ctx: 1 });
        });

        it('works without context', () => {
            svc[level]('plain');
            expect(sentryMock.logger[level]).toHaveBeenCalledWith('plain', undefined);
        });
    });

    describe('captureException / captureMessage', () => {
        it('forwards exception and context to Sentry.captureException', () => {
            const err = new Error('boom');
            svc.captureException(err, { tags: { x: 'y' } });
            expect(sentryMock.captureException).toHaveBeenCalledWith(err, { tags: { x: 'y' } });
        });

        it('forwards message and level to Sentry.captureMessage', () => {
            svc.captureMessage('something', 'warning');
            expect(sentryMock.captureMessage).toHaveBeenCalledWith('something', 'warning');
        });
    });

    describe('setUser / setContext / setTag / setTags', () => {
        it('setUser forwards to Sentry.setUser', () => {
            svc.setUser({ id: 'u1', email: 'a@b.com' });
            expect(sentryMock.setUser).toHaveBeenCalledWith({ id: 'u1', email: 'a@b.com' });
        });

        it('setContext forwards name + context', () => {
            svc.setContext('request', { url: '/x' });
            expect(sentryMock.setContext).toHaveBeenCalledWith('request', { url: '/x' });
        });

        it('setTag forwards key+value', () => {
            svc.setTag('env', 'prod');
            expect(sentryMock.setTag).toHaveBeenCalledWith('env', 'prod');
        });

        it('setTags forwards the whole object', () => {
            svc.setTags({ env: 'prod', region: 'eu' });
            expect(sentryMock.setTags).toHaveBeenCalledWith({ env: 'prod', region: 'eu' });
        });
    });
});
