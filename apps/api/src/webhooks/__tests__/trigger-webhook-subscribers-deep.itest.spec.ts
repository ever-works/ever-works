/**
 * EW-1516 — integration tests #3: deeper subscriber coverage.
 *
 * Combines the persistence subscriber (TriggerRunStatusSubscriber) and
 * the Sentry breadcrumb subscriber in a SINGLE @nestjs/testing module
 * sharing one EventEmitter2 instance. Events are emitted directly on
 * the bus to test subscriber behaviour without the controller +
 * router layers in between.
 *
 * Complements (does NOT replace) the per-subscriber unit specs in
 * apps/api/src/webhooks/subscribers/__tests__/.
 */

// Stub external workspace packages so Jest doesn't have to resolve
// their transitive `@src/...` imports — mirrors the existing
// trigger-run-status.subscriber.spec.ts pattern.
jest.mock('@ever-works/agent/database', () => ({
    WorkGenerationHistoryRepository: class {},
}));

import { Logger } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { WorkGenerationHistoryRepository } from '@ever-works/agent/database';
import { SentryService } from '@ever-works/monitoring';
import { GenerateStatusType } from '@ever-works/contracts/api';
import { TriggerRunStatusSubscriber } from '../subscribers/trigger-run-status.subscriber';
import { TriggerRunFailureSentryBreadcrumbSubscriber } from '../subscribers/trigger-run-failure-sentry-breadcrumb.subscriber';
import {
    TRIGGER_WEBHOOK_EVENTS,
    TriggerWebhookInternalEventName,
    TriggerWebhookInternalEventPayload,
} from '../trigger-webhook-events';

const TENANT_ID = '00000000-0000-0000-0000-0000000000aa';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000bb';

function envelope(
    internalEventName: TriggerWebhookInternalEventName,
    payloadOverrides: Record<string, unknown> = {},
    tenantId: string = TENANT_ID,
): TriggerWebhookInternalEventPayload {
    return {
        tenantId,
        upstreamEventType: internalEventName.replace('trigger.', 'alert.'),
        internalEventName,
        createdAt: '2026-06-22T08:00:00.000Z',
        payload:
            internalEventName === TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED ||
            internalEventName === TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_SUCCEEDED
                ? { deployment: { id: 'dep_xyz' }, ...payloadOverrides }
                : {
                      run: { id: 'run_abc', error: { message: 'oom' } },
                      ...payloadOverrides,
                  },
    };
}

function makeHistoryMock(): jest.Mocked<
    Pick<WorkGenerationHistoryRepository, 'findByTriggerRunId' | 'updateEntry'>
> {
    return {
        findByTriggerRunId: jest.fn(),
        updateEntry: jest.fn(),
    };
}

async function settle(): Promise<void> {
    // EventEmitter2 fires handlers synchronously, but async handlers
    // (TriggerRunStatusSubscriber.handle is async) need a microtask
    // flush before assertions see their writes.
    await new Promise((r) => setImmediate(r));
}

describe('Trigger.dev subscribers — deep integration', () => {
    let module: TestingModule;
    let emitter: EventEmitter2;
    let history: ReturnType<typeof makeHistoryMock>;
    let sentry: jest.Mocked<Pick<SentryService, 'error'>>;
    let logSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    async function buildModule(opts: { withSentry: boolean } = { withSentry: true }) {
        history = makeHistoryMock();
        sentry = { error: jest.fn() };

        const providers: any[] = [
            TriggerRunStatusSubscriber,
            TriggerRunFailureSentryBreadcrumbSubscriber,
            { provide: WorkGenerationHistoryRepository, useValue: history },
        ];
        if (opts.withSentry) {
            providers.push({ provide: SentryService, useValue: sentry });
        }

        module = await Test.createTestingModule({
            imports: [EventEmitterModule.forRoot()],
            providers,
        }).compile();

        await module.init();
        emitter = module.get(EventEmitter2);
    }

    beforeEach(async () => {
        await buildModule({ withSentry: true });
        logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
        debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
        errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(async () => {
        logSpy.mockRestore();
        debugSpy.mockRestore();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
        await module.close();
        jest.resetAllMocks();
    });

    describe('persistence — terminal state machine', () => {
        it.each([
            {
                event: TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED,
                terminal: GenerateStatusType.GENERATED,
            },
            {
                event: TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                terminal: GenerateStatusType.ERROR,
            },
            {
                event: TRIGGER_WEBHOOK_EVENTS.RUN_CANCELLED,
                terminal: GenerateStatusType.CANCELLED,
            },
        ])('GENERATING → $terminal on $event', async ({ event, terminal }) => {
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-1',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-1' } as never);

            emitter.emit(event, envelope(event));
            await settle();

            expect(history.updateEntry).toHaveBeenCalledTimes(1);
            const [id, updates] = history.updateEntry.mock.calls[0];
            expect(id).toBe('hist-1');
            expect(updates.status).toBe(terminal);
            expect(updates.finishedAt).toBeInstanceOf(Date);
        });

        it('finishedAt uses event.createdAt (not Date.now)', async () => {
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-1',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-1' } as never);

            const evt = envelope(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED);
            emitter.emit(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED, evt);
            await settle();

            const finishedAt = history.updateEntry.mock.calls[0][1].finishedAt as Date;
            expect(finishedAt.toISOString()).toBe(evt.createdAt);
        });

        it('out-of-order delivery: cancelled arrives after row already GENERATED → no-op short-circuit', async () => {
            // Row was already flipped to GENERATED by an earlier success
            // delivery; the late cancelled delivery must NOT clobber the
            // terminal state.
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-1',
                status: GenerateStatusType.GENERATED,
            } as never);

            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_CANCELLED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_CANCELLED),
            );
            await settle();

            expect(history.updateEntry).not.toHaveBeenCalled();
            expect(debugSpy).toHaveBeenCalled();
            expect(
                debugSpy.mock.calls.some((c) => String(c[0] ?? '').includes('already terminal')),
            ).toBe(true);
        });

        it.each([
            GenerateStatusType.GENERATED,
            GenerateStatusType.ERROR,
            GenerateStatusType.CANCELLED,
        ])(
            'row already terminal (%s) → short-circuit, no update, no throw',
            async (priorStatus) => {
                history.findByTriggerRunId.mockResolvedValue({
                    id: 'hist-1',
                    status: priorStatus,
                } as never);

                emitter.emit(
                    TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED,
                    envelope(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED),
                );
                await settle();

                expect(history.updateEntry).not.toHaveBeenCalled();
            },
        );

        it('row not found → debug log + drop, no throw, no update', async () => {
            history.findByTriggerRunId.mockResolvedValue(null);

            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED),
            );
            await settle();

            expect(history.updateEntry).not.toHaveBeenCalled();
            expect(
                debugSpy.mock.calls.some((c) =>
                    String(c[0] ?? '').includes('no work_generation_history'),
                ),
            ).toBe(true);
        });

        it('repo.findByTriggerRunId throws → caught + logged, does not propagate', async () => {
            history.findByTriggerRunId.mockRejectedValue(new Error('db down'));

            // emit is synchronous from EventEmitter2; the throw would
            // surface inside the subscriber's try/catch.
            expect(() =>
                emitter.emit(
                    TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                    envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED),
                ),
            ).not.toThrow();
            await settle();

            expect(errorSpy.mock.calls.some((c) => String(c[0] ?? '').includes('db down'))).toBe(
                true,
            );
        });

        it('repo.updateEntry throws → caught + logged, does not propagate', async () => {
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-1',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockRejectedValue(new Error('unique constraint'));

            expect(() =>
                emitter.emit(
                    TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED,
                    envelope(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED),
                ),
            ).not.toThrow();
            await settle();

            expect(
                errorSpy.mock.calls.some((c) => String(c[0] ?? '').includes('unique constraint')),
            ).toBe(true);
        });

        it('errorMessage persisted on RUN_FAILED when payload.run.error.message present', async () => {
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-1',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-1' } as never);

            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED, {
                    run: { id: 'run_abc', error: { message: 'OOM killed' } },
                }),
            );
            await settle();

            expect(history.updateEntry).toHaveBeenCalledWith(
                'hist-1',
                expect.objectContaining({
                    status: GenerateStatusType.ERROR,
                    errorMessage: 'OOM killed',
                }),
            );
        });

        it('errorMessage NOT included on RUN_SUCCEEDED even if payload carries one', async () => {
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-1',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-1' } as never);

            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED, {
                    run: { id: 'run_abc', error: { message: 'leftover' } },
                }),
            );
            await settle();

            const updates = history.updateEntry.mock.calls[0][1];
            expect(updates).not.toHaveProperty('errorMessage');
        });

        it('long errorMessage truncated to 2048 chars + ellipsis', async () => {
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-1',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-1' } as never);

            const huge = 'x'.repeat(3000);
            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED, {
                    run: { id: 'run_abc', error: { message: huge } },
                }),
            );
            await settle();

            const msg = history.updateEntry.mock.calls[0][1].errorMessage as string;
            expect(msg.length).toBe(2049); // 2048 + ellipsis (1 char)
            expect(msg.endsWith('…')).toBe(true);
        });

        it('deployment.* events do NOT trigger persistence handler', async () => {
            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_SUCCEEDED,
                envelope(TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_SUCCEEDED),
            );
            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED),
            );
            await settle();

            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(history.updateEntry).not.toHaveBeenCalled();
        });
    });

    describe('Sentry — failure channel', () => {
        it('RUN_FAILED → SentryService.error called with runId + errorMessage', async () => {
            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED),
            );
            await settle();

            expect(sentry.error).toHaveBeenCalledTimes(1);
            const [msg, attrs] = sentry.error.mock.calls[0];
            expect(String(msg)).toContain('trigger.run.failed');
            expect(attrs).toMatchObject({
                tenantId: TENANT_ID,
                runId: 'run_abc',
                errorMessage: 'oom',
            });
        });

        it('DEPLOYMENT_FAILED → SentryService.error called with deploymentId', async () => {
            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED),
            );
            await settle();

            expect(sentry.error).toHaveBeenCalledTimes(1);
            const [msg, attrs] = sentry.error.mock.calls[0];
            expect(String(msg)).toContain('trigger.deployment.failed');
            expect(attrs).toMatchObject({
                tenantId: TENANT_ID,
                deploymentId: 'dep_xyz',
            });
        });

        it.each([
            TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED,
            TRIGGER_WEBHOOK_EVENTS.RUN_CANCELLED,
            TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_SUCCEEDED,
        ])('non-failure %s does NOT call Sentry', async (eventName) => {
            // Persistence subscriber may consume some of these; rebuild
            // a row so the find call doesn't crash.
            history.findByTriggerRunId.mockResolvedValue(null);

            emitter.emit(eventName, envelope(eventName as TriggerWebhookInternalEventName));
            await settle();

            expect(sentry.error).not.toHaveBeenCalled();
        });

        it('Sentry service absent → falls back to Logger.warn with same fields', async () => {
            await module.close();
            await buildModule({ withSentry: false });
            // Re-attach the warn spy on the fresh module's loggers.
            warnSpy.mockRestore();
            warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED),
            );
            await settle();

            expect(
                warnSpy.mock.calls.some((c) => {
                    const line = String(c[0] ?? '');
                    return (
                        line.includes('trigger.run.failed') &&
                        line.includes('SentryService not bound')
                    );
                }),
            ).toBe(true);
        });

        it('Sentry throws → caught + logged, does not propagate, persistence still runs', async () => {
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-1',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-1' } as never);
            sentry.error.mockImplementation(() => {
                throw new Error('sentry transport hosed');
            });

            expect(() =>
                emitter.emit(
                    TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                    envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED),
                ),
            ).not.toThrow();
            await settle();

            // Persistence still wrote.
            expect(history.updateEntry).toHaveBeenCalledTimes(1);
            // Sentry path logged its caught error.
            expect(
                errorSpy.mock.calls.some((c) =>
                    String(c[0] ?? '').includes('sentry transport hosed'),
                ),
            ).toBe(true);
        });

        it('payload missing run.id → Sentry still called, just without runId attr', async () => {
            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED, {
                    run: { error: { message: 'boom' } },
                }),
            );
            await settle();

            expect(sentry.error).toHaveBeenCalledTimes(1);
            const [, attrs] = sentry.error.mock.calls[0];
            expect(attrs).not.toHaveProperty('runId');
            expect(attrs).toMatchObject({ errorMessage: 'boom' });
        });

        it('Sentry attrs include createdAt + upstreamEventType + internalEventName', async () => {
            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED),
            );
            await settle();

            const [, attrs] = sentry.error.mock.calls[0];
            expect(attrs).toMatchObject({
                upstreamEventType: 'alert.run.failed',
                internalEventName: TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                createdAt: '2026-06-22T08:00:00.000Z',
            });
        });
    });

    describe('subscriber independence', () => {
        it('persistence throws → Sentry subscriber still fires for RUN_FAILED', async () => {
            history.findByTriggerRunId.mockRejectedValue(new Error('db'));

            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED),
            );
            await settle();

            // Persistence subscriber swallowed its error (logged).
            expect(errorSpy.mock.calls.some((c) => String(c[0] ?? '').includes('db'))).toBe(true);
            // Sentry still got called — independent subscriber.
            expect(sentry.error).toHaveBeenCalledTimes(1);
        });

        it('Sentry throws → persistence subscriber still flips terminal state', async () => {
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-1',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-1' } as never);
            sentry.error.mockImplementation(() => {
                throw new Error('sentry');
            });

            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED),
            );
            await settle();

            expect(history.updateEntry).toHaveBeenCalledWith(
                'hist-1',
                expect.objectContaining({ status: GenerateStatusType.ERROR }),
            );
        });

        it('cross-tenant isolation: row for tenant A is not updated by event for tenant B', async () => {
            // The persistence subscriber looks up by triggerRunId only,
            // so cross-tenant safety relies on triggerRunId uniqueness.
            // This test pins that behaviour: an event for OTHER_TENANT
            // that resolves a row with a DIFFERENT tenantId still
            // proceeds (current behaviour); document it explicitly so a
            // future contributor sees the constraint.
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-A',
                status: GenerateStatusType.GENERATING,
                tenantId: TENANT_ID,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-A' } as never);

            emitter.emit(
                TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED,
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED, {}, OTHER_TENANT),
            );
            await settle();

            // Subscriber proceeded with the lookup; pinning current
            // behaviour. If a future change adds a tenant check the
            // assertion below should be flipped to `not.toHaveBeenCalled`.
            expect(history.findByTriggerRunId).toHaveBeenCalledWith('run_abc');
        });
    });
});
