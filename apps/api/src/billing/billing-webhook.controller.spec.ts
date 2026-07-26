// Provider webhook receiver posture (billing PRD §5.2): @Public,
// raw-body, signature-authenticated, FAIL-CLOSED. Mirrors
// slack-events.controller.spec.ts — the failure surface must be one
// undifferentiated 401 so the response cannot be used to probe whether
// the receiver is configured.
class FakeBillingProviderNotConfiguredError extends Error {
    constructor(message = 'not configured') {
        super(message);
        this.name = 'BillingProviderNotConfiguredError';
    }
}
class FakeBillingProviderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BillingProviderError';
    }
}

jest.mock('@ever-works/agent/subscriptions', () => ({
    BillingProviderNotConfiguredError: FakeBillingProviderNotConfiguredError,
    BillingProviderError: FakeBillingProviderError,
    BillingService: class BillingService {},
}));

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { BillingWebhookController } from './billing-webhook.controller';

function makeService(overrides: Record<string, unknown> = {}) {
    return {
        handleWebhook: jest
            .fn()
            .mockResolvedValue({ eventId: 'evt_1', kind: 'credits.purchased', action: 'credited' }),
        ...overrides,
    } as any;
}

describe('BillingWebhookController', () => {
    it('rejects a delivery with no raw body (the digest could never match)', async () => {
        const service = makeService();
        const controller = new BillingWebhookController(service);

        await expect(controller.receive({}, 'sig')).rejects.toBeInstanceOf(BadRequestException);
        expect(service.handleWebhook).not.toHaveBeenCalled();
    });

    it('passes the RAW body and the signature header through for verification', async () => {
        const service = makeService();
        const controller = new BillingWebhookController(service);

        await controller.receive({ rawBody: '{"id":"evt_1"}' }, 'v1=abc');

        expect(service.handleWebhook).toHaveBeenCalledWith('{"id":"evt_1"}', 'v1=abc');
    });

    it('FAILS CLOSED with 401 when the receiver is not configured', async () => {
        const service = makeService({
            handleWebhook: jest.fn().mockRejectedValue(new FakeBillingProviderNotConfiguredError()),
        });
        const controller = new BillingWebhookController(service);

        await expect(controller.receive({ rawBody: '{}' }, 'sig')).rejects.toBeInstanceOf(
            UnauthorizedException,
        );
    });

    it('rejects an unsigned delivery with 401', async () => {
        const service = makeService({
            handleWebhook: jest
                .fn()
                .mockRejectedValue(
                    new FakeBillingProviderError('Missing webhook signature header'),
                ),
        });
        const controller = new BillingWebhookController(service);

        await expect(controller.receive({ rawBody: '{}' }, undefined)).rejects.toBeInstanceOf(
            UnauthorizedException,
        );
    });

    it('answers the SAME 401 for unconfigured and bad-signature (no config probing)', async () => {
        const unconfigured = new BillingWebhookController(
            makeService({
                handleWebhook: jest
                    .fn()
                    .mockRejectedValue(new FakeBillingProviderNotConfiguredError('no secret')),
            }),
        );
        const badSignature = new BillingWebhookController(
            makeService({
                handleWebhook: jest
                    .fn()
                    .mockRejectedValue(
                        new FakeBillingProviderError('Webhook signature verification failed'),
                    ),
            }),
        );

        const a = await unconfigured.receive({ rawBody: '{}' }, 'sig').catch((e) => e);
        const b = await badSignature.receive({ rawBody: '{}' }, 'sig').catch((e) => e);

        expect(a.message).toBe(b.message);
        expect(a.message).toBe('Invalid billing webhook delivery');
    });

    it('acknowledges a verified delivery with the action taken', async () => {
        const controller = new BillingWebhookController(makeService());

        await expect(controller.receive({ rawBody: '{}' }, 'sig')).resolves.toEqual({
            ok: true,
            action: 'credited',
        });
    });

    it('acknowledges (200) an event it could not attribute — the provider must not retry forever', async () => {
        const controller = new BillingWebhookController(
            makeService({
                handleWebhook: jest.fn().mockResolvedValue({
                    eventId: 'evt_x',
                    kind: 'credits.purchased',
                    action: 'unattributed',
                }),
            }),
        );

        await expect(controller.receive({ rawBody: '{}' }, 'sig')).resolves.toEqual({
            ok: true,
            action: 'unattributed',
        });
    });

    it('lets an unexpected internal error surface (not masked as a 401)', async () => {
        const controller = new BillingWebhookController(
            makeService({ handleWebhook: jest.fn().mockRejectedValue(new Error('db down')) }),
        );

        await expect(controller.receive({ rawBody: '{}' }, 'sig')).rejects.toThrow('db down');
    });
});
