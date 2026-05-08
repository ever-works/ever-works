import * as subscriptionsBarrel from './index';
import { SubscriptionsModule } from './subscriptions.module';
import { SubscriptionService } from './subscription.service';
import { UsageLedgerService } from './usage-ledger.service';
import { BillingProvider, ManualBillingProvider } from './billing/billing.provider';

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

        it('exposes the documented runtime symbols only (no extras silently appearing)', () => {
            const runtimeKeys = Object.keys(subscriptionsBarrel).sort();
            expect(runtimeKeys).toEqual(
                [
                    'SubscriptionsModule',
                    'SubscriptionService',
                    'UsageLedgerService',
                    'BillingProvider',
                    'ManualBillingProvider',
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

        it('does NOT export ManualBillingProvider directly — consumers use the abstract token', () => {
            const exports = getMeta('exports');
            expect(exports).not.toContain(ManualBillingProvider);
        });

        it('imports DatabaseModule (where the repositories are bound)', () => {
            const imports = getMeta('imports');
            // DatabaseModule is the first (and only) import — pin its presence
            // by name to avoid coupling this test to its constructor identity.
            const importNames = imports.map((m: any) => m?.name ?? String(m));
            expect(importNames).toContain('DatabaseModule');
        });
    });
});
