import * as subscriptionsBarrel from './index';
import { SubscriptionsModule } from './subscriptions.module';
import { SubscriptionService } from './subscription.service';
import { UsageLedgerService } from './usage-ledger.service';
import { BillingProvider, ManualBillingProvider } from './billing/billing.provider';
import { CreditLedgerService, InsufficientCreditsError } from './credits/credit-ledger.service';
import { ENTITLEMENT_KEYS, EntitlementsService } from './credits/entitlements.service';
import { RunCostSettlementService } from './credits/run-cost-settlement.service';
import {
    InvalidUsagePeriodError,
    resolveUsageSummaryWindow,
    USAGE_SUMMARY_GROUP_BYS,
    UsageSummaryService,
} from './credits/usage-summary.service';

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

        it('exposes the documented runtime symbols only (no extras silently appearing)', () => {
            const runtimeKeys = Object.keys(subscriptionsBarrel).sort();
            expect(runtimeKeys).toEqual(
                [
                    'SubscriptionsModule',
                    'SubscriptionService',
                    'UsageLedgerService',
                    'BillingProvider',
                    'ManualBillingProvider',
                    // Credits ledger + plan entitlements (pricing Wave 9 M1)
                    'CreditLedgerService',
                    'InsufficientCreditsError',
                    'EntitlementsService',
                    'ENTITLEMENT_KEYS',
                    // Run-cost settlement (pricing Wave 9 M2)
                    'RunCostSettlementService',
                    // Usage-summary aggregations (Wave 13 Billing/Usage UI)
                    'UsageSummaryService',
                    'resolveUsageSummaryWindow',
                    'InvalidUsagePeriodError',
                    'USAGE_SUMMARY_GROUP_BYS',
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

        it('binds the abstract BillingProvider token to ManualBillingProvider via useClass', () => {
            const providers = getMeta('providers');
            const billingBinding = providers.find(
                (p: any) => p && typeof p === 'object' && p.provide === BillingProvider,
            );
            expect(billingBinding).toBeDefined();
            expect(billingBinding.useClass).toBe(ManualBillingProvider);
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
