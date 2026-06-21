import { BadRequestException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

// Stub the @Public decorator and entity imports so loading the
// controller doesn't pull the full auth → agent/database chain.
// Mirrors the strategy in composio-triggers.controller.spec.ts and
// the existing webhook-secret.service.spec.ts.
jest.mock('../../auth/decorators/public.decorator', () => ({ Public: () => () => undefined }));
jest.mock('@ever-works/agent/entities', () => ({ TenantJobRuntimeConfig: class {} }));
jest.mock('@ever-works/agent/tasks', () => ({
    SECRET_STORE_RESOLVER: Symbol.for('SECRET_STORE_RESOLVER_TEST'),
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

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SECRET = 'super-secret-webhook-key';
const POINTER = 'inline:dGVzdA==';

function signBody(body: string, secret: string): string {
    const hex = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    return `sha256=${hex}`;
}

function buildOverlayRow(overrides: Partial<TenantJobRuntimeConfig> = {}): TenantJobRuntimeConfig {
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

describe('TriggerWebhookController', () => {
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

    it('accepts a valid HMAC signature and logs the event metadata', async () => {
        const body = JSON.stringify({ id: 'evt_abc123', type: 'run.succeeded', data: { foo: 1 } });
        const signature = signBody(body, SECRET);
        tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
        secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

        const result = await controller.receive(
            TENANT_ID,
            { rawBody: body },
            { 'x-trigger-signature': signature },
        );

        expect(result).toEqual({ ok: true });
        expect(tenantRepo.findOne).toHaveBeenCalledWith({ where: { tenantId: TENANT_ID } });
        expect(secretStore.resolve).toHaveBeenCalledWith(POINTER);
        expect(logSpy).toHaveBeenCalledTimes(1);
        const logged = String(logSpy.mock.calls[0][0]);
        expect(logged).toContain(TENANT_ID);
        expect(logged).toContain('evt_abc123');
        expect(logged).toContain('run.succeeded');
    });

    it('routes the verified payload to the event router with the route-param tenantId', async () => {
        // EW-743 Phase 2 — controller must hand off the parsed body
        // to the router AFTER signature verification. The router
        // (not the controller) decides whether the payload is well
        // formed enough to emit downstream.
        const parsedBody = {
            event_type: 'alert.run.failed',
            tenant_id: TENANT_ID,
            created_at: '2026-06-21T00:00:00.000Z',
            payload: { run: { id: 'run_x' } },
        };
        const body = JSON.stringify(parsedBody);
        tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
        secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

        await controller.receive(
            TENANT_ID,
            { rawBody: body },
            { 'x-trigger-signature': signBody(body, SECRET) },
        );

        expect(eventRouter.route).toHaveBeenCalledTimes(1);
        expect(eventRouter.route).toHaveBeenCalledWith(TENANT_ID, parsedBody);
    });

    it('still returns 200 when the router rejects the payload (malformed/unmapped)', async () => {
        // Router contract: never throw, return false on drop. The
        // controller still 200s so Trigger.dev does not redeliver a
        // payload we will never accept.
        const body = JSON.stringify({ not: 'an-envelope' });
        tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
        secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });
        eventRouter.route.mockReturnValue(false);

        const result = await controller.receive(
            TENANT_ID,
            { rawBody: body },
            { 'x-trigger-signature': signBody(body, SECRET) },
        );

        expect(result).toEqual({ ok: true });
        expect(eventRouter.route).toHaveBeenCalledTimes(1);
    });

    it('does NOT invoke the router when the signature check fails', async () => {
        // Defence-in-depth: even if a future refactor reorders the
        // controller, the router must not see un-verified payloads.
        const body = JSON.stringify({ event_type: 'alert.run.failed' });
        tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
        secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

        await expect(
            controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': 'sha256=' + '0'.repeat(64) },
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(eventRouter.route).not.toHaveBeenCalled();
    });

    it('rejects a request with no X-Trigger-Signature header (400)', async () => {
        await expect(
            controller.receive(TENANT_ID, { rawBody: '{}' }, {}),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(tenantRepo.findOne).not.toHaveBeenCalled();
        expect(secretStore.resolve).not.toHaveBeenCalled();
    });

    it('rejects a request with a bogus signature (401)', async () => {
        const body = JSON.stringify({ id: 'evt_x', type: 'run.failed' });
        tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
        secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

        await expect(
            controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': 'sha256=deadbeef' + '0'.repeat(56) },
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns 404 when the tenant has no overlay row', async () => {
        const body = '{}';
        tenantRepo.findOne.mockResolvedValue(null);

        await expect(
            controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(secretStore.resolve).not.toHaveBeenCalled();
    });

    it('returns 401 when tenant exists but credentials.webhookSecret is absent', async () => {
        const body = '{}';
        tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
        secretStore.resolve.mockResolvedValue({ apiKey: 'something-else' });

        await expect(
            controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns 401 when the tenant overlay row has no credentialsSecretRef (inherit mode)', async () => {
        const body = '{}';
        tenantRepo.findOne.mockResolvedValue(
            buildOverlayRow({ credentialsSecretRef: null, mode: 'inherit' }),
        );

        await expect(
            controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(secretStore.resolve).not.toHaveBeenCalled();
    });

    it('returns 400 when the raw body is present but not valid JSON', async () => {
        const body = 'not-a-json-object{{{';
        tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
        secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });

        await expect(
            controller.receive(
                TENANT_ID,
                { rawBody: body },
                { 'x-trigger-signature': signBody(body, SECRET) },
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns 400 when the request has no captured rawBody', async () => {
        await expect(
            controller.receive(
                TENANT_ID,
                {}, // no rawBody — pre-signature-check guard
                { 'x-trigger-signature': 'sha256=' + '0'.repeat(64) },
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a signature without the `sha256=` scheme prefix (401)', async () => {
        const body = '{}';
        tenantRepo.findOne.mockResolvedValue(buildOverlayRow());
        secretStore.resolve.mockResolvedValue({ webhookSecret: SECRET });
        const raw = createHmac('sha256', SECRET).update(body).digest('hex');

        await expect(
            controller.receive(
                TENANT_ID,
                { rawBody: body },
                // omit the `sha256=` prefix
                { 'x-trigger-signature': raw },
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('uses constant-time compare on equal-length buffers (timingSafeEqual invariant)', () => {
        // Sanity: assert the Node.js primitive the controller relies on
        // doesn't short-circuit on a 1-byte difference at the prefix.
        // Both Buffers must be the same length or `timingSafeEqual`
        // throws — which is exactly why the controller bails on
        // length-mismatch BEFORE invoking it.
        const a = Buffer.from('a'.repeat(64), 'utf8');
        const b = Buffer.from('a'.repeat(63) + 'b', 'utf8');
        expect(a.length).toBe(b.length);
        expect(timingSafeEqual(a, b)).toBe(false);

        const shorter = Buffer.from('a'.repeat(63), 'utf8');
        expect(() => timingSafeEqual(a, shorter)).toThrow();
    });
});
