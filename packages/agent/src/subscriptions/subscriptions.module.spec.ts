import * as subscriptionsBarrel from './index';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { SubscriptionsModule } from './subscriptions.module';
import { SubscriptionService } from './subscription.service';
import { UsageLedgerService } from './usage-ledger.service';
import {
    BillingProvider,
    BillingProviderError,
    BillingProviderNotConfiguredError,
    ManualBillingProvider,
} from './billing/billing.provider';
import { StripeBillingProvider, STRIPE_METADATA_KEYS } from './billing/stripe-billing.provider';
import {
    BillingService,
    NoActiveSubscriptionError,
    UnknownCreditPackError,
} from './billing/billing.service';
import { AutoRechargeService } from './billing/auto-recharge.service';
import {
    LastPaymentMethodError,
    PaymentMethodNotFoundError,
    PaymentMethodService,
} from './billing/payment-method.service';
import {
    CheckoutSessionNotFoundError,
    PlanNotPurchasableError,
    PlanSubscriptionService,
    UnknownSubscriptionPlanError,
} from './billing/plan-subscription.service';
import { CREDIT_PACKS, CREDIT_PACK_IDS } from './billing/credit-packs';
import { CreditLedgerService, InsufficientCreditsError } from './credits/credit-ledger.service';
import { ENTITLEMENT_KEYS, EntitlementsService } from './credits/entitlements.service';
import { RunCostSettlementService } from './credits/run-cost-settlement.service';
import {
    InvalidUsagePeriodError,
    resolveUsageSummaryWindow,
    USAGE_EXPORT_COLUMNS,
    USAGE_SUMMARY_GROUP_BYS,
    UsageSummaryService,
} from './credits/usage-summary.service';
import {
    COSTS_DAILY_MAX_SERIES,
    COSTS_DEFAULT_WINDOW_DAYS,
    COSTS_OTHER_SERIES_KEY,
    COSTS_TOP_RUNS_DEFAULT_LIMIT,
    COSTS_TOP_RUNS_MAX_LIMIT,
    COSTS_UNATTRIBUTED_SERIES_KEY,
    COSTS_WINDOW_DAYS,
    CostsSummaryService,
    InvalidCostsWindowError,
    resolveCostsWindow,
} from './credits/costs-summary.service';

/**
 * Pins the public `@ever-works/agent/subscriptions` barrel surface and the
 * `SubscriptionsModule` provider/exports map. Both are wire-format-stable
 * contracts: `apps/api/src/subscriptions/` imports the same names; flipping
 * a `provide`/`useClass` mapping changes which BillingProvider implementation
 * the platform talks to. Note the deliberate decoupling: `UsageLedgerService`
 * depends on `BillingProvider` (abstract token), with `ManualBillingProvider`
 * as the default `useClass` binding.
 */

describe('SubscriptionsModule + barrel re-exports', () => {
    describe('barrel re-exports', () => {
        it('re-exports SubscriptionsModule', () => {
            expect(subscriptionsBarrel.SubscriptionsModule).toBe(SubscriptionsModule);
        });

        it('re-exports SubscriptionService', () => {
            expect(subscriptionsBarrel.SubscriptionService).toBe(SubscriptionService);
        });

        it('re-exports UsageLedgerService', () => {
            expect(subscriptionsBarrel.UsageLedgerService).toBe(UsageLedgerService);
        });

        it('re-exports BillingProvider (abstract) AND ManualBillingProvider (default impl)', () => {
            expect(subscriptionsBarrel.BillingProvider).toBe(BillingProvider);
            expect(subscriptionsBarrel.ManualBillingProvider).toBe(ManualBillingProvider);
        });

        it('re-exports the credits surface (pricing Wave 9 M1)', () => {
            expect(subscriptionsBarrel.CreditLedgerService).toBe(CreditLedgerService);
            expect(subscriptionsBarrel.EntitlementsService).toBe(EntitlementsService);
            expect(subscriptionsBarrel.InsufficientCreditsError).toBe(InsufficientCreditsError);
            expect(subscriptionsBarrel.ENTITLEMENT_KEYS).toBe(ENTITLEMENT_KEYS);
        });

        it('re-exports the run-cost settlement surface (pricing Wave 9 M2)', () => {
            // The RUN_CREDITS_PRECHECK / RUN_COST_SETTLER tokens live in
            // the agents / database barrels respectively (leaf files
            // beside their consumers) — only the implementation is here.
            expect(subscriptionsBarrel.RunCostSettlementService).toBe(RunCostSettlementService);
        });

        it('re-exports the usage-summary surface (Wave 13 Billing/Usage UI)', () => {
            expect(subscriptionsBarrel.UsageSummaryService).toBe(UsageSummaryService);
            expect(subscriptionsBarrel.resolveUsageSummaryWindow).toBe(resolveUsageSummaryWindow);
            expect(subscriptionsBarrel.InvalidUsagePeriodError).toBe(InvalidUsagePeriodError);
            expect(subscriptionsBarrel.USAGE_SUMMARY_GROUP_BYS).toBe(USAGE_SUMMARY_GROUP_BYS);
        });

        it('re-exports the costs-dashboard surface', () => {
            expect(subscriptionsBarrel.CostsSummaryService).toBe(CostsSummaryService);
            expect(subscriptionsBarrel.resolveCostsWindow).toBe(resolveCostsWindow);
            expect(subscriptionsBarrel.InvalidCostsWindowError).toBe(InvalidCostsWindowError);
            expect(subscriptionsBarrel.COSTS_WINDOW_DAYS).toBe(COSTS_WINDOW_DAYS);
            // The window vocabulary is a wire contract: the API DTO
            // validates against it and the web selector renders it.
            expect(COSTS_WINDOW_DAYS).toEqual([7, 30, 90]);
            expect(COSTS_DEFAULT_WINDOW_DAYS).toBe(30);
        });

        it('re-exports the account-wide CSV export column contract (B29)', () => {
            expect(subscriptionsBarrel.USAGE_EXPORT_COLUMNS).toBe(USAGE_EXPORT_COLUMNS);
            // Pinned column order — the CSV header is a wire format the
            // downloaded file's consumers (spreadsheets, finance tooling)
            // depend on; reordering silently breaks them.
            expect(USAGE_EXPORT_COLUMNS).toEqual([
                'occurredAt',
                'pluginId',
                'capability',
                'units',
                'costCents',
                'currency',
                'modelId',
                'workId',
                'agentId',
                'taskId',
                'runId',
                'requestId',
            ]);
        });

        it('re-exports the money path (billing PRD B5)', () => {
            expect(subscriptionsBarrel.BillingService).toBe(BillingService);
            expect(subscriptionsBarrel.AutoRechargeService).toBe(AutoRechargeService);
            expect(subscriptionsBarrel.StripeBillingProvider).toBe(StripeBillingProvider);
            expect(subscriptionsBarrel.CREDIT_PACKS).toBe(CREDIT_PACKS);
            expect(subscriptionsBarrel.UnknownCreditPackError).toBe(UnknownCreditPackError);
            // Subscription lifecycle (audit B07/B08) — cancel/resume and
            // the portal recovery action map this to a 409 at the API.
            expect(subscriptionsBarrel.NoActiveSubscriptionError).toBe(NoActiveSubscriptionError);
            expect(subscriptionsBarrel.BillingProviderNotConfiguredError).toBe(
                BillingProviderNotConfiguredError,
            );
            expect(subscriptionsBarrel.BillingProviderError).toBe(BillingProviderError);
        });

        it('re-exports the paid-plan purchase path (audit B24)', () => {
            expect(subscriptionsBarrel.PlanSubscriptionService).toBe(PlanSubscriptionService);
            expect(subscriptionsBarrel.PaymentMethodService).toBe(PaymentMethodService);
            expect(subscriptionsBarrel.PaymentMethodNotFoundError).toBe(PaymentMethodNotFoundError);
            expect(subscriptionsBarrel.LastPaymentMethodError).toBe(LastPaymentMethodError);
            expect(subscriptionsBarrel.UnknownSubscriptionPlanError).toBe(
                UnknownSubscriptionPlanError,
            );
            expect(subscriptionsBarrel.PlanNotPurchasableError).toBe(PlanNotPurchasableError);
            expect(subscriptionsBarrel.CheckoutSessionNotFoundError).toBe(
                CheckoutSessionNotFoundError,
            );
        });

        it('exposes the documented runtime symbols only (no extras silently appearing)', () => {
            const runtimeKeys = Object.keys(subscriptionsBarrel).sort();
            expect(runtimeKeys).toEqual(
                [
                    'SubscriptionsModule',
                    'SubscriptionService',
                    'UsageLedgerService',
                    'BillingProvider',
                    'BillingProviderError',
                    'BillingProviderNotConfiguredError',
                    'ManualBillingProvider',
                    // The money path (billing PRD B5)
                    'CREDIT_PACKS',
                    'CREDIT_PACK_IDS',
                    'findCreditPack',
                    'defaultAutoRechargePack',
                    'StripeBillingProvider',
                    'STRIPE_METADATA_KEYS',
                    'STRIPE_PERPETUAL_LICENCE',
                    'STRIPE_PURCHASE_KINDS',
                    'STRIPE_CLIENT_FACTORY',
                    'BillingService',
                    'BILLING_PAYMENT_REF_TYPE',
                    'UnknownCreditPackError',
                    // Subscription lifecycle (audit B07/B08)
                    'NoActiveSubscriptionError',
                    'AutoRechargeService',
                    // Paid-plan purchase (audit B24)
                    'PlanSubscriptionService',
                    'UnknownSubscriptionPlanError',
                    'PlanNotPurchasableError',
                    'CheckoutSessionNotFoundError',
                    // Payment methods (audit B10/B25)
                    'PaymentMethodService',
                    'PaymentMethodNotFoundError',
                    'LastPaymentMethodError',
                    // Provider-side setup-session marker + the handle
                    // helper the payment-method routes share.
                    'STRIPE_SETUP_KIND',
                    'paymentMethodHandle',
                    // Credits ledger + plan entitlements (pricing Wave 9 M1)
                    'CreditLedgerService',
                    'InsufficientCreditsError',
                    // Transcript retention sentinels (#1877).
                    'RETENTION_FOREVER',
                    'RETENTION_NONE',
                    'EntitlementsService',
                    'ENTITLEMENT_KEYS',
                    // Run-cost settlement (pricing Wave 9 M2)
                    'RunCostSettlementService',
                    // Usage-summary aggregations (Wave 13 Billing/Usage UI)
                    'UsageSummaryService',
                    'resolveUsageSummaryWindow',
                    'InvalidUsagePeriodError',
                    'USAGE_SUMMARY_GROUP_BYS',
                    // Account-wide usage CSV export (B29)
                    'USAGE_EXPORT_COLUMNS',
                    // Costs dashboard aggregations
                    'CostsSummaryService',
                    'resolveCostsWindow',
                    'InvalidCostsWindowError',
                    'COSTS_WINDOW_DAYS',
                    'COSTS_DEFAULT_WINDOW_DAYS',
                    'COSTS_TOP_RUNS_DEFAULT_LIMIT',
                    'COSTS_TOP_RUNS_MAX_LIMIT',
                    'COSTS_DAILY_MAX_SERIES',
                    'COSTS_UNATTRIBUTED_SERIES_KEY',
                    'COSTS_OTHER_SERIES_KEY',
                ].sort(),
            );
        });
    });

    describe('SubscriptionsModule decorator metadata', () => {
        // NestJS attaches @Module() metadata under the literal `imports`,
        // `providers`, `exports`, `controllers` keys via reflect-metadata.
        // Pinning them protects against accidental dependency-graph drift.
        function getMeta(key: 'imports' | 'providers' | 'exports'): any[] {
            return Reflect.getMetadata(key, SubscriptionsModule) ?? [];
        }

        it('declares SubscriptionService and UsageLedgerService as providers', () => {
            const providers = getMeta('providers');
            expect(providers).toContain(SubscriptionService);
            expect(providers).toContain(UsageLedgerService);
        });

        it('declares the credits services (Wave 9 M1) as providers', () => {
            const providers = getMeta('providers');
            expect(providers).toContain(CreditLedgerService);
            expect(providers).toContain(EntitlementsService);
        });

        it('declares + exports RunCostSettlementService (Wave 9 M2)', () => {
            expect(getMeta('providers')).toContain(RunCostSettlementService);
            expect(getMeta('exports')).toContain(RunCostSettlementService);
        });

        it('declares + exports UsageSummaryService (Wave 13 — consumed by apps/api CreditsController)', () => {
            expect(getMeta('providers')).toContain(UsageSummaryService);
            expect(getMeta('exports')).toContain(UsageSummaryService);
        });

        it('declares + exports CostsSummaryService (consumed by apps/api CostsController)', () => {
            expect(getMeta('providers')).toContain(CostsSummaryService);
            expect(getMeta('exports')).toContain(CostsSummaryService);
        });

        it('provides AgentRunRepository locally so CostsSummaryService can resolve it', () => {
            // AgentRunRepository is owned by AgentsModule, not the
            // DatabaseModule repository inventory — without this local
            // provider CostsSummaryService fails to instantiate at boot.
            expect(getMeta('providers')).toContain(AgentRunRepository);
            // Module-local on purpose: exporting it would hand consumers a
            // second AgentRunRepository instance beside AgentsModule's.
            expect(getMeta('exports')).not.toContain(AgentRunRepository);
        });

        it('binds the abstract BillingProvider token through a config-driven factory', () => {
            const providers = getMeta('providers');
            const billingBinding = providers.find(
                (p: any) => p && typeof p === 'object' && p.provide === BillingProvider,
            );
            expect(billingBinding).toBeDefined();
            expect(typeof billingBinding.useFactory).toBe('function');
            // Both implementations must be injectable into the factory so
            // a deployment can swap providers without touching consumers.
            expect(billingBinding.inject).toEqual([StripeBillingProvider, ManualBillingProvider]);
        });

        it('the BillingProvider factory picks the real provider only when it is configured', () => {
            const providers = getMeta('providers');
            const billingBinding = providers.find(
                (p: any) => p && typeof p === 'object' && p.provide === BillingProvider,
            );
            const stripe = { isConfigured: () => true } as unknown as StripeBillingProvider;
            const manual = {} as unknown as ManualBillingProvider;
            expect(billingBinding.useFactory(stripe, manual)).toBe(stripe);

            const unconfigured = { isConfigured: () => false } as unknown as StripeBillingProvider;
            expect(billingBinding.useFactory(unconfigured, manual)).toBe(manual);
        });

        it('declares + exports the money path (billing PRD B5)', () => {
            const providers = getMeta('providers');
            const exports = getMeta('exports');
            expect(providers).toContain(BillingService);
            expect(providers).toContain(AutoRechargeService);
            expect(providers).toContain(StripeBillingProvider);
            expect(providers).toContain(ManualBillingProvider);
            expect(exports).toContain(BillingService);
            expect(exports).toContain(AutoRechargeService);
        });

        it('declares + exports PlanSubscriptionService (audit B24 — paid-plan checkout)', () => {
            expect(getMeta('providers')).toContain(PlanSubscriptionService);
            expect(getMeta('providers')).toContain(PaymentMethodService);
            expect(getMeta('exports')).toContain(PlanSubscriptionService);
        });

        it('pins the credit-pack table to the packs published on the website', () => {
            expect(CREDIT_PACK_IDS).toEqual(['credits-1000', 'credits-5500', 'credits-25000']);
            expect(CREDIT_PACKS.map((p) => [p.priceCents, p.credits])).toEqual([
                [1000, 1000],
                [5000, 5500],
                [20000, 25000],
            ]);
        });

        it('pins the provider metadata keys the webhook attribution depends on', () => {
            expect(STRIPE_METADATA_KEYS).toEqual({
                kind: 'ever_works_kind',
                userId: 'ever_works_user_id',
                packId: 'ever_works_pack_id',
                referenceId: 'ever_works_reference_id',
                // Audit B24 — mirrored onto subscription_data.metadata so
                // renewals/cancels stay attributable to a tier.
                planCode: 'ever_works_plan_code',
                // Stamped ONLY on a one-off perpetual licence, on both the session and the payment
                // intent. Issuing the licence document is manual for now, so this is what makes a
                // sale findable: /v1/payment_intents/search with DOUBLE-quoted syntax. There is no
                // /v1/checkout/sessions/search endpoint, which is why the session alone is not
                // enough to carry it.
                licence: 'ever_works_licence',
            });
        });

        it('exports SubscriptionService, UsageLedgerService, and BillingProvider', () => {
            const exports = getMeta('exports');
            expect(exports).toContain(SubscriptionService);
            expect(exports).toContain(UsageLedgerService);
            expect(exports).toContain(BillingProvider);
        });

        it('exports the credits services (consumed by apps/api + the worker RPC proxy)', () => {
            const exports = getMeta('exports');
            expect(exports).toContain(CreditLedgerService);
            expect(exports).toContain(EntitlementsService);
        });

        it('does NOT export ManualBillingProvider directly — consumers use the abstract token', () => {
            const exports = getMeta('exports');
            expect(exports).not.toContain(ManualBillingProvider);
        });

        it('imports DatabaseModule (where the repositories are bound)', () => {
            const imports = getMeta('imports');
            // Pin presence by name to avoid coupling this test to the
            // modules' constructor identities.
            const importNames = imports.map((m: any) => m?.name ?? String(m));
            expect(importNames).toContain('DatabaseModule');
        });

        it('imports NotificationsModule (Wave 9 M2 — exhaustion notifications)', () => {
            const importNames = getMeta('imports').map((m: any) => m?.name ?? String(m));
            expect(importNames).toContain('NotificationsModule');
        });
    });
});
