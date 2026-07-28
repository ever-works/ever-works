import { BillingProviderNotConfiguredError } from './billing.provider';
import {
    LastPaymentMethodError,
    PaymentMethodNotFoundError,
    PaymentMethodService,
    paymentMethodHandle,
} from './payment-method.service';

/**
 * Payment-method management (billing PRD §3.3, audit B10 + B25).
 *
 * Three properties are pinned here and each of them is a security
 * property, not a nicety:
 *
 *   1. **No card datum ever crosses this service.** Adding a card is a
 *      redirect to the provider's hosted element; there is no input for
 *      a PAN anywhere in the flow.
 *   2. **A client can only ever address its OWN cards.** The wire id is
 *      a derived handle and is resolved by scanning the caller's own
 *      provider customer, so a handle from another account (or another
 *      organization) matches nothing.
 *   3. **Removing the last card on an active PAID plan is refused**, not
 *      silently allowed and not silently cancelling the plan.
 */

const PM_A = { ref: 'pm_a', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2031 };
const PM_B = { ref: 'pm_b', brand: 'amex', last4: '1881', expMonth: 9, expYear: 2030 };

function makeProvider(overrides: Record<string, unknown> = {}) {
    return {
        isConfigured: jest.fn().mockReturnValue(true),
        getProviderId: jest.fn().mockReturnValue('stripe'),
        ensureCustomer: jest.fn().mockResolvedValue('cus_1'),
        createPaymentMethodSetupSession: jest
            .fn()
            .mockResolvedValue({ url: 'https://pay.example/seti_1', sessionId: 'cs_setup_1' }),
        listPaymentMethods: jest.fn().mockResolvedValue([PM_A]),
        findPaymentMethod: jest.fn().mockResolvedValue(PM_A),
        setDefaultPaymentMethod: jest
            .fn()
            .mockImplementation((_c: string, ref: string) =>
                Promise.resolve([PM_A, PM_B].find((m) => m.ref === ref) ?? PM_A),
            ),
        detachPaymentMethod: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    } as any;
}

function makeProfileRepo(profile: Record<string, unknown> | null) {
    const state = profile ? { ...profile } : null;
    return {
        findByUserId: jest.fn().mockImplementation(() => Promise.resolve(state)),
        ensure: jest.fn().mockResolvedValue(state ?? { userId: 'u1', providerCustomerId: 'cus_1' }),
        updatePaymentMethod: jest.fn().mockResolvedValue(state),
        updateAutoRecharge: jest.fn().mockResolvedValue(state),
        ...({} as Record<string, unknown>),
    } as any;
}

function makeSubscriptionRepo(monthlyPrice: string | null) {
    return {
        findActiveByUser: jest
            .fn()
            .mockResolvedValue(monthlyPrice === null ? null : { plan: { monthlyPrice } }),
    } as any;
}

function makeUserRepo() {
    return { findById: jest.fn().mockResolvedValue({ id: 'u1', email: 'u@e.test' }) } as any;
}

function build(options: {
    provider?: any;
    profile?: Record<string, unknown> | null;
    monthlyPrice?: string | null;
}) {
    const provider = options.provider ?? makeProvider();
    const profileRepo = makeProfileRepo(
        options.profile === undefined
            ? { userId: 'u1', providerCustomerId: 'cus_1', defaultPaymentMethodRef: 'pm_a' }
            : options.profile,
    );
    const subscriptionRepo = makeSubscriptionRepo(
        options.monthlyPrice === undefined ? null : options.monthlyPrice,
    );
    const userRepo = makeUserRepo();
    const service = new PaymentMethodService(provider, profileRepo, subscriptionRepo, userRepo);
    return { service, provider, profileRepo, subscriptionRepo, userRepo };
}

describe('paymentMethodHandle', () => {
    it('is deterministic and does not leak the provider reference', () => {
        const handle = paymentMethodHandle('pm_secret_reference');
        expect(handle).toBe(paymentMethodHandle('pm_secret_reference'));
        expect(handle).not.toContain('pm_');
        expect(handle).toHaveLength(32);
    });

    it('separates different references', () => {
        expect(paymentMethodHandle('pm_a')).not.toBe(paymentMethodHandle('pm_b'));
    });
});

describe('PaymentMethodService — add (hosted capture)', () => {
    it('returns the PROVIDER-hosted redirect and never touches card data', async () => {
        const { service, provider } = build({});

        const started = await service.startSetup('u1', {
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
        });

        expect(started).toEqual({ url: 'https://pay.example/seti_1', sessionId: 'cs_setup_1' });
        const request = provider.createPaymentMethodSetupSession.mock.calls[0][0];
        // The request carries identity + return URLs and nothing else —
        // in particular, no card number, expiry or CVC.
        expect(Object.keys(request).sort()).toEqual(
            ['cancelUrl', 'customerId', 'successUrl', 'userEmail', 'userId'].sort(),
        );
    });

    it('uses the SERVER-resolved provider customer, never a client value', async () => {
        const { service, provider } = build({});

        await service.startSetup('u1', {
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
        });

        expect(provider.createPaymentMethodSetupSession).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1', customerId: 'cus_1' }),
        );
    });

    it('lazily creates the billing profile so a card can be added BEFORE any purchase', async () => {
        const { service, profileRepo, provider } = build({ profile: null });
        profileRepo.ensure.mockResolvedValue({ userId: 'u1', providerCustomerId: 'cus_new' });
        provider.ensureCustomer.mockResolvedValue('cus_new');

        await service.startSetup('u1', {
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
        });

        expect(profileRepo.ensure).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1', providerCustomerId: 'cus_new' }),
        );
    });

    it('fails closed when the provider is not configured', async () => {
        const provider = makeProvider({ isConfigured: jest.fn().mockReturnValue(false) });
        const { service } = build({ provider });

        await expect(
            service.startSetup('u1', {
                successUrl: 'https://app.test/ok',
                cancelUrl: 'https://app.test/no',
            }),
        ).rejects.toBeInstanceOf(BillingProviderNotConfiguredError);
    });
});

describe('PaymentMethodService — list', () => {
    it('projects display metadata only and hides the provider reference', async () => {
        const provider = makeProvider({ listPaymentMethods: jest.fn().mockResolvedValue([PM_A]) });
        const { service } = build({ provider });

        const result = await service.list('u1');

        expect(result.methods).toEqual([
            {
                id: paymentMethodHandle('pm_a'),
                brand: 'visa',
                last4: '4242',
                expMonth: 4,
                expYear: 2031,
                isDefault: true,
            },
        ]);
        expect(JSON.stringify(result)).not.toContain('pm_a');
    });

    it('lists against the OWNER’S provider customer only', async () => {
        const { service, provider } = build({});

        await service.list('u1');

        expect(provider.listPaymentMethods).toHaveBeenCalledWith('cus_1');
    });

    it('adopts the first card as default when we hold none (no-webhook deployments)', async () => {
        const provider = makeProvider({ listPaymentMethods: jest.fn().mockResolvedValue([PM_B]) });
        const { service, profileRepo } = build({
            provider,
            profile: { userId: 'u1', providerCustomerId: 'cus_1', defaultPaymentMethodRef: null },
        });

        const result = await service.list('u1');

        expect(profileRepo.updatePaymentMethod).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                defaultPaymentMethodRef: 'pm_b',
                paymentMethodLast4: '1881',
            }),
        );
        expect(result.methods[0].isDefault).toBe(true);
    });

    it('drops a stored reference the provider no longer has', async () => {
        const provider = makeProvider({ listPaymentMethods: jest.fn().mockResolvedValue([]) });
        const { service, profileRepo } = build({ provider });

        const result = await service.list('u1');

        expect(result.methods).toEqual([]);
        expect(profileRepo.updatePaymentMethod).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ defaultPaymentMethodRef: null }),
        );
    });

    it('degrades to an empty list (never throws) with no billing profile', async () => {
        const { service } = build({ profile: null });
        await expect(service.list('u1')).resolves.toEqual({
            providerConfigured: true,
            methods: [],
        });
    });

    it('reports providerConfigured:false so the UI can render coming-soon', async () => {
        const provider = makeProvider({ isConfigured: jest.fn().mockReturnValue(false) });
        const { service } = build({ provider });
        await expect(service.list('u1')).resolves.toEqual({
            providerConfigured: false,
            methods: [],
        });
    });
});

describe('PaymentMethodService — replace (set default)', () => {
    it('promotes an owned card and mirrors the summary', async () => {
        const provider = makeProvider({
            listPaymentMethods: jest.fn().mockResolvedValue([PM_A, PM_B]),
        });
        const { service, profileRepo } = build({ provider });

        const row = await service.setDefault('u1', paymentMethodHandle('pm_b'));

        expect(provider.setDefaultPaymentMethod).toHaveBeenCalledWith('cus_1', 'pm_b');
        expect(profileRepo.updatePaymentMethod).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ defaultPaymentMethodRef: 'pm_b' }),
        );
        expect(row).toEqual(
            expect.objectContaining({ id: paymentMethodHandle('pm_b'), isDefault: true }),
        );
    });

    it('404s on a handle that belongs to ANOTHER account', async () => {
        const provider = makeProvider({ listPaymentMethods: jest.fn().mockResolvedValue([PM_A]) });
        const { service } = build({ provider });

        // A handle lifted from somebody else's account matches nothing in
        // the caller's own list — the mutation never reaches the provider.
        await expect(
            service.setDefault('u1', paymentMethodHandle('pm_victim')),
        ).rejects.toBeInstanceOf(PaymentMethodNotFoundError);
        expect(provider.setDefaultPaymentMethod).not.toHaveBeenCalled();
    });

    it('404s when the caller has no billing profile at all', async () => {
        const { service } = build({ profile: null });
        await expect(service.setDefault('u1', 'anything')).rejects.toBeInstanceOf(
            PaymentMethodNotFoundError,
        );
    });
});

describe('PaymentMethodService — remove', () => {
    it('REFUSES to remove the last card while a paid plan is active (409)', async () => {
        const provider = makeProvider({ listPaymentMethods: jest.fn().mockResolvedValue([PM_A]) });
        const { service } = build({ provider, monthlyPrice: '29.00' });

        await expect(service.remove('u1', paymentMethodHandle('pm_a'))).rejects.toBeInstanceOf(
            LastPaymentMethodError,
        );
        expect(provider.detachPaymentMethod).not.toHaveBeenCalled();
    });

    it('allows removing the last card on a FREE plan', async () => {
        const provider = makeProvider({
            listPaymentMethods: jest.fn().mockResolvedValueOnce([PM_A]).mockResolvedValue([]),
        });
        const { service } = build({ provider, monthlyPrice: '0' });

        await service.remove('u1', paymentMethodHandle('pm_a'));

        expect(provider.detachPaymentMethod).toHaveBeenCalledWith('cus_1', 'pm_a');
    });

    it('allows removing a NON-last card even on a paid plan', async () => {
        const provider = makeProvider({
            listPaymentMethods: jest
                .fn()
                .mockResolvedValueOnce([PM_A, PM_B])
                .mockResolvedValue([PM_B]),
        });
        const { service } = build({ provider, monthlyPrice: '99.00' });

        await service.remove('u1', paymentMethodHandle('pm_a'));

        expect(provider.detachPaymentMethod).toHaveBeenCalledWith('cus_1', 'pm_a');
    });

    it('promotes a survivor when the removed card was the default', async () => {
        const provider = makeProvider({
            listPaymentMethods: jest
                .fn()
                .mockResolvedValueOnce([PM_A, PM_B])
                .mockResolvedValue([PM_B]),
        });
        const { service, profileRepo } = build({ provider, monthlyPrice: '0' });

        await service.remove('u1', paymentMethodHandle('pm_a'));

        // Our stored default and the provider's must not diverge — an
        // auto-recharge charges whatever we stored.
        expect(provider.setDefaultPaymentMethod).toHaveBeenCalledWith('cus_1', 'pm_b');
        expect(profileRepo.updatePaymentMethod).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ defaultPaymentMethodRef: 'pm_b' }),
        );
    });

    it('switches auto-recharge OFF when the last card goes (it cannot run without one)', async () => {
        const provider = makeProvider({
            listPaymentMethods: jest.fn().mockResolvedValueOnce([PM_A]).mockResolvedValue([]),
        });
        const { service, profileRepo } = build({
            provider,
            monthlyPrice: null,
            profile: {
                userId: 'u1',
                providerCustomerId: 'cus_1',
                defaultPaymentMethodRef: 'pm_a',
                autoRechargeEnabled: true,
                autoRechargeThresholdCredits: 100,
                autoRechargePackId: 'credits-1000',
            },
        });

        await service.remove('u1', paymentMethodHandle('pm_a'));

        expect(profileRepo.updateAutoRecharge).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ autoRechargeEnabled: false }),
        );
    });

    it('404s on a handle the caller does not own — no detach reaches the provider', async () => {
        const provider = makeProvider({ listPaymentMethods: jest.fn().mockResolvedValue([PM_A]) });
        const { service } = build({ provider });

        await expect(service.remove('u1', paymentMethodHandle('pm_victim'))).rejects.toBeInstanceOf(
            PaymentMethodNotFoundError,
        );
        expect(provider.detachPaymentMethod).not.toHaveBeenCalled();
    });
});
