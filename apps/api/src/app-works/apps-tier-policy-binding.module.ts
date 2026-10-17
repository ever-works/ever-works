import { Global, Module } from '@nestjs/common';
import { APPS_TIER_POLICY, ConfigAppsTierPolicy } from '@ever-works/agent/app-runtime';

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
 */
@Global()
@Module({
    providers: [{ provide: APPS_TIER_POLICY, useFactory: () => new ConfigAppsTierPolicy() }],
    exports: [APPS_TIER_POLICY],
})
export class AppsTierPolicyBindingModule {}
