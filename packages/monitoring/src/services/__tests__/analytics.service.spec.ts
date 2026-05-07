// Mock posthog-node so the AnalyticsService captures the singleton client
// (it stores `getPostHogClient()` in a field at construction time).
const captureMock = jest.fn();
const identifyMock = jest.fn();
const shutdownMock = jest.fn().mockResolvedValue(undefined);

jest.mock('posthog-node', () => {
    return {
        PostHog: jest.fn().mockImplementation(() => ({
            capture: captureMock,
            identify: identifyMock,
            shutdown: shutdownMock,
        })),
    };
});

import { initPostHog, shutdownPostHog } from '../../posthog/posthog.config';
import { AnalyticsService } from '../analytics.service';

describe('AnalyticsService', () => {
    afterEach(async () => {
        await shutdownPostHog();
        captureMock.mockClear();
        identifyMock.mockClear();
    });

    describe('isAvailable', () => {
        it('returns false when PostHog is not initialized', () => {
            const svc = new AnalyticsService();
            expect(svc.isAvailable()).toBe(false);
        });

        it('returns true when PostHog has been initialized before construction', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            expect(svc.isAvailable()).toBe(true);
        });
    });

    describe('track / trackEvent', () => {
        it('captures via PostHog client when available', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            svc.track('user-1', 'click', { foo: 'bar' });
            expect(captureMock).toHaveBeenCalledTimes(1);
            const call = captureMock.mock.calls[0][0];
            expect(call.distinctId).toBe('user-1');
            expect(call.event).toBe('click');
            expect(call.properties.foo).toBe('bar');
        });

        it('trackEvent forwards .distinctId/.event/.properties/.groups to track', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            svc.trackEvent({
                distinctId: 'u',
                event: 'evt',
                properties: { a: 1 },
                groups: { tenant: 'acme' },
            });
            expect(captureMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    distinctId: 'u',
                    event: 'evt',
                    properties: expect.objectContaining({ a: 1 }),
                    groups: { tenant: 'acme' },
                }),
            );
        });
    });

    describe('identify / identifyUser / setUserProperties', () => {
        it('identify forwards to PostHog', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            svc.identify('u', { plan: 'pro' });
            expect(identifyMock).toHaveBeenCalledTimes(1);
            expect(identifyMock.mock.calls[0][0].distinctId).toBe('u');
            expect(identifyMock.mock.calls[0][0].properties.plan).toBe('pro');
        });

        it('identifyUser forwards UserProperties shape', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            svc.identifyUser({ distinctId: 'u', properties: { plan: 'free' } });
            expect(identifyMock).toHaveBeenCalledTimes(1);
        });

        it('setUserProperties calls identify (PostHog merges via identify)', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            svc.setUserProperties('u', { region: 'eu' });
            expect(identifyMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('trackApiUsage / trackApiUsageEvent', () => {
        it('tracks an api_usage event with endpoint/method/statusCode/duration', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            svc.trackApiUsage('u', '/works', 'GET', 200, 42);
            expect(captureMock).toHaveBeenCalledTimes(1);
            const call = captureMock.mock.calls[0][0];
            expect(call.event).toBe('api_usage');
            expect(call.properties.endpoint).toBe('/works');
            expect(call.properties.method).toBe('GET');
            expect(call.properties.statusCode).toBe(200);
            expect(call.properties.duration).toBe(42);
            expect(typeof call.properties.timestamp).toBe('string');
        });

        it('trackApiUsageEvent unpacks the event into trackApiUsage', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            svc.trackApiUsageEvent({
                distinctId: 'u',
                endpoint: '/x',
                method: 'POST',
                statusCode: 201,
                duration: 12,
            });
            expect(captureMock).toHaveBeenCalledTimes(1);
            const call = captureMock.mock.calls[0][0];
            expect(call.properties.endpoint).toBe('/x');
            expect(call.properties.method).toBe('POST');
            expect(call.properties.statusCode).toBe(201);
            expect(call.properties.duration).toBe(12);
        });
    });

    describe('trackAuth / trackAuthEvent', () => {
        it('tracks auth_<event> with timestamp', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            svc.trackAuth('u', 'login', { method: 'password' });
            const call = captureMock.mock.calls[0][0];
            expect(call.event).toBe('auth_login');
            expect(call.properties.method).toBe('password');
            expect(typeof call.properties.timestamp).toBe('string');
        });

        it.each(['login', 'logout', 'register', 'password_reset'] as const)(
            'tracks auth_%s as auth_<event>',
            (event) => {
                initPostHog({ apiKey: 'k' });
                const svc = new AnalyticsService();
                svc.trackAuthEvent({ distinctId: 'u', event });
                expect(captureMock).toHaveBeenLastCalledWith(
                    expect.objectContaining({ event: `auth_${event}` }),
                );
            },
        );
    });

    describe('trackBusinessEvent / trackBusinessEventEvent', () => {
        it('tracks business_<event> with timestamp', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            svc.trackBusinessEvent('u', 'subscription_upgraded', { plan: 'team' });
            const call = captureMock.mock.calls[0][0];
            expect(call.event).toBe('business_subscription_upgraded');
            expect(call.properties.plan).toBe('team');
            expect(typeof call.properties.timestamp).toBe('string');
        });

        it('trackBusinessEventEvent forwards the event to trackBusinessEvent', () => {
            initPostHog({ apiKey: 'k' });
            const svc = new AnalyticsService();
            svc.trackBusinessEventEvent({
                distinctId: 'u',
                event: 'work_published',
                properties: { id: 'w1' },
            });
            const call = captureMock.mock.calls[0][0];
            expect(call.event).toBe('business_work_published');
            expect(call.properties.id).toBe('w1');
        });
    });

    describe('when PostHog is NOT initialized', () => {
        it('track does not throw and does not call capture', () => {
            const svc = new AnalyticsService();
            expect(() => svc.track('u', 'x')).not.toThrow();
            expect(captureMock).not.toHaveBeenCalled();
        });

        it('identify does not throw and does not call identify', () => {
            const svc = new AnalyticsService();
            expect(() => svc.identify('u', { p: 1 })).not.toThrow();
            expect(identifyMock).not.toHaveBeenCalled();
        });
    });
});
