/**
 * Tests for PostHogLoggerService.
 *
 * The service has three obligations we exercise here:
 *   1. forward each NestJS log level to PostHog Logs as a `$log` event with
 *      the right `level` property + structured metadata;
 *   2. NEVER throw, even when PostHog is unconfigured or its client raises;
 *   3. forward `Error` instances logged via `error()` to Sentry's
 *      `captureException` (but only Error instances — string errors are not
 *      forwarded, since they would just duplicate request-path exceptions
 *      caught by SentryInterceptor).
 */

// Mock posthog-node BEFORE importing anything that touches the posthog
// singleton, because `initPostHog()` caches the constructed client.
const captureMock = jest.fn();
const shutdownMock = jest.fn().mockResolvedValue(undefined);

jest.mock('posthog-node', () => ({
    PostHog: jest.fn().mockImplementation(() => ({
        capture: captureMock,
        identify: jest.fn(),
        shutdown: shutdownMock,
    })),
}));

// Mock @sentry/nestjs so we can spy on captureException without ever talking
// to the real SDK.
const captureExceptionMock = jest.fn();
jest.mock('@sentry/nestjs', () => ({
    captureException: (...args: unknown[]) => captureExceptionMock(...args),
    init: jest.fn(),
    logger: {
        trace: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        fatal: jest.fn(),
    },
}));

// Avoid the optional profiling-node native dep blowing up the test.
jest.mock('@sentry/profiling-node', () => ({
    nodeProfilingIntegration: () => ({ name: 'mock-profiling' }),
}));

import { initPostHog, shutdownPostHog } from '../posthog.config';
import { PostHogLoggerService } from '../posthog-logger.service';

describe('PostHogLoggerService', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
        originalEnv = { ...process.env };
        delete process.env.POSTHOG_API_KEY;
        delete process.env.POSTHOG_HOST;
        await shutdownPostHog();
        captureMock.mockReset();
        captureExceptionMock.mockReset();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('without a PostHog client (POSTHOG_API_KEY unset)', () => {
        it('does not throw on any level and never calls capture', () => {
            const svc = new PostHogLoggerService('TestCtx');
            expect(() => svc.log('hello')).not.toThrow();
            expect(() => svc.warn('be careful')).not.toThrow();
            expect(() => svc.error('boom')).not.toThrow();
            expect(() => svc.debug('debugging')).not.toThrow();
            expect(() => svc.verbose('verbose')).not.toThrow();
            expect(captureMock).not.toHaveBeenCalled();
            expect(captureExceptionMock).not.toHaveBeenCalled();
        });
    });

    describe('with an initialized PostHog client', () => {
        beforeEach(() => {
            initPostHog({ apiKey: 'phc_test' });
            captureMock.mockReset();
        });

        it('captures a $log event for log() with the right level', () => {
            const svc = new PostHogLoggerService('MyModule');
            svc.log('user signed in');
            expect(captureMock).toHaveBeenCalledTimes(1);
            const call = captureMock.mock.calls[0][0];
            expect(call.event).toBe('$log');
            expect(call.distinctId).toBe('system');
            expect(call.properties.level).toBe('log');
            expect(call.properties.message).toBe('user signed in');
            expect(call.properties.context).toBe('MyModule');
            expect(call.properties.service).toBe('ever-works-api');
        });

        it.each([
            ['warn', 'warn'],
            ['debug', 'debug'],
            ['verbose', 'verbose'],
        ])('forwards %s() emits as $log with level=%s', (method, expectedLevel) => {
            const svc = new PostHogLoggerService();
            (svc as any)[method]('hi');
            expect(captureMock).toHaveBeenCalledTimes(1);
            expect(captureMock.mock.calls[0][0].properties.level).toBe(expectedLevel);
        });

        it('honours a custom distinctId for grouping', () => {
            const svc = new PostHogLoggerService('Ctx', 'worker-7');
            svc.log('working');
            expect(captureMock.mock.calls[0][0].distinctId).toBe('worker-7');
        });

        it('serializes Error instances and includes name + stack', () => {
            const err = new Error('disk full');
            const svc = new PostHogLoggerService();
            svc.error(err);
            const props = captureMock.mock.calls[0][0].properties;
            expect(props.level).toBe('error');
            expect(props.message).toBe('disk full');
            expect(props.error_name).toBe('Error');
            expect(typeof props.error_stack).toBe('string');
        });

        it('passes the NestJS trace string through when error() is called as (msg, trace)', () => {
            const svc = new PostHogLoggerService();
            const trace = 'Error: x\n    at foo (file.ts:1:1)';
            svc.error('caught', trace);
            const props = captureMock.mock.calls[0][0].properties;
            expect(props.trace).toBe(trace);
        });

        it('forwards Error instances logged via error() to Sentry captureException', () => {
            const err = new Error('explode');
            const svc = new PostHogLoggerService();
            svc.error(err);
            expect(captureExceptionMock).toHaveBeenCalledWith(err);
        });

        it('does NOT call captureException for string error() messages (avoids double-capture with SentryInterceptor)', () => {
            const svc = new PostHogLoggerService();
            svc.error('just a string');
            expect(captureExceptionMock).not.toHaveBeenCalled();
        });

        it('swallows a thrown capture() and never propagates the error', () => {
            captureMock.mockImplementationOnce(() => {
                throw new Error('posthog down');
            });
            const svc = new PostHogLoggerService();
            expect(() => svc.log('still works')).not.toThrow();
        });

        it('serializes non-string messages via JSON.stringify', () => {
            const svc = new PostHogLoggerService();
            svc.log({ event: 'click', userId: 42 });
            const props = captureMock.mock.calls[0][0].properties;
            expect(props.message).toBe('{"event":"click","userId":42}');
        });

        it('uses SENTRY_ENVIRONMENT for the env property when set', () => {
            process.env.SENTRY_ENVIRONMENT = 'production';
            const svc = new PostHogLoggerService();
            svc.log('ping');
            expect(captureMock.mock.calls[0][0].properties.env).toBe('production');
        });
    });
});
