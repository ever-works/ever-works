import 'reflect-metadata';
import { REPOSITORY_PROVIDERS } from '@src/database/_repository-inventory';
import { SubscriptionsModule } from './subscriptions.module';
import { SubscriptionService } from './subscription.service';
import { CreditLedgerService } from './credits/credit-ledger.service';
import { EntitlementsService } from './credits/entitlements.service';
import { PlanRunLimitsService } from './credits/plan-run-limits.service';
import { RunCostSettlementService } from './credits/run-cost-settlement.service';
import { UsageSummaryService } from './credits/usage-summary.service';
import { PlanSubscriptionService } from './billing/plan-subscription.service';
import { PaymentMethodService } from './billing/payment-method.service';
import { BillingService } from './billing/billing.service';
import { AutoRechargeService } from './billing/auto-recharge.service';
import { CostsSummaryService } from './credits/costs-summary.service';
import { PluginSettingsService } from '@src/plugins/services/plugin-settings.service';

/**
 * Nest resolves constructor dependencies at BOOT, and nothing else in this repo
 * checks that it can.
 *
 * `subscriptions.module.spec.ts` asserts the shape of the module's metadata —
 * that `CreditLedgerService` appears in the `providers` array — via
 * `Reflect.getMetadata`. That is a different question. Adding a constructor
 * parameter whose provider is not visible to this module passes every one of
 * those assertions, passes `tsc`, passes every unit spec (which construct these
 * services positionally with `as any` mocks), and then fails on the first pod
 * that starts:
 *
 *     Nest can't resolve dependencies of the CreditLedgerService (…, ?).
 *
 * Inside `onModuleInit` — which is where `seedPlans()`/`seedEntitlements()` run
 * — that is a pod that never finishes booting, on every environment at once.
 *
 * This spec closes the gap without standing up a database: it reads the
 * `design:paramtypes` TypeScript emits for each service and checks every
 * parameter is something this module can actually supply. It is the same
 * question Nest asks, minus the instantiation, and it runs in milliseconds.
 *
 * Injection TOKENS (string/symbol `@Inject(...)`) and `@Optional()` parameters
 * are skipped deliberately: the first are not classes and carry no paramtype,
 * and the second are contractually allowed to be absent — the dispatch gate's
 * `RUN_PLAN_LIMITS` seam depends on exactly that.
 */
describe('SubscriptionsModule — constructor dependencies are resolvable', () => {
    const moduleProviders = (Reflect.getMetadata('providers', SubscriptionsModule) ??
        []) as unknown[];
    const moduleImports = (Reflect.getMetadata('imports', SubscriptionsModule) ?? []) as unknown[];

    /** `{ provide, useFactory }` entries answer to their token, not the literal. */
    const asToken = (provider: unknown) =>
        provider && typeof provider === 'object' && 'provide' in (provider as object)
            ? (provider as { provide: unknown }).provide
            : provider;

    /**
     * Everything this module can hand to a constructor: its own providers, plus
     * whatever every imported module EXPORTS.
     *
     * The import walk is not decoration - the first version of this spec omitted
     * it and immediately reported `RunCostSettlementService` as broken, because
     * `NotificationService` reaches it through `NotificationsModule` rather than
     * through DatabaseModule. A probe that cries wolf gets deleted, so it has to
     * model what Nest actually does.
     *
     * One level of re-export is followed (a module exporting another module),
     * which is how `DatabaseModule` republishes `TypeOrmModule`.
     */
    const collectExports = (mod: unknown, depth = 0): unknown[] => {
        if (typeof mod !== 'function' || depth > 2) return [];
        const exported = (Reflect.getMetadata('exports', mod) ?? []) as unknown[];
        return exported.flatMap((entry) => {
            const token = asToken(entry);
            const nested =
                typeof token === 'function' && Reflect.getMetadata('exports', token)
                    ? collectExports(token, depth + 1)
                    : [];
            return [token, ...nested];
        });
    };

    /**
     * The one thing this static probe genuinely cannot see.
     *
     * `PluginsModule` is `@Global()` AND dynamic: its exports are assembled inside
     * `forRoot()`/`forRootAsync()` and returned on a `DynamicModule` object, so
     * there is no static `exports` metadata to read and the private `EXPORTS`
     * array is not importable. Nest resolves it at runtime; nothing here can.
     *
     * So it is exempted BY CLASS, not by module — a module-level exemption would
     * wave through everything that module might ever export. Verified by hand:
     * `plugins.module.ts` carries `@Global()`, lists PluginSettingsService in its
     * providers (:85) and in the private EXPORTS array (:103) used by both
     * factories. `RunCostSettlementService` has taken it since long before this
     * change and boots fine in every environment.
     *
     * Keep this list at one entry if at all possible. Anything added here is a
     * dependency no test can check.
     */
    const DYNAMIC_GLOBAL_PROVIDERS: Array<[string, unknown]> = [
        ['PluginSettingsService', PluginSettingsService],
    ];

    const resolvable = new Set<unknown>([
        ...moduleProviders.map(asToken),
        ...moduleImports.flatMap((mod) => collectExports(mod)),
        ...DYNAMIC_GLOBAL_PROVIDERS.map(([, cls]) => cls),
        // Belt and braces: DatabaseModule re-exports the whole inventory, and
        // naming it directly keeps the spec honest if that module is restructured.
        ...REPOSITORY_PROVIDERS,
    ]);

    /**
     * Every service this module provides that has collaborators worth checking.
     * Listed explicitly rather than derived, so ADDING a service to the module
     * without adding it here is visible in review.
     */
    const SERVICES: Array<[string, new (...args: never[]) => unknown]> = [
        ['SubscriptionService', SubscriptionService],
        ['CreditLedgerService', CreditLedgerService],
        ['EntitlementsService', EntitlementsService],
        ['PlanRunLimitsService', PlanRunLimitsService],
        ['RunCostSettlementService', RunCostSettlementService],
        ['UsageSummaryService', UsageSummaryService],
        ['PlanSubscriptionService', PlanSubscriptionService],
        ['PaymentMethodService', PaymentMethodService],
        ['BillingService', BillingService],
        ['AutoRechargeService', AutoRechargeService],
        ['CostsSummaryService', CostsSummaryService],
    ];

    it.each(SERVICES)('%s can be constructed from this module', (name, Service) => {
        const paramTypes = (Reflect.getMetadata('design:paramtypes', Service) ?? []) as unknown[];
        // `@Inject(TOKEN)` params are recorded here, by parameter index.
        const injected = (Reflect.getMetadata('self:paramtypes', Service) ?? []) as Array<{
            index: number;
        }>;
        const optional = (Reflect.getMetadata('optional:paramtypes', Service) ?? []) as Array<{
            index: number;
        }>;
        const skip = new Set<number>([
            ...injected.map((i) => i.index),
            ...optional.map((o) => o.index),
        ]);

        const unresolvable = paramTypes
            .map((type, index) => ({ type, index }))
            .filter(({ index }) => !skip.has(index))
            .filter(({ type }) => typeof type === 'function')
            // Primitives carry Object/String/Number paramtypes; they are never
            // injected and would be `@Inject`ed if they were.
            .filter(({ type }) => ![Object, String, Number, Boolean, Array].includes(type as never))
            .filter(({ type }) => !resolvable.has(type))
            .map(
                ({ type, index }) => `#${index} ${(type as { name?: string }).name ?? 'anonymous'}`,
            );

        expect({ service: name, unresolvable }).toEqual({ service: name, unresolvable: [] });
    });

    it('the dynamic-global exemption list stays small and deliberate', () => {
        // Not a style rule. Every entry is a dependency this spec stops checking,
        // so growth here is the probe quietly losing its teeth.
        expect(DYNAMIC_GLOBAL_PROVIDERS.map(([name]) => name)).toEqual(['PluginSettingsService']);
    });

    it('the probe can actually fail — a class this module does not provide is caught', () => {
        // Without this control, a bug that made `resolvable` contain everything
        // (or `paramTypes` empty) would turn every assertion above green.
        class NotProvidedAnywhere {}
        expect(resolvable.has(NotProvidedAnywhere)).toBe(false);
    });

    it('imports DatabaseModule, which is what supplies the repositories', () => {
        const names = moduleImports.map((m) => (m as { name?: string })?.name).filter(Boolean);
        expect(names).toContain('DatabaseModule');
    });
});
