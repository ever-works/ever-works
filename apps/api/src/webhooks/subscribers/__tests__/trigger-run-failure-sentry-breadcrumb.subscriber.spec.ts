import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { SentryService } from '@ever-works/monitoring';
import { TriggerRunFailureSentryBreadcrumbSubscriber } from '../trigger-run-failure-sentry-breadcrumb.subscriber';
import {
    TRIGGER_WEBHOOK_EVENTS,
    TriggerWebhookInternalEventName,
    TriggerWebhookInternalEventPayload,
} from '../../trigger-webhook-events';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function envelope(
    internalEventName: TriggerWebhookInternalEventName,
    payloadOverrides: Record<string, unknown> = {},
): TriggerWebhookInternalEventPayload {
    return {
        tenantId: TENANT_ID,
        upstreamEventType: internalEventName.replace('trigger.', 'alert.'),
        internalEventName,
        createdAt: '2026-06-21T12:00:00.000Z',
        payload:
            internalEventName === TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED
                ? {
                      deployment: { id: 'dep_xyz' },
                      ...payloadOverrides,
                  }
                : {
                      run: { id: 'run_abc', error: { message: 'oom' } },
                      ...payloadOverrides,
                  },
    };
}

describe('TriggerRunFailureSentryBreadcrumbSubscriber', () => {
    let module: TestingModule;
    let subscriber: TriggerRunFailureSentryBreadcrumbSubscriber;
    let sentry: jest.Mocked<SentryService>;
    let emitter: EventEmitter2;
    let warnSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(async () => {
        const sentryMock: jest.Mocked<Partial<SentryService>> = {
            error: jest.fn(),
        };

        module = await Test.createTestingModule({
            imports: [EventEmitterModule.forRoot()],
            providers: [
                TriggerRunFailureSentryBreadcrumbSubscriber,
                { provide: SentryService, useValue: sentryMock },
            ],
        }).compile();

        await module.init();

        subscriber = module.get(TriggerRunFailureSentryBreadcrumbSubscriber);
        sentry = module.get(SentryService) as jest.Mocked<SentryService>;
        emitter = module.get(EventEmitter2);

        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });

    afterEach(async () => {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        await module.close();
        jest.resetAllMocks();
    });

    it('logs to Sentry with runId + tenantId on trigger.run.failed', () => {
        subscriber.onRunFailed(envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED));

        expect(sentry.error).toHaveBeenCalledTimes(1);
        const [msg, attrs] = sentry.error.mock.calls[0];
        expect(String(msg)).toContain('trigger.run.failed');
        expect(String(msg)).toContain(TENANT_ID);
        expect(attrs).toMatchObject({
            tenantId: TENANT_ID,
            runId: 'run_abc',
            errorMessage: 'oom',
            internalEventName: TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
            upstreamEventType: 'alert.run.failed',
        });
    });

    it('logs to Sentry with deploymentId + tenantId on trigger.deployment.failed', () => {
        subscriber.onDeploymentFailed(envelope(TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED));

        expect(sentry.error).toHaveBeenCalledTimes(1);
        const [msg, attrs] = sentry.error.mock.calls[0];
        expect(String(msg)).toContain('trigger.deployment.failed');
        expect(attrs).toMatchObject({
            tenantId: TENANT_ID,
            deploymentId: 'dep_xyz',
            internalEventName: TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED,
        });
    });

    it('is idempotent — two identical deliveries produce two identical Sentry calls', () => {
        const evt = envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED);
        subscriber.onRunFailed(evt);
        subscriber.onRunFailed(evt);
        expect(sentry.error).toHaveBeenCalledTimes(2);
        expect(sentry.error.mock.calls[0]).toEqual(sentry.error.mock.calls[1]);
    });

    it('drops payload missing run.id gracefully (no runId attr; Sentry still called)', () => {
        subscriber.onRunFailed(
            envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED, { run: { error: { message: 'oom' } } }),
        );

        expect(sentry.error).toHaveBeenCalledTimes(1);
        const [, attrs] = sentry.error.mock.calls[0];
        expect(attrs).not.toHaveProperty('runId');
        expect(attrs).toMatchObject({ tenantId: TENANT_ID, errorMessage: 'oom' });
    });

    it('falls back to Logger.warn when SentryService is not bound', async () => {
        await module.close();

        // Re-build the module without binding SentryService — the
        // @Optional() decorator on the subscriber means it constructs
        // with `undefined` and routes the line through Nest Logger.
        module = await Test.createTestingModule({
            imports: [EventEmitterModule.forRoot()],
            providers: [TriggerRunFailureSentryBreadcrumbSubscriber],
        }).compile();
        await module.init();
        subscriber = module.get(TriggerRunFailureSentryBreadcrumbSubscriber);

        subscriber.onRunFailed(envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED));

        expect(warnSpy).toHaveBeenCalled();
        const line = String(warnSpy.mock.calls[0][0]);
        expect(line).toContain('trigger.run.failed');
        expect(line).toContain(TENANT_ID);
        expect(line).toContain('run_abc');
        expect(line).toContain('SentryService not bound');
    });

    it('catches + logs when SentryService.error throws — does not propagate', () => {
        sentry.error.mockImplementation(() => {
            throw new Error('sentry transport down');
        });

        expect(() =>
            subscriber.onRunFailed(envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED)),
        ).not.toThrow();
        expect(errorSpy).toHaveBeenCalled();
        expect(String(errorSpy.mock.calls[0][0])).toContain('sentry transport down');
    });

    it('does NOT react to run.succeeded / run.cancelled (only failures)', async () => {
        emitter.emit(
            TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED,
            envelope(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED),
        );
        emitter.emit(
            TRIGGER_WEBHOOK_EVENTS.RUN_CANCELLED,
            envelope(TRIGGER_WEBHOOK_EVENTS.RUN_CANCELLED),
        );
        emitter.emit(
            TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_SUCCEEDED,
            envelope(TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_SUCCEEDED),
        );
        await new Promise((resolve) => setImmediate(resolve));

        expect(sentry.error).not.toHaveBeenCalled();
    });

    it('wires both @OnEvent failure listeners end-to-end via EventEmitter2', async () => {
        emitter.emit(
            TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
            envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED),
        );
        emitter.emit(
            TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED,
            envelope(TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED),
        );
        await new Promise((resolve) => setImmediate(resolve));

        expect(sentry.error).toHaveBeenCalledTimes(2);
    });
});
