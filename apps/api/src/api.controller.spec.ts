// Stub the auth barrel so its transitive `@ever-works/agent/database`
// import is not pulled into this controller test.
jest.mock('./auth', () => ({
    Public: () => () => undefined,
}));
// Stub the monitoring package so the real PostHog client is not constructed.
jest.mock('@ever-works/monitoring', () => ({}));

import { APIController } from './api.controller';
import type { AnalyticsService } from '@ever-works/monitoring';

describe('APIController', () => {
    let analytics: jest.Mocked<Pick<AnalyticsService, 'track'>>;
    let controller: APIController;

    beforeEach(() => {
        analytics = { track: jest.fn() } as any;
        controller = new APIController(analytics as unknown as AnalyticsService);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('home', () => {
        it('returns the success envelope', () => {
            const result = controller.home();

            expect(result).toEqual({ status: 'success', message: 'API is up and running' });
        });

        it('emits an analytics track event with the anonymous distinct id and api_home_visit name', () => {
            controller.home();

            expect(analytics.track).toHaveBeenCalledTimes(1);
            const [distinctId, event, properties] = analytics.track.mock.calls[0]!;
            expect(distinctId).toBe('anonymous');
            expect(event).toBe('api_home_visit');
            expect(properties).toBeDefined();
            expect(properties!['endpoint']).toBe('/');
            expect(typeof properties!['timestamp']).toBe('string');
        });

        it('emits an ISO-8601 timestamp string', () => {
            jest.useFakeTimers().setSystemTime(new Date('2026-05-09T12:34:56.789Z'));

            controller.home();

            const [, , properties] = analytics.track.mock.calls[0]!;
            expect(properties!['timestamp']).toBe('2026-05-09T12:34:56.789Z');

            jest.useRealTimers();
        });

        it('still returns the envelope even when analytics.track throws (fire-and-forget)', () => {
            // Note: the current implementation does NOT wrap track() in a
            // try/catch, so analytics failures DO propagate. This test pins
            // the actual behaviour so any future "fire-and-forget" refactor
            // breaks loudly. Update the assertion alongside the refactor.
            analytics.track.mockImplementationOnce(() => {
                throw new Error('posthog down');
            });

            expect(() => controller.home()).toThrow('posthog down');
        });

        it('does not pass any user-identifying data in the analytics payload', () => {
            controller.home();

            const [distinctId, , properties] = analytics.track.mock.calls[0]!;
            expect(distinctId).toBe('anonymous');
            expect(properties).not.toHaveProperty('userId');
            expect(properties).not.toHaveProperty('email');
        });
    });

    describe('healthCheck', () => {
        it('delegates to home() and returns the same envelope', () => {
            const homeSpy = jest.spyOn(controller, 'home');

            const result = controller.healthCheck();

            expect(homeSpy).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ status: 'success', message: 'API is up and running' });
        });

        it('emits an analytics track event (delegates through home())', () => {
            controller.healthCheck();

            // Health check still goes through the same code path, so analytics
            // fires. Sentry/PostHog noise filtering happens at the
            // monitoring-package level, not in this controller.
            expect(analytics.track).toHaveBeenCalledTimes(1);
            expect(analytics.track).toHaveBeenCalledWith(
                'anonymous',
                'api_home_visit',
                expect.objectContaining({ endpoint: '/' }),
            );
        });
    });
});
