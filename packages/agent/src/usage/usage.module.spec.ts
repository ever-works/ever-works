import { UsageModule } from './usage.module';
import { PluginUsageService } from './plugin-usage.service';
import { CREDIT_PRICE_LIST, PublishedCreditPriceList } from './credit-price-list';
import { SettingsUsagePayerResolver, USAGE_PAYER_RESOLVER } from './usage-payer-resolver';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

/**
 * AW-17 — the usage write path classifies through two replaceable ports.
 * Pins that both are bound by default and exported, and that the
 * subscriptions graph sees the SAME price list the write path prices with.
 */
describe('UsageModule (AW-17 ports)', () => {
    const meta = (key: 'providers' | 'exports' | 'imports', target: object = UsageModule) =>
        (Reflect.getMetadata(key, target) ?? []) as any[];

    it('still provides and exports PluginUsageService', () => {
        expect(meta('providers')).toContain(PluginUsageService);
        expect(meta('exports')).toContain(PluginUsageService);
    });

    it('binds the credit price list port to the published default and exports it', () => {
        const binding = meta('providers').find(
            (provider) => provider && provider.provide === CREDIT_PRICE_LIST,
        );
        expect(binding).toBeDefined();
        expect(binding.useFactory()).toBeInstanceOf(PublishedCreditPriceList);
        expect(meta('exports')).toContain(CREDIT_PRICE_LIST);
    });

    it('binds the payer resolver port to the settings-backed resolver and exports it', () => {
        const binding = meta('providers').find(
            (provider) => provider && provider.provide === USAGE_PAYER_RESOLVER,
        );
        expect(binding).toEqual({
            provide: USAGE_PAYER_RESOLVER,
            useExisting: SettingsUsagePayerResolver,
        });
        expect(meta('providers')).toContain(SettingsUsagePayerResolver);
        expect(meta('exports')).toContain(USAGE_PAYER_RESOLVER);
    });

    it('is imported and re-exported by SubscriptionsModule, so the pricing view reads the same list', () => {
        expect(meta('imports', SubscriptionsModule)).toContain(UsageModule);
        expect(meta('exports', SubscriptionsModule)).toContain(UsageModule);
    });
});
