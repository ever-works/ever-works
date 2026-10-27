import { Global, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    APPS_TIER_ELIGIBILITY_SOURCE,
    APPS_TIER_PLAN_READER,
    APPS_TIER_POLICY,
    AppRuntimeStateModule,
    AppsTierEligibilityService,
    ConfigAppsTierPolicy,
    type AppsTierEligibilitySource,
    type AppsTierPlanReader,
} from '@ever-works/agent/app-runtime';
import { SubscriptionService } from '@ever-works/agent/subscriptions';
import { getOptionalProvider } from '@ever-works/agent/utils';

/**
 * APW-10 lite — `APPS_TIER_POLICY` for the API process.
 *
 * Five API consumers inject the token `@Optional()` — the deploy preconditions, the App source
 * inspector, the create path, the launcher and the runtime facade — and until this module NOTHING
 * in the API bound it, so every one of them read "closed" whatever the operator set. The isolated
 * App runtime worker binds its own `ConfigAppsTierPolicy` (`trigger-app-runtime.module.ts`); this is
 * the API's twin, so both processes answer `isOpen()` from the same `EVER_WORKS_APPS_MANAGED_ENABLED`.
 *
 * Safe in the API: `ConfigAppsTierPolicy.resolveClusterCredential` refuses outside the isolated
 * worker BEFORE it reads `EVER_WORKS_APPS_MANAGED_KUBECONFIG`, so the API never holds the managed
 * cluster's credential (and the runtime facade refuses every cluster call in the API anyway).
 *
 * `@Global()` for the same reason `AppWorksTelemetryBindingModule` is: the consumers live in five
 * modules of two packages, and one global binding reaches all of them without an import edge that
 * could close a cycle.
 *
 * ## Eligibility (lane aw-safety, 2026-10-26 — APW-10 T27, APW-06 T45)
 *
 * The policy now reads `AppsTierEligibilityService` once the tier is open: a verified email, the
 * per-owner cap `EVER_WORKS_APPS_MAX_PER_USER` (default 3) over the owner's App Works that occupy
 * the tier, and — behind `EVER_WORKS_APPS_MANAGED_REQUIRE_PAID_PLAN` (default off) — a paid plan.
 * Before this, an open tier answered "eligible" for every account and the cap had no caller.
 *
 * Owner decision 2026-10-27: that cap binds an owner on an UNPAID plan only; a paid owner is held
 * to `EVER_WORKS_APPS_MAX_PER_PAID_USER` (unset = no limit). The plan comes from the same lazy
 * `APPS_TIER_PLAN_READER` below, and a plan that cannot be read keeps the unpaid cap.
 *
 * The service is provided and exported HERE (global), so `AppDeployRequestModule`'s own policy
 * binding and `TriggerInternalController`'s `AppsTierEligibilityService` remote target (the worker's
 * re-check) reach the one instance. The plan read is lazy (`SubscriptionService` through
 * `ModuleRef`), so this module adds no import edge to the subscriptions graph.
 */
@Global()
@Module({
    imports: [DatabaseModule, AppRuntimeStateModule],
    providers: [
        {
            provide: APPS_TIER_PLAN_READER,
            useFactory: (moduleRef: ModuleRef): AppsTierPlanReader => {
                const subscriptions = (): SubscriptionService => {
                    const service = getOptionalProvider<SubscriptionService>(
                        moduleRef,
                        SubscriptionService,
                    );
                    if (!service) {
                        throw new Error('SubscriptionService is not in this container.');
                    }
                    return service;
                };
                return {
                    isEnabled: () => subscriptions().isEnabled(),
                    resolvePlanForUser: (user: unknown) =>
                        subscriptions().resolvePlanForUser(user as never) as Promise<{
                            code?: string | null;
                        } | null>,
                };
            },
            inject: [ModuleRef],
        },
        AppsTierEligibilityService,
        { provide: APPS_TIER_ELIGIBILITY_SOURCE, useExisting: AppsTierEligibilityService },
        {
            provide: APPS_TIER_POLICY,
            // `null`, never `undefined`, when the source is missing: the policy then FAILS CLOSED.
            useFactory: (source?: AppsTierEligibilitySource) =>
                new ConfigAppsTierPolicy(process.env, source ?? null),
            inject: [{ token: APPS_TIER_ELIGIBILITY_SOURCE, optional: true }],
        },
    ],
    exports: [APPS_TIER_POLICY, APPS_TIER_ELIGIBILITY_SOURCE, AppsTierEligibilityService],
})
export class AppsTierPolicyBindingModule {}
