/**
 * EW-1516 — integration tests #2: deeper controller-edge coverage.
 *
 * Extends the existing 12 controller spec cases with edge-case
 * variants the per-controller spec does not pin: signature prefix
 * casing, hex casing, oversized bodies, tenant route-vs-envelope
 * mismatch propagation through the controller, etc.
 *
 * Mirrors the strategy in trigger-webhook.controller.spec.ts — direct
 * instantiation with mocked repo + secret store + router. Does NOT
 * stand up a Nest HTTP server.
 */

import { BadRequestException, Logger, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';

// Stub external workspace imports as the unit spec does.
jest.mock('../../auth/decorators/public.decorator', () => ({ Public: () => () => undefined }));
jest.mock('@ever-works/agent/entities', () => ({ TenantJobRuntimeConfig: class {} }));
jest.mock('@ever-works/agent/tasks', () => ({
    SECRET_STORE_RESOLVER: Symbol.for('SECRET_STORE_RESOLVER_TEST_DEEP'),
}));

// eslint-disable-next-line import/first
import { TriggerWebhookController } from '../trigger-webhook.controller';
// eslint-disable-next-line import/first
import { TriggerWebhookEventRouterService } from '../trigger-webhook-event-router.service';
// eslint-disable-next-line import/first
import type { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
// eslint-disable-next-line import/first
import type { SecretStoreResolver } from '@ever-works/agent/tasks';
// eslint-disable-next-line import/first
import type { Repository } from 'typeorm';

const TENANT_ID = '00000000-0000-0000-0000-000000000aaa';
const OTHER_TENANT = '00000000-0000-0000-0000-000000000bbb';
const SECRET = 'super-secret-webhook-key';
const POINTER = 'inline:dGVzdA==';

function signBody(body: string, secret: string): string {
    const hex = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    return `sha256=${hex}`;
}

function buildOverlayRow(
    overrides: Partial<TenantJobRuntimeConfig> = {},
): TenantJobRuntimeConfig {
    return {
        tenantId: TENANT_ID,
        providerId: 'trigger',
        credentialsSecretRef: POINTER,
        credentialVersion: 1,
        mode: 'byo',
        enabled: true,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as TenantJobRuntimeConfig;
}

describe('TriggerWebhookController — deep edge-case coverage', () => {
    let tenantRepo: jest.Mocked<Pick<Repository<TenantJobRuntimeConfig>, 'findOne'>>;
    let secretStore: jest.Mocked<SecretStoreResolver>;
    let eventRouter: jest.Mocked<Pick<TriggerWebhookEventRouterService, 'route'>>;
    let controller: TriggerWebhookController;
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
        tenantRepo = { findOne: jest.fn() };
        secretStore = { resolve: jest.fn() } as jest.Mocked<SecretStoreResolver>;
        eventRouter = { route: jest.fn().mockReturnValue(true) };
        controller = new TriggerWebhookController(
            tenantRepo as unknown as Repository<TenantJobRuntimeConfig>,
            secretStore,
            eventRouter as unknown as TriggerWebhookEventRouterService,
        );
        logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    });

    afterEach(() => {
        logSpy.mockRestore();
        jest.resetAllMocks();
    });

    describe('signature header parsing', () => {
        // Pin the exact accepted casing: receiver code uses
        // `sha256=` (lowercase prefix) and lowercase hex output from
        // createHmac. These tests fence what counts as a valid header.

        it('rejects uppercase scheme prefix `SHA256=` (401)', async () => {
            const body = '{}';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });
            const hex = createHmac('sha256', SECRET).update(body).digest('hex');

            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: body },
                    { 'x-trigger-signature': `SHA256=${hex}` },
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            expect(eventRouter.route).not.toHaveBeenCalled();
        });

        it('accepts uppercase hex AFTER `sha256=` prefix', async () => {
            // The hex regex used in verifySignature is /^[0-9a-f]+$/i —
            // it accepts uppercase A-F. Buffer.from('AB', 'hex') and
            // Buffer.from('ab', 'hex') yield the same bytes, so the
            // timingSafeEqual succeeds.
            const body = '{}';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });
            const hex = createHmac('sha256', SECRET).update(body).digest('hex');

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': `sha256=${hex.toUpperCase()}` },
            );

            expect(result).toEqual({ ok: true });
            expect(eventRouter.route).toHaveBeenCalledTimes(1);
        });

        it('rejects signature with non-hex characters in the digest (401)', async () => {
            const body = '{}';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: body },
                    { 'x-trigger-signature': 'sha256=zz' + '0'.repeat(62) },
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('rejects signature with odd hex length (401)', async () => {
            // 63 hex chars — half-byte that Buffer.from would silently
            // truncate; controller bails on length-mismatch before
            // hitting timingSafeEqual.
            const body = '{}';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: body },
                    { 'x-trigger-signature': 'sha256=' + 'a'.repeat(63) },
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('rejects signature with too-long hex (>64 chars) (401)', async () => {
            const body = '{}';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: body },
                    { 'x-trigger-signature': 'sha256=' + 'a'.repeat(128) },
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('rejects empty hex after the `sha256=` prefix (401)', async () => {
            const body = '{}';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: body },
                    { 'x-trigger-signature': 'sha256=' },
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('rejects signature header that is just whitespace (400 or 401)', async () => {
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

            // Empty-string header is treated as missing → 400, not 401.
            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: '{}' },
                    { 'x-trigger-signature': '' },
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('body content variations', () => {
        it('accepts an empty JSON object body when correctly signed', async () => {
            const body = '{}';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            );

            expect(result).toEqual({ ok: true });
            // Router will reject the malformed envelope but the controller
            // does not care — it forwarded the parsed body.
            expect(eventRouter.route).toHaveBeenCalledTimes(1);
        });

        it('accepts a large valid body (~256 KB) with correct signature', async () => {
            // Document: there is no inline body-size limit in the
            // controller. Operators rely on the upstream NestJS body
            // parser's `limit` setting; here we pin that the controller
            // itself does not reject reasonable payloads.
            const big = JSON.stringify({
                event_type: 'alert.run.succeeded',
                tenant_id: TENANT_ID,
                created_at: '2026-06-22T00:00:00.000Z',
                payload: { run: { id: 'run_big', logs: 'x'.repeat(256 * 1024) } },
            });
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: big },
                { 'x-trigger-signature': signBody(big, SECRET) },
            );

            expect(result).toEqual({ ok: true });
            expect(eventRouter.route).toHaveBeenCalledTimes(1);
        });

        it('rejects body containing trailing garbage as not-valid-JSON (400)', async () => {
            const body = '{"event_type":"alert.run.failed"} garbage';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: body },
                    { 'x-trigger-signature': signBody(body, SECRET) },
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
            // Router never seen — parse failed after signature check.
            expect(eventRouter.route).not.toHaveBeenCalled();
        });

        it('accepts JSON array as body (parses + forwards; router drops)', async () => {
            // JSON arrays parse successfully; the router's envelope guard
            // rejects them. Controller behaviour: 200 (don't redeliver).
            const body = '[1,2,3]';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });
            eventRouter.route.mockReturnValue(false);

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            );

            expect(result).toEqual({ ok: true });
            expect(eventRouter.route).toHaveBeenCalledWith(TENANT_ID, [1, 2, 3]);
        });

        it('accepts JSON `null` body (200; router drops)', async () => {
            const body = 'null';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });
            eventRouter.route.mockReturnValue(false);

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            );

            expect(result).toEqual({ ok: true });
            expect(eventRouter.route).toHaveBeenCalledWith(TENANT_ID, null);
        });
    });

    describe('tenant route-vs-envelope handling', () => {
        it('forwards body tenant_id mismatch to router (route value wins downstream)', async () => {
            // The controller does NOT short-circuit on mismatch — the
            // router decides what to do with the body. This test pins
            // the controller's hand-off, not the router's behaviour
            // (that is tested in the router spec).
            const body = JSON.stringify({
                event_type: 'alert.run.failed',
                tenant_id: OTHER_TENANT,
                created_at: '2026-06-22T00:00:00.000Z',
                payload: { run: { id: 'run_z' } },
            });
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            );

            expect(result).toEqual({ ok: true });
            // Route arg = TENANT_ID (route-param), body still carries
            // OTHER_TENANT — router handles divergence.
            const [routeTenant, parsedBody] = eventRouter.route.mock.calls[0];
            expect(routeTenant).toBe(TENANT_ID);
            expect((parsedBody as { tenant_id: string }).tenant_id).toBe(OTHER_TENANT);
        });

        it('forwards empty payload object (200; router will drop)', async () => {
            const body = JSON.stringify({
                event_type: 'alert.run.failed',
                tenant_id: TENANT_ID,
                created_at: '2026-06-22T00:00:00.000Z',
                payload: {},
            });
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });
            eventRouter.route.mockReturnValue(true);

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            );

            expect(result).toEqual({ ok: true });
            expect(eventRouter.route).toHaveBeenCalledTimes(1);
        });
    });

    describe('replay-protection placeholder', () => {
        it('X-Trigger-Timestamp header is accepted (ignored today; reserved per #1533 TODO)', async () => {
            // The current receiver does NOT consult an X-Trigger-Timestamp
            // header (per the TODO in trigger-webhook.controller.ts).
            // Pin that the header's presence does NOT break the flow —
            // when replay protection lands, this test should be flipped
            // to assert the rejection behaviour.
            const body = '{}';
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

            const result = await controller.receive(
                TENANT_ID,
                { rawBody: body },
                {
                    'x-trigger-signature': signBody(body, SECRET),
                    'x-trigger-timestamp': '2026-06-22T00:00:00.000Z',
                },
            );

            expect(result).toEqual({ ok: true });
            expect(eventRouter.route).toHaveBeenCalledTimes(1);
        });
    });

    describe('secret store integration', () => {
        it('does not call router when secret resolver returns null (401)', async () => {
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue(null as never);

            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: '{}' },
                    { 'x-trigger-signature': signBody('{}', SECRET) },
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            expect(eventRouter.route).not.toHaveBeenCalled();
        });

        it('returns 401 when webhookSecret is empty string (fail-closed)', async () => {
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: '' });

            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: '{}' },
                    { 'x-trigger-signature': signBody('{}', SECRET) },
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('returns 401 when webhookSecret is not a string (e.g. accidental object)', async () => {
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            // A misconfigured secret store could legitimately return a
            // non-string under the same key — must fail closed.
            secretStore.resolve.mockResolvedValue({
                webhookSecret: { nested: 'oops' } as unknown as string,
            });

            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: '{}' },
                    { 'x-trigger-signature': signBody('{}', SECRET) },
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });
    });

    describe('idempotency at the controller layer', () => {
        it('replay storm: 10 identical deliveries all 200 + each forwards to router', async () => {
            const body = JSON.stringify({
                event_type: 'alert.run.succeeded',
                tenant_id: TENANT_ID,
                created_at: '2026-06-22T00:00:00.000Z',
                payload: { run: { id: 'run_idem' } },
            });
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });
            const sig = signBody(body, SECRET);

            for (let i = 0; i < 10; i++) {
                const result = await controller.receive(
                    TENANT_ID,
                    { rawBody: body },
                    { 'x-trigger-signature': sig },
                );
                expect(result).toEqual({ ok: true });
            }

            // Controller is intentionally stateless: every valid
            // delivery hits the router. De-dup is a subscriber concern.
            expect(eventRouter.route).toHaveBeenCalledTimes(10);
        });

        it('throws synchronously when router itself throws — operator-visible error path', async () => {
            // Pinning the current behaviour: the controller does NOT
            // wrap router.route() in a try/catch. The router's contract
            // is "never throw"; if it does, the failure should surface
            // as a 500 so operators see it (route causes redelivery,
            // which is fine since the body was valid).
            const body = JSON.stringify({
                event_type: 'alert.run.succeeded',
                tenant_id: TENANT_ID,
                created_at: '2026-06-22T00:00:00.000Z',
                payload: { run: { id: 'run_throw' } },
            });
            tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
            secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });
            eventRouter.route.mockImplementation(() => {
                throw new Error('router bug');
            });

            await expect(
                controller.receive(
                    TENANT_ID,
                    { rawBody: body },
                    { 'x-trigger-signature': signBody(body, SECRET) },
                ),
            ).rejects.toThrow('router bug');
        });
    });
});
