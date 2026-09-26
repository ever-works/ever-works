import { logger, schedules } from '@trigger.dev/sdk';
import { CACHE_MANAGER } from '@ever-works/agent/cache';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { getOptionalProvider } from '@ever-works/agent/utils';
import { AppHealthService, type AppHealthPollSummary } from '@ever-works/agent/app-runtime';
import {
    APP_RUNTIME_TASK_QUEUE,
    TriggerAppRuntimeModule,
} from '../../trigger/worker/modules/trigger-app-runtime.module';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * APW-06 T32 (`tasks.md:556-573`) — **`app-health-poll`**, the every-minute health tick
 * (plan §9.2:1248, §9.3).
 *
 * ## The schedule
 *
 * `* * * * *` — §9.2's cron, and the reason it is a minute rather than an hour is §9.3's streak
 * rule: `down` is concluded after four consecutive failing polls, so the tick's period *is* the
 * detection latency. A missed minute costs a minute, which is why the tick is guarded rather than
 * serialised: the next one picks up whatever this one skipped.
 *
 * ## The guard — and what a remote lock can and cannot do here
 *
 * §9.2: "self-guarded by `DistributedTaskLockService`". In this worker that service is a
 * **remote proxy** (§6.4:985 — it injects `@InjectRepository(CacheEntry)` non-optionally, so it
 * cannot be constructed without a `DataSource`), and a callback cannot cross the SuperJSON hop:
 * `runExclusive(key, fn)` would arrive API-side with `fn` serialized away. That is the same
 * limitation `APP_UPSTREAM_STATE_SERVICE` was created for (`trigger-internal.module.ts:69-73`
 * spells it out), and it is why the guard here is the half the hop *can* carry —
 * `isLocked(key)` — with the atomic claim owned by whatever takes it (`AppHealthService`, T27,
 * takes the per-Work claims; a second replica's tick sees the first one's lock and returns).
 *
 * The check is therefore deliberately fail-**soft** on a *held* lock (skip, and the next minute has
 * it) and fail-**closed** on an unreachable lock service: a tick that cannot tell whether another
 * replica is already sweeping returns `lock_unavailable` and polls nothing, because a second
 * concurrent sweep would double the streak counters that decide a notification.
 *
 * ## The cache sweep
 *
 * §9.2: "The tick also calls the cache adapter's `cleanExpired()`, so a cached log tail never
 * outlives 5 min + 60 s." The adapter is `TypeORMKeyvAdapter` (`@ever-works/agent/cache`), reached
 * through `CACHE_MANAGER`. The call is attempted and its outcome **reported** (`swept` /
 * `unavailable` with the API's own message): the API-side name is registered either way, so the
 * sweep starts working the moment that method is part of the published surface, and a rejection is
 * a visible warning rather than a silent no-op.
 *
 * ## The sweep itself — T27's service, which landed with T70
 *
 * §9.3's health service is `packages/agent/src/app-runtime/app-health.service.ts`, APW-06 **T27**.
 * This tick does not re-implement it (that would be a rival service T27 then has to reconcile): it
 * resolves `AppHealthService` from the worker context and calls `poll()`, reporting the summary the
 * sweep answered with. `health_service_unavailable` — naming that path — remains for the one case
 * that still deserves it: a context that boots without the service. **`T17` is the reason a sweep is
 * still usually short**: the runtime-state repository has not landed, so `poll()` answers
 * `health_store_unavailable` and this tick reports that verbatim rather than a zero-work "ran".
 */

/** The task id — exported so the local worker and the specs never copy the string. */
export const APP_HEALTH_POLL_TASK_ID = 'app-health-poll' as const;

/** §9.2's cron. One minute — the tick's period is the detection latency (§9.3's four-poll streak). */
export const APP_HEALTH_POLL_CRON = '* * * * *' as const;

/** §9.2's registration budget: a tick that has not finished in fifteen minutes has missed fourteen. */
export const APP_HEALTH_POLL_MAX_DURATION_SECONDS = 900 as const;

/**
 * The distributed lock key. Deliberately **not** per-Work: it is the *tick* that must not run
 * twice, and `DistributedTaskLockService.buildKey` namespaces it (`task-lock:` prefix).
 */
export const APP_HEALTH_POLL_LOCK_KEY = 'app-health-poll' as const;

/** The file T27 landed; named for the one case that still points at it — a context without it. */
export const APP_HEALTH_SERVICE_PATH =
    'packages/agent/src/app-runtime/app-health.service.ts' as const;

/** What the cache sweep did, when it ran. */
export interface AppHealthPollCacheSweep {
    /** `swept` — the adapter's own answer. `unavailable` — the call was refused; `message` says why. */
    status: 'swept' | 'unavailable';
    expired: number | null;
    message: string | null;
}

/** What one tick reports. */
export interface AppHealthPollTaskResult {
    status: 'ran' | 'skipped';
    jobId: string;
    /** `held` — another replica is polling; `free` — this tick owns the minute. */
    lockGuard: 'held' | 'free' | 'unavailable';
    cacheSweep: AppHealthPollCacheSweep | null;
    /** A named reason for anything that is not a plain sweep. */
    reason: string | null;
    /** The owner file a refusal is waiting on, when the refusal is a missing delegation. */
    missing: string | null;
    error: string | null;
    /**
     * §9.3's own summary, verbatim: what the sweep selected, polled, skipped, notified and
     * concluded. `null` only when no service was resolvable — a sweep that could not run (T17's
     * store is still unbound) answers `ok: false` with a `reason` here instead of a null.
     */
    health: AppHealthPollSummary | null;
}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The run body, exported — the local worker drains *this* function (see `app-deploy.task.ts`). */
export async function runAppHealthPollTask(): Promise<AppHealthPollTaskResult> {
    return withWorkerContext(
        'AppHealthPoll',
        async (appContext): Promise<AppHealthPollTaskResult> => {
            // ---- the guard ---------------------------------------------------------------
            // `getOptionalProvider`: `appContext.get` THROWS for an absent provider,
            // which made the warning below unreachable.
            const locks = getOptionalProvider<DistributedTaskLockService>(
                appContext,
                DistributedTaskLockService,
            );
            if (!locks?.isLocked) {
                logger.warn(
                    'app-health-poll: DistributedTaskLockService is not bound in this worker ' +
                        'context, so the tick cannot tell whether another replica is already ' +
                        'polling. Nothing was polled.',
                );
                return {
                    status: 'skipped',
                    jobId: APP_HEALTH_POLL_TASK_ID,
                    lockGuard: 'unavailable',
                    cacheSweep: null,
                    reason: 'lock_service_unavailable',
                    missing: null,
                    error: null,
                    health: null,
                };
            }

            let held: boolean;
            try {
                held = (await locks.isLocked(APP_HEALTH_POLL_LOCK_KEY)) === true;
            } catch (error) {
                return {
                    status: 'skipped',
                    jobId: APP_HEALTH_POLL_TASK_ID,
                    lockGuard: 'unavailable',
                    cacheSweep: null,
                    reason: 'lock_service_unavailable',
                    missing: null,
                    error: errorText(error),
                    health: null,
                };
            }

            if (held) {
                // T32's own case: a tick that finds the lock held exits without polling.
                return {
                    status: 'skipped',
                    jobId: APP_HEALTH_POLL_TASK_ID,
                    lockGuard: 'held',
                    cacheSweep: null,
                    reason: 'lock_held',
                    missing: null,
                    error: null,
                    health: null,
                };
            }

            // ---- the cache sweep (§9.2: "the tick also calls the cache adapter's cleanExpired()")
            const cacheSweep = await sweepExpiredCacheEntries(appContext);

            // ---- the sweep itself (T27) ---------------------------------------------------
            // `getOptionalProvider`, not `appContext.get`: the latter THROWS for an
            // absent provider, so the named error below could never be reached.
            const health = getOptionalProvider<AppHealthService>(appContext, AppHealthService);

            if (!health?.poll) {
                logger.error(
                    `app-health-poll: AppHealthService (plan §9.3) is not resolvable from this ` +
                        `worker context — ${APP_HEALTH_SERVICE_PATH} is APW-06 T27's file and it ` +
                        'is a provider of TriggerAppRuntimeModule, so this context is not the one ' +
                        'the module builds. No App Work was polled and nothing was dialled.',
                );

                return {
                    status: 'skipped',
                    jobId: APP_HEALTH_POLL_TASK_ID,
                    lockGuard: 'free',
                    cacheSweep,
                    reason: 'health_service_unavailable',
                    missing: APP_HEALTH_SERVICE_PATH,
                    error: null,
                    health: null,
                };
            }

            let summary: AppHealthPollSummary;
            try {
                summary = await health.poll();
            } catch (error) {
                // §9.3's service resolves for every refusal it can name, so a throw here means the
                // sweep died around it — reported, never reported as a poll that happened.
                const message = errorText(error);
                logger.error(`app-health-poll: the health sweep threw — ${message}`);

                return {
                    status: 'skipped',
                    jobId: APP_HEALTH_POLL_TASK_ID,
                    lockGuard: 'free',
                    cacheSweep,
                    reason: 'health_sweep_failed',
                    missing: null,
                    error: message,
                    health: null,
                };
            }

            if (summary?.ok === false) {
                // The sweep could not run — T17's store is unbound today, which is the usual
                // reason. Named, with its own code, rather than a zero-work "ran".
                logger.warn(
                    `app-health-poll: the health sweep could not run (${summary?.reason ?? 'unknown'}).`,
                );

                return {
                    status: 'skipped',
                    jobId: APP_HEALTH_POLL_TASK_ID,
                    lockGuard: 'free',
                    cacheSweep,
                    reason: summary?.reason ?? 'health_sweep_unavailable',
                    missing: null,
                    error: null,
                    health: summary,
                };
            }

            logger.info('app-health-poll finished', {
                selected: summary?.selected ?? 0,
                polled: summary?.polled ?? 0,
                skipped: summary?.skipped ?? 0,
                notifications: summary?.notifications ?? 0,
                verdicts: summary?.verdicts ?? null,
            });

            return {
                status: 'ran',
                jobId: APP_HEALTH_POLL_TASK_ID,
                lockGuard: 'free',
                cacheSweep,
                reason: null,
                missing: null,
                error: null,
                health: summary,
            };
        },
        TriggerAppRuntimeModule,
    );
}

/**
 * `cleanExpired()` through the `CACHE_MANAGER` proxy. Never throws: the tick's real work must not
 * be lost to a cache-sweep refusal, and an operator needs the API's own message to fix it.
 */
async function sweepExpiredCacheEntries(appContext: {
    get: (token: unknown, options?: { strict?: boolean }) => unknown;
}): Promise<AppHealthPollCacheSweep> {
    try {
        const cache = appContext.get(CACHE_MANAGER, { strict: false }) as
            | { cleanExpired?: () => Promise<number> }
            | undefined;

        if (typeof cache?.cleanExpired !== 'function') {
            return {
                status: 'unavailable',
                expired: null,
                message: 'CACHE_MANAGER does not expose cleanExpired()',
            };
        }

        const expired = await cache.cleanExpired();

        return {
            status: 'swept',
            expired: typeof expired === 'number' ? expired : null,
            message: null,
        };
    } catch (error) {
        const message = errorText(error);
        logger.warn(
            `app-health-poll: the cache sweep was refused, so an expired log tail may outlive ` +
                `5 min + 60 s until it is fixed — ${message}`,
        );
        return { status: 'unavailable', expired: null, message };
    }
}

export const appHealthPollTask = schedules.task({
    id: APP_HEALTH_POLL_TASK_ID,
    cron: APP_HEALTH_POLL_CRON,
    maxDuration: APP_HEALTH_POLL_MAX_DURATION_SECONDS,
    // One attempt: the next tick is one minute away, and a retry would race it.
    retry: { maxAttempts: 1 },
    queue: APP_RUNTIME_TASK_QUEUE,
    run: runAppHealthPollTask,
});
