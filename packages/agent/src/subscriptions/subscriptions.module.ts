import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '@src/database/database.module';
import { AgentRun } from '@src/entities/agent-run.entity';
import { AgentRunRepository } from '@src/database/repositories/agent-run.repository';
import { NotificationsModule } from '@src/notifications/notifications.module';
import { SubscriptionService } from './subscription.service';
import { UsageLedgerService } from './usage-ledger.service';
import { BillingProvider, ManualBillingProvider } from './billing/billing.provider';
import { StripeBillingProvider } from './billing/stripe-billing.provider';
import { BillingService } from './billing/billing.service';
import { AutoRechargeService } from './billing/auto-recharge.service';
import { PlanSubscriptionService } from './billing/plan-subscription.service';
import { PaymentMethodService } from './billing/payment-method.service';
import { CreditLedgerService } from './credits/credit-ledger.service';
import { EntitlementsService } from './credits/entitlements.service';
import { RunCostSettlementService } from './credits/run-cost-settlement.service';
import { UsageSummaryService } from './credits/usage-summary.service';
import { CostsSummaryService } from './credits/costs-summary.service';

@Module({
    imports: [
        DatabaseModule,
        // Wave 9 M2 — RunCostSettlementService emits the balance-exhausted
        // notification through the existing NotificationService.
        NotificationsModule,
        // Costs dashboard — `AgentRunRepository` is not in the
        // `_repository-inventory` DatabaseModule exports (it is owned by
        // AgentsModule), so it is provided locally here. Same pattern,
        // and same reason, as `TerminalTranscriptModule`: importing
        // AgentsModule for two read-only aggregations would drag the
        // whole agent runtime into this module's graph. The local
        // instance never writes a terminal transition, so it never
        // exercises the RUN_COST_SETTLER hook.
        TypeOrmModule.forFeature([AgentRun]),
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
        // Costs dashboard — the `GET /api/usage/costs/*` aggregations
        // (spend by day/agent/model + top runs). Read-only; derived from
        // the same metering rows the usage summary reads.
        AgentRunRepository,
        CostsSummaryService,
        // The money path (billing PRD B5) — checkout, webhook, invoices,
        // auto-recharge. Additive beside the read-only credits surface.
        BillingService,
        AutoRechargeService,
        // Paid-plan purchase (audit B24) — the checkout + return + webhook
        // path that actually puts an account on a paid tier. Additive
        // beside the credit top-up path; shares the same provider seam.
        PlanSubscriptionService,
        // Add / replace / remove a stored payment method (billing PRD
        // §3.3, audit B10 + B25). Capture happens on the provider's
        // hosted element — no card datum ever reaches this process.
        PaymentMethodService,
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
        CostsSummaryService,
        BillingService,
        AutoRechargeService,
        PlanSubscriptionService,
        PaymentMethodService,
        BillingProvider,
    ],
})
export class SubscriptionsModule {}
