import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { PluginUsageService } from './plugin-usage.service';
import { CREDIT_PRICE_LIST, PublishedCreditPriceList } from './credit-price-list';
import { SettingsUsagePayerResolver, USAGE_PAYER_RESOLVER } from './usage-payer-resolver';

/**
 * EW-602 — wires the per-call usage recording service backed by
 * PluginUsageRepository (provided by DatabaseModule). Imported by
 * FacadesModule so each capability facade can record events.
 *
 * AW-17 — also binds the two ports the write path classifies with:
 *  - `CREDIT_PRICE_LIST`    the published credit price list (default: the
 *                           versioned pricebook). Exported, so the pricing
 *                           view and the receipts read the SAME list.
 *  - `USAGE_PAYER_RESOLVER` who paid the provider, from the resolved
 *                           settings of the Plugin that served the call
 *                           (`PluginSettingsService` comes from the global
 *                           PluginsModule; unbound ⇒ `unconfirmed`).
 * Either binding can be replaced without touching a service.
 */
@Module({
    imports: [DatabaseModule],
    providers: [
        PluginUsageService,
        { provide: CREDIT_PRICE_LIST, useFactory: () => new PublishedCreditPriceList() },
        SettingsUsagePayerResolver,
        { provide: USAGE_PAYER_RESOLVER, useExisting: SettingsUsagePayerResolver },
    ],
    exports: [PluginUsageService, CREDIT_PRICE_LIST, USAGE_PAYER_RESOLVER],
})
export class UsageModule {}
