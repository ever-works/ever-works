import { BillingProvider, ManualBillingProvider } from './billing.provider';

/**
 * BillingProvider is the abstract surface UsageLedgerService talks to. The
 * concrete `ManualBillingProvider` is the default DI binding (see
 * SubscriptionsModule); it returns the platform's configured currency and
 * inherits the abstract's no-op `recordUsageCharge` hook so manual-billing
 * deployments do not need to wire an external Stripe gateway.
 */

describe('BillingProvider abstract', () => {
    class TestProvider extends BillingProvider {
        getDefaultCurrency(): string {
            return 'gbp';
        }
    }

    it('is a constructor function (subclass-able)', () => {
        expect(typeof BillingProvider).toBe('function');
    });

    it('subclasses must implement getDefaultCurrency()', () => {
        const provider = new TestProvider();
        expect(provider.getDefaultCurrency()).toBe('gbp');
    });

    it('default recordUsageCharge() is an async no-op resolving undefined (no external gateway by default)', async () => {
        const provider = new TestProvider();
        await expect(provider.recordUsageCharge({} as any)).resolves.toBeUndefined();
    });

    it('subclasses can override recordUsageCharge() and the parent contract still resolves', async () => {
        const onCharge = jest.fn().mockResolvedValue(undefined);
        class WithGateway extends BillingProvider {
            getDefaultCurrency(): string {
                return 'usd';
            }
            async recordUsageCharge(entry: any): Promise<void> {
                onCharge(entry);
            }
        }
        const provider = new WithGateway();
        await provider.recordUsageCharge({ id: 'led-1' });
        expect(onCharge).toHaveBeenCalledWith({ id: 'led-1' });
    });
});

describe('ManualBillingProvider', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('extends BillingProvider', () => {
        expect(new ManualBillingProvider()).toBeInstanceOf(BillingProvider);
    });

    it('returns config.billing.getDefaultCurrency() (default usd when env is unset)', () => {
        delete process.env.BILLING_DEFAULT_CURRENCY;
        const provider = new ManualBillingProvider();
        expect(provider.getDefaultCurrency()).toBe('usd');
    });

    it('passes through the configured currency from env (BILLING_DEFAULT_CURRENCY)', () => {
        process.env.BILLING_DEFAULT_CURRENCY = 'eur';
        const provider = new ManualBillingProvider();
        expect(provider.getDefaultCurrency()).toBe('eur');

        process.env.BILLING_DEFAULT_CURRENCY = 'jpy';
        expect(provider.getDefaultCurrency()).toBe('jpy');
    });

    it('inherits the no-op recordUsageCharge() (no external gateway in manual mode)', async () => {
        const provider = new ManualBillingProvider();
        await expect(provider.recordUsageCharge({ id: 'led-1' } as any)).resolves.toBeUndefined();
    });
});
