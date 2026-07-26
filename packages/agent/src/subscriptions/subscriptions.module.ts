import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { NotificationsModule } from '@src/notifications/notifications.module';
import { SubscriptionService } from './subscription.service';
import { UsageLedgerService } from './usage-ledger.service';
import { BillingProvider, ManualBillingProvider } from './billing/billing.provider';
import { StripeBillingProvider } from './billing/stripe-billing.provider';
import { BillingService } from './billing/billing.service';
import { AutoRechargeService } from './billing/auto-recharge.service';
import { CreditLedgerService } from './credits/credit-ledger.service';
import { EntitlementsService } from './credits/entitlements.service';
import { RunCostSettlementService } from './credits/run-cost-settlement.service';
import { UsageSummaryService } from './credits/usage-summary.service';

@Module({
    imports: [
        DatabaseModule,
        // Wave 9 M2 — RunCostSettlementService emits the balance-exhausted
        // notification through the existing NotificationService.
        NotificationsModule,
    ],
    providers: [
        SubscriptionService,
        UsageLedgerService,
        // Credits ledger + plan entitlements (pricing Wave 9 M1) —
        // additive beside the existing plan/usage-ledger services.
        CreditLedgerService,
        EntitlementsService,
        // Run-cost settlement + gate precheck (pricing Wave 9 M2) — the
        // api-side @Global() SubscriptionsModule binds this instance to
        // the RUN_COST_SETTLER + RUN_CREDITS_PRECHECK tokens.
        RunCostSettlementService,
        // Account-wide usage aggregations behind
        // `GET /api/credits/usage-summary` (Wave 13 Billing/Usage UI).
        UsageSummaryService,
        // The money path (billing PRD B5) — checkout, webhook, invoices,
        // auto-recharge. Additive beside the read-only credits surface.
        BillingService,
        AutoRechargeService,
        // Both provider implementations are instantiable; the factory
        // below picks one PER DEPLOYMENT from configuration. Keeping
        // ManualBillingProvider as a real provider means the fallback is
        // a supported binding, not an accident.
        ManualBillingProvider,
        StripeBillingProvider,
        {
            provide: BillingProvider,
            // A deployment with STRIPE_SECRET_KEY set talks to the real
            // provider; everything else (local dev, self-hosted BYOS, CI)
            // keeps the manual no-money-moves binding and every money
            // method fails closed with BillingProviderNotConfiguredError.
            useFactory: (stripe: StripeBillingProvider, manual: ManualBillingProvider) =>
                stripe.isConfigured() ? stripe : manual,
            inject: [StripeBillingProvider, ManualBillingProvider],
        },
    ],
    exports: [
        SubscriptionService,
        UsageLedgerService,
        CreditLedgerService,
        EntitlementsService,
        RunCostSettlementService,
        UsageSummaryService,
        BillingService,
        AutoRechargeService,
        BillingProvider,
    ],
})
export class SubscriptionsModule {}
