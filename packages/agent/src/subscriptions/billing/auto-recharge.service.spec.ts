import { AutoRechargeService } from './auto-recharge.service';

/**
 * Threshold-triggered auto-recharge (billing PRD §3.4).
 *
 * The load-bearing property is "AT MOST once per crossing": the in-flight
 * slot is claimed with a compare-and-set, so two debits that both cross
 * the threshold produce exactly one off-session charge. These specs drive
 * that through a fake repository whose `claimAutoRechargeSlot` behaves
 * like the real `UPDATE … WHERE autoRechargeInFlightKey IS NULL`.
 */

const PROFILE = {
    userId: 'u1',
    provider: 'stripe',
    providerCustomerId: 'cus_1',
    defaultPaymentMethodRef: 'pm_1',
    autoRechargeEnabled: true,
    autoRechargeThresholdCredits: 500,
    autoRechargePackId: 'credits-5500',
    autoRechargeInFlightKey: null as string | null,
    autoRechargeFailureCount: 0,
};

function makeProvider(overrides: Record<string, unknown> = {}) {
    return {
        isConfigured: jest.fn().mockReturnValue(true),
        getProviderId: jest.fn().mockReturnValue('stripe'),
        chargeOffSession: jest
            .fn()
            .mockResolvedValue({ paymentId: 'pi_auto_1', status: 'succeeded' }),
        ...overrides,
    } as any;
}

/**
 * Fake profile repository with REAL compare-and-set semantics: the first
 * claimant wins, every later claimant loses until the slot is released.
 */
function makeProfileRepository(profile: any = { ...PROFILE }) {
    const state = profile ? { ...profile } : null;
    return {
        state,
        findByUserId: jest.fn().mockImplementation(async () => (state ? { ...state } : null)),
        claimAutoRechargeSlot: jest.fn().mockImplementation(async (_userId, key, now) => {
            if (!state || state.autoRechargeInFlightKey) {
                return false;
            }
            state.autoRechargeInFlightKey = key;
            state.autoRechargeInFlightAt = now;
            return true;
        }),
        releaseAutoRechargeSlot: jest.fn().mockImplementation(async () => {
            if (state) {
                state.autoRechargeInFlightKey = null;
            }
        }),
        recordAutoRechargeFailure: jest.fn().mockImplementation(async () => {
            if (state) {
                state.autoRechargeInFlightKey = null;
                state.autoRechargeFailureCount += 1;
            }
        }),
        resetAutoRechargeFailures: jest.fn(),
    } as any;
}

function makeLedgerService(balance = 100) {
    return {
        getBalance: jest.fn().mockResolvedValue(balance),
        record: jest.fn(),
    } as any;
}

describe('AutoRechargeService', () => {
    it('charges off-session when the balance falls below the threshold', async () => {
        const provider = makeProvider();
        const profiles = makeProfileRepository();
        const service = new AutoRechargeService(provider, profiles, makeLedgerService(100));

        const outcome = await service.maybeRecharge('u1');

        expect(outcome).toEqual(
            expect.objectContaining({ status: 'charged', packId: 'credits-5500' }),
        );
        expect(provider.chargeOffSession).toHaveBeenCalledWith(
            expect.objectContaining({
                customerId: 'cus_1',
                paymentMethodRef: 'pm_1',
                pack: expect.objectContaining({ id: 'credits-5500', priceCents: 5000 }),
            }),
        );
    });

    it('fires EXACTLY ONCE when two debits cross the threshold concurrently', async () => {
        const provider = makeProvider();
        const profiles = makeProfileRepository();
        const service = new AutoRechargeService(provider, profiles, makeLedgerService(100));

        const [first, second] = await Promise.all([
            service.maybeRecharge('u1'),
            service.maybeRecharge('u1'),
        ]);

        // Both crossings ran; only one placed a charge.
        expect(provider.chargeOffSession).toHaveBeenCalledTimes(1);
        const statuses = [first.status, second.status].sort();
        expect(statuses).toEqual(['already-in-flight', 'charged']);
    });

    it('does not re-fire while a previous top-up is still settling', async () => {
        const provider = makeProvider();
        const profiles = makeProfileRepository({
            ...PROFILE,
            autoRechargeInFlightKey: 'auto:u1:credits-5500:1',
        });
        const service = new AutoRechargeService(provider, profiles, makeLedgerService(0));

        const outcome = await service.maybeRecharge('u1');

        expect(outcome.status).toBe('already-in-flight');
        expect(provider.chargeOffSession).not.toHaveBeenCalled();
    });

    it('passes the claim key as the provider idempotency key', async () => {
        const provider = makeProvider();
        const profiles = makeProfileRepository();
        const service = new AutoRechargeService(provider, profiles, makeLedgerService(0));

        await service.maybeRecharge('u1', new Date(1_700_000_000_000));

        expect(provider.chargeOffSession.mock.calls[0][0].idempotencyKey).toBe(
            'auto:u1:credits-5500:1700000000000',
        );
    });

    it('does nothing while the balance is at or above the threshold', async () => {
        const provider = makeProvider();
        const profiles = makeProfileRepository();
        const service = new AutoRechargeService(provider, profiles, makeLedgerService(500));

        const outcome = await service.maybeRecharge('u1');

        expect(outcome).toEqual({ status: 'above-threshold', balanceCredits: 500 });
        expect(provider.chargeOffSession).not.toHaveBeenCalled();
        expect(profiles.claimAutoRechargeSlot).not.toHaveBeenCalled();
    });

    it('is disabled when the provider is not configured', async () => {
        const provider = makeProvider({ isConfigured: jest.fn().mockReturnValue(false) });
        const profiles = makeProfileRepository();
        const service = new AutoRechargeService(provider, profiles, makeLedgerService(0));

        expect(await service.maybeRecharge('u1')).toEqual({ status: 'disabled' });
        expect(provider.chargeOffSession).not.toHaveBeenCalled();
    });

    it('is disabled without a billing profile, a toggle, or a payment method', async () => {
        const provider = makeProvider();
        const ledger = makeLedgerService(0);

        expect(
            await new AutoRechargeService(
                provider,
                makeProfileRepository(null),
                ledger,
            ).maybeRecharge('u1'),
        ).toEqual({ status: 'disabled' });

        expect(
            await new AutoRechargeService(
                provider,
                makeProfileRepository({ ...PROFILE, autoRechargeEnabled: false }),
                ledger,
            ).maybeRecharge('u1'),
        ).toEqual({ status: 'disabled' });

        expect(
            await new AutoRechargeService(
                provider,
                makeProfileRepository({ ...PROFILE, defaultPaymentMethodRef: null }),
                ledger,
            ).maybeRecharge('u1'),
        ).toEqual({ status: 'disabled' });

        expect(provider.chargeOffSession).not.toHaveBeenCalled();
    });

    it('is disabled when no threshold has been set', async () => {
        const provider = makeProvider();
        const profiles = makeProfileRepository({
            ...PROFILE,
            autoRechargeThresholdCredits: null,
        });
        const service = new AutoRechargeService(provider, profiles, makeLedgerService(0));

        expect(await service.maybeRecharge('u1')).toEqual({ status: 'disabled' });
    });

    it('falls back to the smallest pack when the profile names none', async () => {
        const provider = makeProvider();
        const profiles = makeProfileRepository({ ...PROFILE, autoRechargePackId: null });
        const service = new AutoRechargeService(provider, profiles, makeLedgerService(0));

        const outcome = await service.maybeRecharge('u1');

        expect(outcome).toEqual(expect.objectContaining({ packId: 'credits-1000' }));
    });

    it('releases the guard and counts the failure when the provider declines', async () => {
        const provider = makeProvider({
            chargeOffSession: jest
                .fn()
                .mockResolvedValue({
                    paymentId: '',
                    status: 'failed',
                    failureCode: 'card_declined',
                }),
        });
        const profiles = makeProfileRepository();
        const service = new AutoRechargeService(provider, profiles, makeLedgerService(0));

        const outcome = await service.maybeRecharge('u1');

        expect(outcome).toEqual({ status: 'failed', failureCode: 'card_declined' });
        expect(profiles.recordAutoRechargeFailure).toHaveBeenCalledWith('u1', expect.any(Date));
        // Guard released — the next crossing may retry.
        expect(profiles.state.autoRechargeInFlightKey).toBeNull();
    });

    it('releases the guard when the provider call throws outright', async () => {
        const provider = makeProvider({
            chargeOffSession: jest.fn().mockRejectedValue(new Error('network down')),
        });
        const profiles = makeProfileRepository();
        const service = new AutoRechargeService(provider, profiles, makeLedgerService(0));

        expect(await service.maybeRecharge('u1')).toEqual({ status: 'failed' });
        expect(profiles.recordAutoRechargeFailure).toHaveBeenCalled();
    });

    it('NEVER writes to the ledger — credits appear only via the webhook', async () => {
        const provider = makeProvider();
        const profiles = makeProfileRepository();
        const ledger = makeLedgerService(0);
        const service = new AutoRechargeService(provider, profiles, ledger);

        await service.maybeRecharge('u1');

        expect(ledger.record).not.toHaveBeenCalled();
    });
});
