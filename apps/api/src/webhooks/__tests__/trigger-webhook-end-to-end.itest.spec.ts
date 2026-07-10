/**
 * EW-1516 — integration tests #1: full controller → router → subscribers chain.
 *
 * Wires the receiver, router, and BOTH subscribers in a single
 * @nestjs/testing module. Mocks the tenant overlay repo + secret
 * store + WorkGenerationHistoryRepository + SentryService. Uses a
 * REAL EventEmitter2 instance so subscriber @OnEvent bindings fire
 * end-to-end after a controller call returns 200.
 *
 * Tests cover:
 *  - Happy path per supported event type (5 events).
 *  - Idempotency: same delivery twice → row terminal-stable.
 *  - Cross-tenant safety at the controller layer.
 *  - Replay storm: 10 valid deliveries in flight.
 *  - Malformed envelope → 200 ack, router drops, no subscriber fires.
 *  - Invalid signature → 401, NO router call, NO subscriber call.
 *  - Unknown tenant → 404, NO router call, NO subscriber call.
 */

// Stub external workspace imports so Jest doesn't pull the auth /
// agent transitive chain. Mirrors the per-spec patterns used by the
// existing controller + subscriber unit tests.
jest.mock('../../auth/decorators/public.decorator', () => ({ Public: () => () => undefined }));
jest.mock('@ever-works/agent/entities', () => ({ TenantJobRuntimeConfig: class {} }));
jest.mock('@ever-works/agent/tasks', () => ({
    SECRET_STORE_RESOLVER: Symbol.for('SECRET_STORE_RESOLVER_TEST_E2E'),
}));
jest.mock('@ever-works/agent/database', () => ({
    WorkGenerationHistoryRepository: class {},
}));

import { Logger } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHmac } from 'crypto';

// eslint-disable-next-line import/first
import { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
// eslint-disable-next-line import/first
import { SECRET_STORE_RESOLVER } from '@ever-works/agent/tasks';
// eslint-disable-next-line import/first
import type { SecretStoreResolver } from '@ever-works/agent/tasks';
// eslint-disable-next-line import/first
import { WorkGenerationHistoryRepository } from '@ever-works/agent/database';
// eslint-disable-next-line import/first
import { SentryService } from '@ever-works/monitoring';
// eslint-disable-next-line import/first
import { GenerateStatusType } from '@ever-works/contracts/api';
// eslint-disable-next-line import/first
import { TriggerWebhookController } from '../trigger-webhook.controller';
// eslint-disable-next-line import/first
import { TriggerWebhookEventRouterService } from '../trigger-webhook-event-router.service';
// eslint-disable-next-line import/first
import { TriggerRunStatusSubscriber } from '../subscribers/trigger-run-status.subscriber';
// eslint-disable-next-line import/first
import { TriggerRunFailureSentryBreadcrumbSubscriber } from '../subscribers/trigger-run-failure-sentry-breadcrumb.subscriber';
// eslint-disable-next-line import/first
import { TRIGGER_WEBHOOK_EVENTS } from '../trigger-webhook-events';

const TENANT_ID = '00000000-0000-0000-0000-000000000111';
const OTHER_TENANT = '00000000-0000-0000-0000-000000000222';
const SECRET = 'super-secret-webhook-key-e2e';
const POINTER = 'inline:dGVzdA==';

type TenantRow = { tenantId: string; credentialsSecretRef: string | null };

function signBody(body: string, secret: string): string {
    const hex = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    return `sha256=${hex}`;
}

function envelope(opts: {
    eventType: string;
    runId?: string;
    deploymentId?: string;
    errorMessage?: string;
    tenantId?: string;
    createdAt?: string;
}): string {
    const payload: Record<string, unknown> = {};
    if (opts.runId) {
        const run: Record<string, unknown> = { id: opts.runId };
        if (opts.errorMessage) run.error = { message: opts.errorMessage };
        payload.run = run;
    }
    if (opts.deploymentId) {
        const dep: Record<string, unknown> = { id: opts.deploymentId };
        if (opts.errorMessage) dep.error = { message: opts.errorMessage };
        payload.deployment = dep;
    }
    return JSON.stringify({
        event_type: opts.eventType,
        tenant_id: opts.tenantId ?? TENANT_ID,
        created_at: opts.createdAt ?? '2026-06-22T08:00:00.000Z',
        payload,
    });
}

async function settle(): Promise<void> {
    // EventEmitter2 fires async @OnEvent handlers on the microtask queue;
    // flush before assertions that observe persistence writes.
    await new Promise((r) => setImmediate(r));
}

describe('Trigger.dev webhook — controller → router → subscribers (end-to-end)', () => {
    let module: TestingModule;
    let controller: TriggerWebhookController;
    let tenantRepo: { findOne: jest.Mock<Promise<TenantRow | null>, [unknown]> };
    let secretStore: jest.Mocked<SecretStoreResolver>;
    let history: jest.Mocked<
        Pick<WorkGenerationHistoryRepository, 'findByTriggerRunId' | 'updateEntry'>
    >;
    let sentry: jest.Mocked<Pick<SentryService, 'error'>>;
    let logSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(async () => {
        tenantRepo = { findOne: jest.fn() };
        secretStore = { resolve: jest.fn() } as jest.Mocked<SecretStoreResolver>;
        history = {
            findByTriggerRunId: jest.fn(),
            updateEntry: jest.fn(),
        };
        sentry = { error: jest.fn() };

        module = await Test.createTestingModule({
            imports: [EventEmitterModule.forRoot()],
            controllers: [TriggerWebhookController],
            providers: [
                TriggerWebhookEventRouterService,
                TriggerRunStatusSubscriber,
                TriggerRunFailureSentryBreadcrumbSubscriber,
                { provide: getRepositoryToken(TenantJobRuntimeConfig), useValue: tenantRepo },
                { provide: SECRET_STORE_RESOLVER, useValue: secretStore },
                { provide: WorkGenerationHistoryRepository, useValue: history },
                { provide: SentryService, useValue: sentry },
            ],
        }).compile();

        await module.init();
        controller = module.get(TriggerWebhookController);

        logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
        errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });

    afterEach(async () => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        debugSpy.mockRestore();
        errorSpy.mockRestore();
        await module.close();
        jest.resetAllMocks();
    });

    function arrangeKnownTenant(): void {
        tenantRepo.findOne.mockResolvedValue({
            tenantId: TENANT_ID,
            credentialsSecretRef: POINTER,
        });
        secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });
    }

    async function deliver(
        eventType: string,
        opts: {
            runId?: string;
            deploymentId?: string;
            errorMessage?: string;
            tenantId?: string;
            createdAt?: string;
            secret?: string;
            tamper?: boolean;
        } = {},
    ): Promise<unknown> {
        const body = envelope({
            eventType,
            runId: opts.runId,
            deploymentId: opts.deploymentId,
            errorMessage: opts.errorMessage,
            tenantId: opts.tenantId,
            createdAt: opts.createdAt,
        });
        const sig = opts.tamper
            ? 'sha256=' + '0'.repeat(64)
            : signBody(body, opts.secret ?? SECRET);
        return controller.receive(TENANT_ID, { rawBody: body }, { 'x-trigger-signature': sig });
    }

    describe('happy path per event type (5 events)', () => {
        it('alert.run.succeeded → 200 + persistence flips row to GENERATED + NO Sentry call', async () => {
            arrangeKnownTenant();
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-s',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-s' } as never);

            const result = await deliver('alert.run.succeeded', { runId: 'run_s' });
            await settle();

            expect(result).toEqual({ ok: true });
            expect(history.findByTriggerRunId).toHaveBeenCalledWith('run_s');
            expect(history.updateEntry).toHaveBeenCalledWith(
                'hist-s',
                expect.objectContaining({ status: GenerateStatusType.GENERATED }),
            );
            expect(sentry.error).not.toHaveBeenCalled();
        });

        it('alert.run.failed → 200 + persistence flips to ERROR + Sentry called with runId+errorMessage', async () => {
            arrangeKnownTenant();
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-f',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-f' } as never);

            const result = await deliver('alert.run.failed', {
                runId: 'run_f',
                errorMessage: 'task crashed',
            });
            await settle();

            expect(result).toEqual({ ok: true });
            expect(history.updateEntry).toHaveBeenCalledWith(
                'hist-f',
                expect.objectContaining({
                    status: GenerateStatusType.ERROR,
                    errorMessage: 'task crashed',
                }),
            );
            expect(sentry.error).toHaveBeenCalledTimes(1);
            const [msg, attrs] = sentry.error.mock.calls[0];
            expect(String(msg)).toContain('trigger.run.failed');
            expect(attrs).toMatchObject({
                tenantId: TENANT_ID,
                runId: 'run_f',
                errorMessage: 'task crashed',
            });
        });

        it('alert.run.cancelled → 200 + persistence flips to CANCELLED + NO Sentry call', async () => {
            arrangeKnownTenant();
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-c',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-c' } as never);

            const result = await deliver('alert.run.cancelled', { runId: 'run_c' });
            await settle();

            expect(result).toEqual({ ok: true });
            expect(history.updateEntry).toHaveBeenCalledWith(
                'hist-c',
                expect.objectContaining({ status: GenerateStatusType.CANCELLED }),
            );
            expect(sentry.error).not.toHaveBeenCalled();
        });

        it('alert.deployment.success → 200 + NO persistence write + NO Sentry call', async () => {
            arrangeKnownTenant();

            const result = await deliver('alert.deployment.success', {
                deploymentId: 'dep_ok',
            });
            await settle();

            expect(result).toEqual({ ok: true });
            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(history.updateEntry).not.toHaveBeenCalled();
            expect(sentry.error).not.toHaveBeenCalled();
        });

        it('alert.deployment.failed → 200 + NO persistence write + Sentry called with deploymentId', async () => {
            arrangeKnownTenant();

            const result = await deliver('alert.deployment.failed', {
                deploymentId: 'dep_bad',
                errorMessage: 'image pull failed',
            });
            await settle();

            expect(result).toEqual({ ok: true });
            expect(history.updateEntry).not.toHaveBeenCalled();
            expect(sentry.error).toHaveBeenCalledTimes(1);
            const [msg, attrs] = sentry.error.mock.calls[0];
            expect(String(msg)).toContain('trigger.deployment.failed');
            expect(attrs).toMatchObject({
                tenantId: TENANT_ID,
                deploymentId: 'dep_bad',
                errorMessage: 'image pull failed',
            });
        });

        it('controller logs the received event metadata on accept', async () => {
            arrangeKnownTenant();

            // The controller logs `payload?.id` and `payload?.type`
            // (the receiver's TriggerWebhookPayload interface — top-
            // level id/type fields). The envelope() helper builds the
            // router-shape body (`event_type` + `tenant_id` + payload),
            // so we hand-roll a body here with the receiver-side
            // fields PLUS the router-shape fields so both layers log
            // something useful.
            const body = JSON.stringify({
                id: 'evt_log',
                type: 'run.succeeded',
                event_type: 'alert.run.succeeded',
                tenant_id: TENANT_ID,
                created_at: '2026-06-22T00:00:00.000Z',
                payload: { run: { id: 'run_log' } },
            });
            await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            );

            // Controller log line: includes tenantId + the top-level
            // id/type fields it surfaces from the receiver-side payload.
            const logLines = logSpy.mock.calls.map((c) => String(c[0] ?? ''));
            expect(logLines.some((l) => l.includes(TENANT_ID))).toBe(true);
            expect(logLines.some((l) => l.includes('evt_log'))).toBe(true);
            expect(logLines.some((l) => l.includes('run.succeeded'))).toBe(true);
        });
    });

    describe('idempotency — at-least-once delivery semantics', () => {
        it('same RUN_SUCCEEDED delivered twice → row terminal-stable, ONE update + ONE no-op', async () => {
            arrangeKnownTenant();
            // Delivery #1: row still GENERATING, gets flipped.
            history.findByTriggerRunId.mockResolvedValueOnce({
                id: 'hist-idem',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValueOnce({ id: 'hist-idem' } as never);
            // Delivery #2: row now GENERATED (matches what we wrote).
            history.findByTriggerRunId.mockResolvedValueOnce({
                id: 'hist-idem',
                status: GenerateStatusType.GENERATED,
            } as never);

            await deliver('alert.run.succeeded', { runId: 'run_idem' });
            await settle();
            await deliver('alert.run.succeeded', { runId: 'run_idem' });
            await settle();

            // Persistence: one write (the second short-circuits).
            expect(history.updateEntry).toHaveBeenCalledTimes(1);
        });

        it('same RUN_FAILED delivered twice → Sentry called TWICE (subscriber is intentionally stateless)', async () => {
            // Documented in trigger-run-failure-sentry-breadcrumb.subscriber.ts
            // class header: "Idempotent: a duplicate delivery produces a
            // duplicate log line. That's fine — operators correlate by
            // runId and de-dup mentally". This test pins that contract.
            arrangeKnownTenant();
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-2x',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-2x' } as never);

            await deliver('alert.run.failed', { runId: 'run_2x', errorMessage: 'e' });
            await settle();
            await deliver('alert.run.failed', { runId: 'run_2x', errorMessage: 'e' });
            await settle();

            expect(sentry.error).toHaveBeenCalledTimes(2);
        });
    });

    describe('cross-tenant safety', () => {
        it('event for tenant A in body → persistence still looks up by triggerRunId (route value wins)', async () => {
            // The body declares OTHER_TENANT but the route param is
            // TENANT_ID — the router emits with TENANT_ID, and the
            // persistence subscriber's lookup key is the triggerRunId
            // (cross-tenant safety relies on runId uniqueness).
            arrangeKnownTenant();
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-x',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-x' } as never);

            await deliver('alert.run.failed', {
                runId: 'run_x',
                tenantId: OTHER_TENANT,
            });
            await settle();

            // Sentry attr should carry the ROUTE tenantId, NOT the body's.
            const [, attrs] = sentry.error.mock.calls[0];
            expect(attrs).toMatchObject({ tenantId: TENANT_ID });
            // Router logged the mismatch.
            expect(
                warnSpy.mock.calls.some((c) => String(c[0] ?? '').includes('tenantId mismatch')),
            ).toBe(true);
        });

        it('persistence subscriber NEVER sees the body tenant_id', async () => {
            arrangeKnownTenant();
            history.findByTriggerRunId.mockResolvedValue({
                id: 'hist-x2',
                status: GenerateStatusType.GENERATING,
            } as never);
            history.updateEntry.mockResolvedValue({ id: 'hist-x2' } as never);

            await deliver('alert.run.succeeded', {
                runId: 'run_x2',
                tenantId: OTHER_TENANT,
            });
            await settle();

            // The subscriber's only input is `triggerRunId`. It doesn't
            // call any tenant-scoped repo method — verifying it received
            // a runId-only call pins the cross-tenant boundary.
            expect(history.findByTriggerRunId).toHaveBeenCalledWith('run_x2');
        });
    });

    describe('replay storm', () => {
        it('10 valid distinct deliveries in flight → each persists + no throws', async () => {
            arrangeKnownTenant();
            // Round-robin different runIds — each one has its own
            // history row in GENERATING state.
            history.findByTriggerRunId.mockImplementation(
                async (runId: string) =>
                    ({
                        id: `hist-${runId}`,
                        status: GenerateStatusType.GENERATING,
                    }) as never,
            );
            history.updateEntry.mockImplementation(async (id: string) => ({ id }) as never);

            const deliveries = Array.from({ length: 10 }, (_, i) =>
                deliver('alert.run.succeeded', { runId: `run_${i}` }),
            );

            await expect(Promise.all(deliveries)).resolves.toBeDefined();
            await settle();

            // Each delivery is independent; persistence sees 10 lookups
            // + 10 updates (no de-dup since runIds differ).
            expect(history.findByTriggerRunId).toHaveBeenCalledTimes(10);
            expect(history.updateEntry).toHaveBeenCalledTimes(10);
        });

        it('10 IDENTICAL deliveries in flight → 1 write + 9 no-op short-circuits', async () => {
            arrangeKnownTenant();
            // First call sees GENERATING; subsequent calls (after the
            // mock's mutation below) see GENERATED. We simulate the
            // persisted state-machine view by flipping the mock's
            // return value once the first write resolves.
            let observedStatus = GenerateStatusType.GENERATING;
            history.findByTriggerRunId.mockImplementation(
                async () =>
                    ({
                        id: 'hist-storm',
                        status: observedStatus,
                    }) as never,
            );
            history.updateEntry.mockImplementation(async () => {
                observedStatus = GenerateStatusType.GENERATED;
                return { id: 'hist-storm' } as never;
            });

            // Sequential to make the state-flip deterministic — a true
            // race would land >1 write, which is acceptable per the
            // class header's "Idempotent at the SQL layer" note but
            // unrelated to what this test is pinning.
            for (let i = 0; i < 10; i++) {
                await deliver('alert.run.succeeded', { runId: 'run_storm' });
                await settle();
            }

            expect(history.updateEntry).toHaveBeenCalledTimes(1);
        });
    });

    describe('malformed envelope', () => {
        it('missing event_type → 200 ack, router drops, NO subscriber fires', async () => {
            arrangeKnownTenant();
            const body = JSON.stringify({
                tenant_id: TENANT_ID,
                created_at: '2026-06-22T00:00:00.000Z',
                payload: { run: { id: 'run_x' } },
            });

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            );
            await settle();

            expect(result).toEqual({ ok: true });
            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(sentry.error).not.toHaveBeenCalled();
            expect(
                warnSpy.mock.calls.some((c) => String(c[0] ?? '').includes('malformed envelope')),
            ).toBe(true);
        });

        it('missing payload → 200 ack, router drops, NO subscriber fires', async () => {
            arrangeKnownTenant();
            const body = JSON.stringify({
                event_type: 'alert.run.failed',
                tenant_id: TENANT_ID,
                created_at: '2026-06-22T00:00:00.000Z',
            });

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            );
            await settle();

            expect(result).toEqual({ ok: true });
            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(sentry.error).not.toHaveBeenCalled();
        });

        it('missing tenant_id → 200 ack, router drops, NO subscriber fires', async () => {
            arrangeKnownTenant();
            const body = JSON.stringify({
                event_type: 'alert.run.failed',
                created_at: '2026-06-22T00:00:00.000Z',
                payload: { run: { id: 'run_y' } },
            });

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            );
            await settle();

            expect(result).toEqual({ ok: true });
            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(sentry.error).not.toHaveBeenCalled();
        });

        it('unmapped event_type → 200 ack, router debug-drops, NO subscriber fires', async () => {
            arrangeKnownTenant();
            const body = JSON.stringify({
                event_type: 'alert.future.unknown',
                tenant_id: TENANT_ID,
                created_at: '2026-06-22T00:00:00.000Z',
                payload: { run: { id: 'run_unmapped' } },
            });

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            );
            await settle();

            expect(result).toEqual({ ok: true });
            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(sentry.error).not.toHaveBeenCalled();
        });
    });

    describe('invalid signature', () => {
        it('tampered HMAC → 401 + NO router call + NO subscriber call', async () => {
            arrangeKnownTenant();

            await expect(
                deliver('alert.run.failed', { runId: 'run_z', tamper: true }),
            ).rejects.toThrow();
            await settle();

            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(sentry.error).not.toHaveBeenCalled();
            // Router itself should not have been invoked — but since
            // the router is constructed by Nest, we assert it via its
            // emit side-effect (Sentry + history both untouched).
        });

        it('signature signed with wrong secret → 401 + NO subscriber fires', async () => {
            arrangeKnownTenant();

            await expect(
                deliver('alert.run.succeeded', {
                    runId: 'run_wrong',
                    secret: 'wrong-secret',
                }),
            ).rejects.toThrow();
            await settle();

            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(sentry.error).not.toHaveBeenCalled();
        });

        it('missing signature header → 400 + NO repo lookup + NO subscriber fires', async () => {
            tenantRepo.findOne.mockResolvedValue({
                tenantId: TENANT_ID,
                credentialsSecretRef: POINTER,
            });

            await expect(controller.receive(TENANT_ID, { rawBody: '{}' }, {})).rejects.toThrow();
            await settle();

            expect(tenantRepo.findOne).not.toHaveBeenCalled();
            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(sentry.error).not.toHaveBeenCalled();
        });
    });

    describe('unknown tenant', () => {
        it('tenant repo returns null → 404 + NO secret resolve + NO subscriber fires', async () => {
            tenantRepo.findOne.mockResolvedValue(null);

            await expect(deliver('alert.run.failed', { runId: 'run_404' })).rejects.toThrow();
            await settle();

            expect(secretStore.resolve).not.toHaveBeenCalled();
            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(sentry.error).not.toHaveBeenCalled();
        });

        it('tenant exists but no webhookSecret in bag → 401 + NO subscriber fires', async () => {
            tenantRepo.findOne.mockResolvedValue({
                tenantId: TENANT_ID,
                credentialsSecretRef: POINTER,
            });
            secretStore.resolve.mockResolvedValue({ apiKey: 'something-else' });

            await expect(deliver('alert.run.failed', { runId: 'run_no_secret' })).rejects.toThrow();
            await settle();

            expect(history.findByTriggerRunId).not.toHaveBeenCalled();
            expect(sentry.error).not.toHaveBeenCalled();
        });
    });
});
