// The money path's HTTP boundary (billing PRD §5.2). Mirrors
// credits.controller.spec.ts: the agent barrels are stubbed so the spec
// never drags in @ever-works/agent/database, and the DTOs are validated
// with the same class-validator pipeline the global ValidationPipe runs.
class FakeBillingProviderNotConfiguredError extends Error {
    constructor(message = 'Payment provider is not configured on this deployment') {
        super(message);
        this.name = 'BillingProviderNotConfiguredError';
    }
}
class FakeBillingProviderError extends Error {
    constructor(
        message: string,
        public readonly code?: string,
    ) {
        super(message);
        this.name = 'BillingProviderError';
    }
}
class FakeUnknownCreditPackError extends Error {
    constructor(packId: string) {
        super(`Unknown credit pack: ${packId}`);
        this.name = 'UnknownCreditPackError';
    }
}
class FakeNoActiveSubscriptionError extends Error {
    constructor(message = 'No manageable subscription for this account') {
        super(message);
        this.name = 'NoActiveSubscriptionError';
    }
}

jest.mock('@ever-works/agent/subscriptions', () => ({
    BillingProviderNotConfiguredError: FakeBillingProviderNotConfiguredError,
    BillingProviderError: FakeBillingProviderError,
    UnknownCreditPackError: FakeUnknownCreditPackError,
    NoActiveSubscriptionError: FakeNoActiveSubscriptionError,
    BillingService: class BillingService {},
    CREDIT_PACK_IDS: ['credits-1000', 'credits-5500', 'credits-25000'],
}));
jest.mock('@ever-works/agent/entities', () => ({ Invoice: class Invoice {} }));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import {
    BadRequestException,
    ConflictException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BillingController, CreditsCheckoutController } from './billing.controller';
import { CreateCreditCheckoutDto, UpdateAutoRechargeDto } from './dto/billing.dto';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const auth: AuthenticatedUser = {
    userId: 'user-1',
    email: 'u@e.test',
    username: 'u',
    provider: 'local',
    emailVerified: true,
} as AuthenticatedUser;

const otherAuth: AuthenticatedUser = { ...auth, userId: 'user-2' } as AuthenticatedUser;

function makeService(overrides: Record<string, unknown> = {}) {
    return {
        getPacks: jest.fn().mockReturnValue([
            {
                id: 'credits-1000',
                priceCents: 1000,
                credits: 1000,
                currency: 'usd',
                label: 'a',
            },
        ]),
        isProviderConfigured: jest.fn().mockReturnValue(true),
        startCreditCheckout: jest.fn().mockResolvedValue({
            url: 'https://pay.example/cs_1',
            sessionId: 'cs_1',
            packId: 'credits-1000',
            priceCents: 1000,
            credits: 1000,
        }),
        getOverview: jest.fn().mockResolvedValue({
            providerConfigured: true,
            providerId: 'stripe',
            currency: 'usd',
            packs: [],
            balanceCredits: 250,
            paymentMethod: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2031 },
            autoRecharge: {
                enabled: false,
                thresholdCredits: null,
                packId: null,
                failureCount: 0,
            },
            subscription: {
                status: 'active',
                cancelAtPeriodEnd: false,
                currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
                canceledAt: null,
                pastDue: false,
                manageable: true,
            },
        }),
        listInvoices: jest
            .fn()
            .mockResolvedValue({ invoices: [], total: 0, page: 1, pageSize: 10 }),
        updateAutoRecharge: jest.fn().mockResolvedValue({
            autoRechargeEnabled: true,
            autoRechargeThresholdCredits: 500,
            autoRechargePackId: 'credits-1000',
            autoRechargeFailureCount: 0,
        }),
        // Subscription lifecycle (audit B07/B08).
        cancelSubscription: jest.fn().mockResolvedValue({
            status: 'active',
            cancelAtPeriodEnd: true,
            currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
            canceledAt: null,
            pastDue: false,
            manageable: true,
        }),
        resumeSubscription: jest.fn().mockResolvedValue({
            status: 'active',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
            canceledAt: null,
            pastDue: false,
            manageable: true,
        }),
        createBillingPortalSession: jest
            .fn()
            .mockResolvedValue({ url: 'https://pay.example/portal/bps_1' }),
        ...overrides,
    } as any;
}

describe('CreditsCheckoutController — POST /api/credits/checkout', () => {
    beforeAll(() => {
        process.env.WEB_URL = 'https://app.test';
    });

    it('starts a checkout for the AUTHENTICATED user, never a caller-supplied one', async () => {
        const service = makeService();
        const controller = new CreditsCheckoutController(service);

        await controller.createCheckout(auth, { packId: 'credits-1000' });

        expect(service.startCreditCheckout).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user-1', packId: 'credits-1000' }),
        );
        // A second caller cannot buy on behalf of the first.
        await controller.createCheckout(otherAuth, { packId: 'credits-1000' });
        expect(service.startCreditCheckout).toHaveBeenLastCalledWith(
            expect.objectContaining({ userId: 'user-2' }),
        );
    });

    it('builds the return URLs server-side (no client-supplied redirect)', async () => {
        const service = makeService();
        const controller = new CreditsCheckoutController(service);

        await controller.createCheckout(auth, { packId: 'credits-1000' });

        const passed = service.startCreditCheckout.mock.calls[0][0];
        expect(passed.successUrl).toBe('https://app.test/settings/billing?topup=success');
        expect(passed.cancelUrl).toBe('https://app.test/settings/billing?topup=cancelled');
    });

    it('maps provider-not-configured to 503 so the UI can degrade', async () => {
        const service = makeService({
            startCreditCheckout: jest
                .fn()
                .mockRejectedValue(new FakeBillingProviderNotConfiguredError()),
        });
        const controller = new CreditsCheckoutController(service);

        await expect(
            controller.createCheckout(auth, { packId: 'credits-1000' }),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('maps an unknown pack to 400', async () => {
        const service = makeService({
            startCreditCheckout: jest
                .fn()
                .mockRejectedValue(new FakeUnknownCreditPackError('credits-hack')),
        });
        const controller = new CreditsCheckoutController(service);

        await expect(
            controller.createCheckout(auth, { packId: 'credits-hack' }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('exposes the server pack table with the provider-configured flag', () => {
        const service = makeService({ isProviderConfigured: jest.fn().mockReturnValue(false) });
        const controller = new CreditsCheckoutController(service);

        expect(controller.getPacks()).toEqual(
            expect.objectContaining({ providerConfigured: false }),
        );
    });
});

describe('CreateCreditCheckoutDto — the client can never name a price', () => {
    async function validateBody(body: Record<string, unknown>) {
        const dto = plainToInstance(CreateCreditCheckoutDto, body, {
            // Same options as the global ValidationPipe in main.ts.
            excludeExtraneousValues: false,
        });
        return validate(dto as object, { whitelist: true, forbidNonWhitelisted: true });
    }

    it('accepts a published pack id', async () => {
        expect(await validateBody({ packId: 'credits-5500' })).toHaveLength(0);
    });

    it('rejects an unpublished pack id', async () => {
        const errors = await validateBody({ packId: 'credits-free' });
        expect(errors).not.toHaveLength(0);
    });

    it('rejects a body carrying a client-supplied amount (forbidNonWhitelisted)', async () => {
        for (const field of ['amountCents', 'priceCents', 'credits', 'amount']) {
            const errors = await validateBody({ packId: 'credits-1000', [field]: 1 });
            expect(errors.map((e) => e.property)).toContain(field);
        }
    });

    it('rejects a missing pack id', async () => {
        expect(await validateBody({})).not.toHaveLength(0);
    });
});

describe('BillingController — overview, invoices, auto-recharge', () => {
    it('returns the overview for the authenticated user only', async () => {
        const service = makeService();
        const controller = new BillingController(service);

        const result = await controller.getOverview(auth);

        expect(service.getOverview).toHaveBeenCalledWith('user-1');
        expect(result).toEqual(expect.objectContaining({ status: 'success', balanceCredits: 250 }));
    });

    it('lists invoices scoped to the authenticated user', async () => {
        const service = makeService({
            listInvoices: jest.fn().mockResolvedValue({
                invoices: [
                    {
                        id: 'inv-1',
                        number: 'EW-1',
                        status: 'paid',
                        subtotalCents: 5000,
                        totalCents: 5000,
                        amountPaidCents: 5000,
                        currency: 'usd',
                        hostedUrl: 'https://pay.example/in_1',
                        pdfUrl: null,
                        issuedAt: new Date('2026-07-01T00:00:00Z'),
                        createdAt: new Date('2026-07-01T00:00:00Z'),
                        // Must never reach the wire.
                        userId: 'user-1',
                        tenantId: 'tenant-1',
                    },
                ],
                total: 1,
                page: 1,
                pageSize: 10,
            }),
        });
        const controller = new BillingController(service);

        const result = await controller.listInvoices(auth, {});

        expect(service.listInvoices).toHaveBeenCalledWith('user-1', 1, 10);
        expect(result.invoices[0]).not.toHaveProperty('userId');
        expect(result.invoices[0]).not.toHaveProperty('tenantId');
        expect(result.invoices[0]).toEqual(
            expect.objectContaining({ id: 'inv-1', totalCents: 5000 }),
        );
    });

    it('cannot be asked for another account’s invoices via query params', async () => {
        const service = makeService();
        const controller = new BillingController(service);

        // Even a smuggled userId is ignored — the DTO has no such field
        // and the controller reads the session user.
        await controller.listInvoices(otherAuth, { page: 2, pageSize: 5 } as never);

        expect(service.listInvoices).toHaveBeenCalledWith('user-2', 2, 5);
    });

    it('maps "no payment method" to 409 rather than a 500', async () => {
        const service = makeService({
            updateAutoRecharge: jest
                .fn()
                .mockRejectedValue(
                    new FakeBillingProviderError('Add a payment method', 'no-payment-method'),
                ),
        });
        const controller = new BillingController(service);

        await expect(
            controller.updateAutoRecharge(auth, { enabled: true, thresholdCredits: 100 }),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('persists auto-recharge settings for the authenticated user', async () => {
        const service = makeService();
        const controller = new BillingController(service);

        const result = await controller.updateAutoRecharge(auth, {
            enabled: true,
            thresholdCredits: 500,
            packId: 'credits-1000',
        });

        expect(service.updateAutoRecharge).toHaveBeenCalledWith('user-1', {
            enabled: true,
            thresholdCredits: 500,
            packId: 'credits-1000',
        });
        expect(result).toEqual(expect.objectContaining({ enabled: true, thresholdCredits: 500 }));
    });
});

/**
 * Subscription lifecycle at the HTTP boundary (audit B07/B08).
 *
 * The routes take NO body and NO id: everything is resolved from the
 * session user, which is what makes a cross-account (or cross-org)
 * request structurally impossible rather than merely checked.
 */
describe('BillingController — subscription cancel / resume / portal', () => {
    beforeAll(() => {
        process.env.WEB_URL = 'https://app.test';
    });

    it('cancels for the AUTHENTICATED user and echoes the new state', async () => {
        const service = makeService();
        const controller = new BillingController(service);

        const result = await controller.cancelSubscription(auth);

        expect(service.cancelSubscription).toHaveBeenCalledWith('user-1');
        expect(result.subscription).toEqual(
            expect.objectContaining({ cancelAtPeriodEnd: true, status: 'active' }),
        );
    });

    it('cannot be pointed at another account: the session user is the only input', async () => {
        const service = makeService();
        const controller = new BillingController(service);

        await controller.cancelSubscription(auth);
        await controller.cancelSubscription(otherAuth);

        expect(service.cancelSubscription).toHaveBeenNthCalledWith(1, 'user-1');
        expect(service.cancelSubscription).toHaveBeenNthCalledWith(2, 'user-2');
        // There is no id/body parameter on the route at all.
        expect(controller.cancelSubscription).toHaveLength(1);
        expect(controller.resumeSubscription).toHaveLength(1);
    });

    it('resumes for the authenticated user', async () => {
        const service = makeService();
        const controller = new BillingController(service);

        const result = await controller.resumeSubscription(auth);

        expect(service.resumeSubscription).toHaveBeenCalledWith('user-1');
        expect(result.subscription.cancelAtPeriodEnd).toBe(false);
    });

    it('maps "no subscription" to 409 — the same answer a foreign account gets', async () => {
        const service = makeService({
            cancelSubscription: jest.fn().mockRejectedValue(new FakeNoActiveSubscriptionError()),
            resumeSubscription: jest.fn().mockRejectedValue(new FakeNoActiveSubscriptionError()),
        });
        const controller = new BillingController(service);

        await expect(controller.cancelSubscription(auth)).rejects.toBeInstanceOf(ConflictException);
        await expect(controller.resumeSubscription(otherAuth)).rejects.toBeInstanceOf(
            ConflictException,
        );
    });

    it('maps provider-not-configured to 503 so the UI can degrade', async () => {
        const service = makeService({
            cancelSubscription: jest
                .fn()
                .mockRejectedValue(new FakeBillingProviderNotConfiguredError()),
        });
        const controller = new BillingController(service);

        await expect(controller.cancelSubscription(auth)).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });

    it('builds the portal return URL server-side (no client-supplied redirect)', async () => {
        const service = makeService();
        const controller = new BillingController(service);

        const result = await controller.createPortalSession(auth);

        expect(service.createBillingPortalSession).toHaveBeenCalledWith(
            'user-1',
            'https://app.test/settings/billing',
        );
        expect(result.url).toBe('https://pay.example/portal/bps_1');
    });

    it('surfaces the subscription state on the overview (the status chip’s source)', async () => {
        const service = makeService();
        const controller = new BillingController(service);

        const result = await controller.getOverview(auth);

        expect(result).toEqual(
            expect.objectContaining({
                subscription: expect.objectContaining({ status: 'active', manageable: true }),
            }),
        );
    });
});

describe('UpdateAutoRechargeDto', () => {
    async function validateBody(body: Record<string, unknown>) {
        const dto = plainToInstance(UpdateAutoRechargeDto, body);
        return validate(dto as object, { whitelist: true, forbidNonWhitelisted: true });
    }

    it('accepts a toggle with a threshold and a published pack', async () => {
        expect(
            await validateBody({ enabled: true, thresholdCredits: 500, packId: 'credits-1000' }),
        ).toHaveLength(0);
    });

    it('rejects an unpublished pack id', async () => {
        expect(await validateBody({ enabled: true, packId: 'credits-hack' })).not.toHaveLength(0);
    });

    it('rejects a client-supplied recharge AMOUNT', async () => {
        const errors = await validateBody({ enabled: true, amountCents: 100000 });
        expect(errors.map((e) => e.property)).toContain('amountCents');
    });

    it('rejects a negative or absurd threshold', async () => {
        expect(await validateBody({ enabled: true, thresholdCredits: -1 })).not.toHaveLength(0);
        expect(
            await validateBody({ enabled: true, thresholdCredits: 99_999_999 }),
        ).not.toHaveLength(0);
    });
});
