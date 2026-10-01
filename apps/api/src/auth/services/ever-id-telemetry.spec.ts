import {
    EVER_ID_TELEMETRY_ANONYMOUS_ID,
    EVER_ID_TELEMETRY_EVENTS,
    EverIdTelemetryService,
    sanitize,
} from './ever-id-telemetry.service';

/**
 * APW-12 (Ever ID) — telemetry carries counters and closed-set labels only
 * (plan §9.1, NFR-8, ACC-12-37): no e-mail, subject, issuer URL, token, code or
 * `state` can leave through it, even by mistake.
 */
describe('EverIdTelemetryService', () => {
    it('pins the closed event set', () => {
        expect(Object.values(EVER_ID_TELEMETRY_EVENTS)).toEqual([
            'ever_id.sign_in.started',
            'ever_id.sign_in.completed',
            'ever_id.sign_up.confirmed',
            'ever_id.identity.linked',
            'ever_id.identity.unlinked',
            'ever_id.backchannel.received',
            'ever_id.device.exchanged',
            'ever_id.delegated.read',
            'ever_id.provider.unavailable',
        ]);
    });

    it('drops every property that is free text', () => {
        expect(
            sanitize({
                outcome: 'signedIn',
                durationMs: 412,
                emailsDiffer: true,
                email: 'person@example.com',
                issuer: 'https://id.example.test',
                token: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln',
                state: 'Zm9vYmFyYmF6cXV4LXNvbWUtc3RhdGUtdmFsdWUtdGhhdC1pcy1sb25n',
                nan: Number.NaN,
            }),
        ).toEqual({ outcome: 'signedIn', durationMs: 412, emailsDiffer: true });
    });

    it('sends through the analytics service with an anonymous id when no account is known', () => {
        const analytics = { track: jest.fn() };
        const telemetry = new EverIdTelemetryService(analytics as never);

        telemetry.emit(EVER_ID_TELEMETRY_EVENTS.SIGN_IN_STARTED, { intent: 'sign-in' });
        telemetry.emit(EVER_ID_TELEMETRY_EVENTS.SIGN_UP_CONFIRMED, {}, 'user-1');

        expect(analytics.track).toHaveBeenNthCalledWith(
            1,
            EVER_ID_TELEMETRY_ANONYMOUS_ID,
            'ever_id.sign_in.started',
            {
                intent: 'sign-in',
            },
        );
        expect(analytics.track).toHaveBeenNthCalledWith(
            2,
            'user-1',
            'ever_id.sign_up.confirmed',
            {},
        );
    });

    it('is a no-op without an analytics service and never throws', () => {
        expect(() =>
            new EverIdTelemetryService().emit(EVER_ID_TELEMETRY_EVENTS.DELEGATED_READ, {}),
        ).not.toThrow();
        const failing = new EverIdTelemetryService({
            track: () => {
                throw new Error('down');
            },
        } as never);
        expect(() => failing.emit(EVER_ID_TELEMETRY_EVENTS.DELEGATED_READ, {})).not.toThrow();
    });
});
