import type { AppBuildWatchPayload } from './app-build-watch.types';

/**
 * APW-05 T18 — the `app-build-watch` dispatcher, modelled on `work-import-dispatcher.ts`
 * and **not** on the throwing `kb-reembed-work-dispatcher.ts` (`APW05-G20`, plan
 * §7.1:1317-1319).
 *
 * `AppBuildsService.dispatchWatch` calls this port first. A `null` return means "no runtime
 * took it": the service runs `AppBuildWatchRunner.run(payload)` **in process**, unawaited,
 * capped at 10 concurrent in-process runs per API process (§7.1:1321-1331) — the excess is
 * left to §7.4's two-minute sweep, which already covers every silent non-terminal Build. A
 * throw here would instead surface inside the webhook handler that dispatched the
 * observation, which is the one place an observation must never be able to fail a delivery
 * ack.
 *
 * `watchLeaseUntil` — not this port — is what makes an in-process run and a dispatched one
 * mutually exclusive (§7.3:1386-1388), so a duplicated or late dispatch is harmless.
 *
 * It is bound through `buildJobRuntimeProviders()` like every other `*_DISPATCHER` symbol
 * (`job-runtime.providers.ts`), which returns `null` when no provider is registered.
 *
 * 🛑 **Token identity (routed as a finding).** T17 declared a provisional
 * `APP_BUILD_WATCH_DISPATCHER = Symbol('APP_BUILD_WATCH_DISPATCHER')` of its own
 * (`packages/agent/src/app-builds/app-builds.service.ts:141`) and injects it there. Two
 * `Symbol()`s with the same description are two different tokens, so that injection is only
 * reachable once its provisional block is swapped for an import of THIS file — the swap is
 * mandatory and lives in a file T18 does not own.
 */
export interface AppBuildWatchDispatcher {
    /**
     * Dispatches an app build watch task.
     * @returns The trigger run ID if successful, or null if failed/not triggered — in
     *   which case the caller runs the watch runner in process (§7.1).
     */
    dispatchAppBuildWatch(payload: AppBuildWatchPayload): Promise<string | null>;
}

export const APP_BUILD_WATCH_DISPATCHER = Symbol('APP_BUILD_WATCH_DISPATCHER');
