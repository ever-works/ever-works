import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TriggerWebhookEventRouterService } from '../trigger-webhook-event-router.service';
import {
    TRIGGER_WEBHOOK_EVENTS,
    TriggerWebhookInternalEventPayload,
} from '../trigger-webhook-events';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '00000000-0000-0000-0000-000000000002';

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        event_type: 'alert.run.succeeded',
        tenant_id: TENANT_ID,
        created_at: '2026-06-21T12:00:00.000Z',
        payload: { run: { id: 'run_abc', status: 'COMPLETED' } },
        ...overrides,
    };
}

describe('TriggerWebhookEventRouterService', () => {
    let emitter: EventEmitter2;
    let emitSpy: jest.SpyInstance;
    let router: TriggerWebhookEventRouterService;
    let warnSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        emitter = new EventEmitter2();
        emitSpy = jest.spyOn(emitter, 'emit');
        router = new TriggerWebhookEventRouterService(emitter);
        // Logger swallows so noisy assertions don't pollute the test
        // run — but still allow us to spy on calls.
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    });

    afterEach(() => {
        warnSpy.mockRestore();
        debugSpy.mockRestore();
        jest.resetAllMocks();
    });

    describe('known event types', () => {
        // Parameterised: each supported upstream type maps to the
        // documented internal event name, and the emitted envelope
        // surfaces the route-authoritative tenantId + opaque payload.
        const supportedCases: Array<{ upstream: string; internal: string }> = [
            { upstream: 'alert.run.succeeded', internal: TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED },
            { upstream: 'alert.run.failed', internal: TRIGGER_WEBHOOK_EVENTS.RUN_FAILED },
            { upstream: 'alert.run.cancelled', internal: TRIGGER_WEBHOOK_EVENTS.RUN_CANCELLED },
            {
                upstream: 'alert.deployment.success',
                internal: TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_SUCCEEDED,
            },
            {
                upstream: 'alert.deployment.failed',
                internal: TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED,
            },
        ];

        it.each(supportedCases)(
            'maps upstream "$upstream" → internal "$internal"',
            ({ upstream, internal }) => {
                const body = envelope({ event_type: upstream });
                const emitted = router.route(TENANT_ID, body);

                expect(emitted).toBe(true);
                expect(emitSpy).toHaveBeenCalledTimes(1);
                const [emittedName, emittedPayload] = emitSpy.mock.calls[0] as [
                    string,
                    TriggerWebhookInternalEventPayload,
                ];
                expect(emittedName).toBe(internal);
                expect(emittedPayload.tenantId).toBe(TENANT_ID);
                expect(emittedPayload.upstreamEventType).toBe(upstream);
                expect(emittedPayload.internalEventName).toBe(internal);
                expect(emittedPayload.createdAt).toBe('2026-06-21T12:00:00.000Z');
                // The verified upstream payload is forwarded opaquely.
                expect(emittedPayload.payload).toEqual({
                    run: { id: 'run_abc', status: 'COMPLETED' },
                });
            },
        );
    });

    it('drops unknown event_type with a debug log and no emission', () => {
        const body = envelope({ event_type: 'alert.some.future.thing' });

        const emitted = router.route(TENANT_ID, body);

        expect(emitted).toBe(false);
        expect(emitSpy).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalledTimes(1);
        expect(String(debugSpy.mock.calls[0][0])).toContain('alert.some.future.thing');
    });

    it('drops malformed envelope (missing event_type) without throwing', () => {
        const body = { tenant_id: TENANT_ID, created_at: 'x', payload: {} };

        expect(() => router.route(TENANT_ID, body)).not.toThrow();
        expect(router.route(TENANT_ID, body)).toBe(false);
        expect(emitSpy).not.toHaveBeenCalled();
        // Two warn lines because we called route() twice above.
        expect(warnSpy).toHaveBeenCalled();
        expect(String(warnSpy.mock.calls[0][0])).toContain('malformed envelope');
    });

    it.each([
        [
            'missing payload',
            { event_type: 'alert.run.failed', tenant_id: TENANT_ID, created_at: 'x' },
        ],
        [
            'payload is an array (not an object)',
            {
                event_type: 'alert.run.failed',
                tenant_id: TENANT_ID,
                created_at: 'x',
                payload: [1, 2, 3],
            },
        ],
        [
            'empty tenant_id string',
            {
                event_type: 'alert.run.failed',
                tenant_id: '',
                created_at: 'x',
                payload: {},
            },
        ],
        ['null body', null],
        ['string body', 'just-a-string'],
    ])('drops malformed envelope (%s) without throwing', (_label, body) => {
        const emitted = router.route(TENANT_ID, body);
        expect(emitted).toBe(false);
        expect(emitSpy).not.toHaveBeenCalled();
    });

    it('logs warn but still emits when body tenant_id differs from route tenantId', () => {
        const body = envelope({ tenant_id: OTHER_TENANT });

        const emitted = router.route(TENANT_ID, body);

        expect(emitted).toBe(true);
        expect(emitSpy).toHaveBeenCalledTimes(1);
        const [, emittedPayload] = emitSpy.mock.calls[0] as [
            string,
            TriggerWebhookInternalEventPayload,
        ];
        // Route value wins — body value is ignored on the envelope.
        expect(emittedPayload.tenantId).toBe(TENANT_ID);
        expect(warnSpy).toHaveBeenCalled();
        const warn = String(warnSpy.mock.calls[0][0]);
        expect(warn).toContain('tenantId mismatch');
        expect(warn).toContain(TENANT_ID);
        expect(warn).toContain(OTHER_TENANT);
    });

    it('does NOT de-duplicate identical deliveries — emits twice for two identical envelopes', () => {
        // Idempotency is a subscriber concern. Trigger.dev documents
        // at-least-once delivery, so a redelivery (same event id, same
        // body) should still emit — otherwise transient subscriber
        // failures would silently drop legit retries.
        const body = envelope();

        const first = router.route(TENANT_ID, body);
        const second = router.route(TENANT_ID, body);

        expect(first).toBe(true);
        expect(second).toBe(true);
        expect(emitSpy).toHaveBeenCalledTimes(2);
        expect(emitSpy.mock.calls[0][0]).toBe(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED);
        expect(emitSpy.mock.calls[1][0]).toBe(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED);
    });
});
