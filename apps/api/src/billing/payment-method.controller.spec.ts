// Payment-method routes (billing PRD §3.3, audit B10 + B25). Mirrors
// billing.controller.spec.ts: the agent barrels are stubbed so the spec
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
class FakePaymentMethodNotFoundError extends Error {
    constructor(message = 'Payment method not found') {
        super(message);
        this.name = 'PaymentMethodNotFoundError';
    }
}
class FakeLastPaymentMethodError extends Error {
    constructor(
        message = 'Add another payment method before removing the last one on a paid plan',
    ) {
        super(message);
        this.name = 'LastPaymentMethodError';
    }
}

jest.mock('@ever-works/agent/subscriptions', () => ({
    BillingProviderNotConfiguredError: FakeBillingProviderNotConfiguredError,
    BillingProviderError: FakeBillingProviderError,
    PaymentMethodNotFoundError: FakePaymentMethodNotFoundError,
    LastPaymentMethodError: FakeLastPaymentMethodError,
    PaymentMethodService: class PaymentMethodService {},
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentMethodController } from './payment-method.controller';
import { PaymentMethodParamDto, StartPaymentMethodSetupDto } from './dto/payment-method.dto';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const auth: AuthenticatedUser = {
    userId: 'user-1',
    email: 'u@e.test',
    username: 'u',
    provider: 'local',
    emailVerified: true,
} as AuthenticatedUser;

const otherAuth: AuthenticatedUser = { ...auth, userId: 'user-2' } as AuthenticatedUser;

const HANDLE_A = 'a'.repeat(32);
const HANDLE_B = 'b'.repeat(32);

function makeService(overrides: Record<string, unknown> = {}) {
    return {
        list: jest.fn().mockResolvedValue({
            providerConfigured: true,
            methods: [
                {
                    id: HANDLE_A,
                    brand: 'visa',
                    last4: '4242',
                    expMonth: 4,
                    expYear: 2031,
                    isDefault: true,
                },
            ],
        }),
        startSetup: jest
            .fn()
            .mockResolvedValue({ url: 'https://pay.example/seti_1', sessionId: 'cs_setup_1' }),
        setDefault: jest.fn().mockResolvedValue({
            id: HANDLE_B,
            brand: 'amex',
            last4: '1881',
            expMonth: 9,
            expYear: 2030,
            isDefault: true,
        }),
        remove: jest.fn().mockResolvedValue({ providerConfigured: true, methods: [] }),
        ...overrides,
    } as any;
}

describe('PaymentMethodController — route auth + owner/org scoping', () => {
    beforeAll(() => {
        process.env.WEB_URL = 'https://app.test';
    });

    it('is guarded — every route sits behind AuthSessionGuard', () => {
        // The guard metadata is what makes these routes non-public; the
        // webhook is the only @Public route in this module.
        const guards = Reflect.getMetadata('__guards__', PaymentMethodController) ?? [];
        expect(guards).toHaveLength(1);
        expect(guards[0].name).toBe('AuthSessionGuard');
    });

    it('lists the AUTHENTICATED owner’s methods only', async () => {
        const service = makeService();
        const controller = new PaymentMethodController(service);

        await controller.list(auth);
        expect(service.list).toHaveBeenCalledWith('user-1');

        // A second session gets its own owner id — there is no parameter
        // through which one account could name another.
        await controller.list(otherAuth);
        expect(service.list).toHaveBeenLastCalledWith('user-2');
    });

    it('never puts the provider payment-method reference on the wire', async () => {
        const service = makeService();
        const controller = new PaymentMethodController(service);

        const result = await controller.list(auth);

        expect(JSON.stringify(result)).not.toMatch(/pm_/);
        expect(result.methods[0]).toEqual(
            expect.objectContaining({ id: HANDLE_A, last4: '4242', isDefault: true }),
        );
    });

    it('starts the hosted capture for the session user with SERVER-built return URLs', async () => {
        const service = makeService();
        const controller = new PaymentMethodController(service);

        const result = await controller.startSetup(auth, {});

        expect(service.startSetup).toHaveBeenCalledWith('user-1', {
            successUrl: 'https://app.test/settings/billing/payment-method?setup=success',
            cancelUrl: 'https://app.test/settings/billing/payment-method?setup=cancelled',
        });
        expect(result).toEqual(
            expect.objectContaining({ status: 'success', url: 'https://pay.example/seti_1' }),
        );
    });

    it('sets and removes against the session user, using the handle as given', async () => {
        const service = makeService();
        const controller = new PaymentMethodController(service);

        await controller.setDefault(otherAuth, { id: HANDLE_B });
        expect(service.setDefault).toHaveBeenCalledWith('user-2', HANDLE_B);

        await controller.remove(otherAuth, { id: HANDLE_A });
        expect(service.remove).toHaveBeenCalledWith('user-2', HANDLE_A);
    });

    it('answers 404 — never "exists but not yours" — for a foreign handle', async () => {
        const service = makeService({
            setDefault: jest.fn().mockRejectedValue(new FakePaymentMethodNotFoundError()),
            remove: jest.fn().mockRejectedValue(new FakePaymentMethodNotFoundError()),
        });
        const controller = new PaymentMethodController(service);

        await expect(controller.setDefault(auth, { id: HANDLE_B })).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(controller.remove(auth, { id: HANDLE_B })).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('maps provider-not-configured to 503 so the UI can degrade', async () => {
        const service = makeService({
            startSetup: jest.fn().mockRejectedValue(new FakeBillingProviderNotConfiguredError()),
        });
        const controller = new PaymentMethodController(service);

        await expect(controller.startSetup(auth, {})).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });

    it('maps a provider failure to 409 rather than an unmapped 500', async () => {
        const service = makeService({
            setDefault: jest.fn().mockRejectedValue(new FakeBillingProviderError('declined')),
        });
        const controller = new PaymentMethodController(service);

        await expect(controller.setDefault(auth, { id: HANDLE_A })).rejects.toBeInstanceOf(
            ConflictException,
        );
    });
});

describe('PaymentMethodController — removing the LAST method on a paid plan', () => {
    /**
     * The chosen behaviour: REFUSE with 409. It matches the precedent the
     * codebase already sets — `PUT /api/billing/auto-recharge` answers 409
     * for "no payment method on file", and paid plans cannot be
     * self-assigned — so stranding an active paid subscription with
     * nothing to charge is exactly the state those rules prevent.
     */
    it('is a 409 Conflict, not a silent removal and not a silent cancellation', async () => {
        const service = makeService({
            remove: jest.fn().mockRejectedValue(new FakeLastPaymentMethodError()),
        });
        const controller = new PaymentMethodController(service);

        await expect(controller.remove(auth, { id: HANDLE_A })).rejects.toBeInstanceOf(
            ConflictException,
        );
    });

    it('the refusal message tells the user how to proceed (add a replacement first)', async () => {
        const service = makeService({
            remove: jest.fn().mockRejectedValue(new FakeLastPaymentMethodError()),
        });
        const controller = new PaymentMethodController(service);

        await expect(controller.remove(auth, { id: HANDLE_A })).rejects.toThrow(
            /add another payment method/i,
        );
    });
});

describe('payment-method DTOs — no card data, no identity smuggling', () => {
    async function validateBody(cls: any, body: Record<string, unknown>) {
        const dto = plainToInstance(cls, body);
        return validate(dto as object, { whitelist: true, forbidNonWhitelisted: true });
    }

    it('accepts an empty setup body', async () => {
        expect(await validateBody(StartPaymentMethodSetupDto, {})).toHaveLength(0);
    });

    it('rejects any card field on the setup body (cards never reach this API)', async () => {
        for (const field of ['number', 'cardNumber', 'cvc', 'expMonth', 'paymentMethodRef']) {
            const errors = await validateBody(StartPaymentMethodSetupDto, { [field]: 'x' });
            expect(errors.map((e) => e.property)).toContain(field);
        }
    });

    it('rejects identity/redirect smuggling on the setup body', async () => {
        for (const field of ['userId', 'organizationId', 'tenantId', 'customerId', 'successUrl']) {
            const errors = await validateBody(StartPaymentMethodSetupDto, { [field]: 'x' });
            expect(errors.map((e) => e.property)).toContain(field);
        }
    });

    it('accepts a well-formed handle', async () => {
        expect(await validateBody(PaymentMethodParamDto, { id: HANDLE_A })).toHaveLength(0);
    });

    it('rejects a raw provider reference in the path (only handles are addressable)', async () => {
        for (const id of ['pm_1234567890', '../../etc', 'A'.repeat(32), '', 'a'.repeat(31)]) {
            expect(await validateBody(PaymentMethodParamDto, { id })).not.toHaveLength(0);
        }
    });
});
