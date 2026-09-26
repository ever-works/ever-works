import type { AppBuildPreparePayload } from './app-build-prepare.types';

/**
 * APW-05 T18 — the `app-build-prepare` dispatcher, modelled on
 * `work-import-dispatcher.ts` and **not** on the throwing `kb-reembed-work-dispatcher.ts`
 * (`APW05-G20`, plan §7.1:1317-1319).
 *
 * `AppBuildsService.dispatchPrepare` calls this port first. A `null` return means "no
 * runtime took it", and that is a documented, working path rather than a failure: the
 * service runs `AppBuildPrepareRunner.run(payload)` **in process**, unawaited, under the
 * same `app-build-prepare:<workId>` lock (§7.1:1321-1331). Two things follow, and both are
 * why this port must never throw:
 *
 *   - the local e2e stack — where Trigger.dev is not configured at all — still prepares
 *     repositories, so an unconfigured installation is a fallback and not an outage;
 *   - Rebuild's 2-second budget (FR-41) is the caller's, not the dispatcher's, and a
 *     throw here would turn a deferral the caller already handles into a 500.
 *
 * It is bound through `buildJobRuntimeProviders()` like every other `*_DISPATCHER` symbol
 * (`job-runtime.providers.ts`), which returns `null` when no provider is registered.
 *
 * 🛑 **Token identity (routed as a finding).** T17 declared a provisional
 * `APP_BUILD_PREPARE_DISPATCHER = Symbol('APP_BUILD_PREPARE_DISPATCHER')` of its own
 * (`packages/agent/src/app-builds/app-builds.service.ts:133`) and injects it there. Two
 * `Symbol()`s with the same description are two different tokens, so that injection is
 * only reachable once its provisional block is swapped for an import of THIS file — the
 * swap is mandatory and lives in a file T18 does not own.
 */
export interface AppBuildPrepareDispatcher {
    /**
     * Dispatches an app build prepare task.
     * @returns The trigger run ID if successful, or null if failed/not triggered — in
     *   which case the caller runs the prepare runner in process (§7.1).
     */
    dispatchAppBuildPrepare(payload: AppBuildPreparePayload): Promise<string | null>;
}

export const APP_BUILD_PREPARE_DISPATCHER = Symbol('APP_BUILD_PREPARE_DISPATCHER');
