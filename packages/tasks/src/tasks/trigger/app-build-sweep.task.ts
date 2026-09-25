import { Module } from '@nestjs/common';
import { logger, schedules } from '@trigger.dev/sdk';
import { APP_BUILD_SWEEP_CRON } from '@ever-works/contracts';
import { getOptionalProvider } from '@ever-works/agent/utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { TriggerInternalApiClient } from '../../trigger/worker/services/trigger-internal-api.client';
import { createRemoteProxy } from '../../trigger/worker/remote-proxy';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * APW-05 T21 (first slice) — `app-build-sweep` (plan §7.4), every two minutes.
 *
 * One tick of the Builds sweep. Every pass is `AppBuildSweepService.runSweep`'s
 * (`@ever-works/agent`'s `app-builds` barrel): the re-drive of a requested Build
 * nothing dispatched (§9.2 — a failed prepare otherwise leaves it `queued`
 * forever) and the never-adopted half of §7.4's `lost` rule. The remaining T21
 * passes land in that service, not here, so this file stays a registration.
 *
 * ## Why the service is resolved over the internal RPC channel
 *
 * The passes read and write `work_builds`, take `DistributedTaskLockService`'s
 * `app-builds:sweep` row, and finalise a lost Build through
 * `AppBuildsService.finalize`, which writes the Activity row and emits
 * `app.build.failed`. A Trigger worker owns **no `DataSource`**
 * (`app-build-prepare.task.ts` states the same rule), so the service is a
 * **remote proxy** over the internal channel, and the LOCK is taken API-side
 * inside `runSweep` — `runExclusive` takes a callback, which cannot cross the
 * hop (the `workspace-backup-sweeper` precedent). Overlapping ticks are
 * therefore harmless: the second one answers `skipped: locked`.
 *
 * 🛑 **The registration this file does not own.**
 * `apps/api/src/trigger/trigger-internal.controller.ts`'s `remoteMap` publishes
 * `AppBuildSweepService`. Were it missing, the proxy's call would reject and
 * this tick report `status: 'failed'` with the RPC's own message.
 *
 * ## On runtimes other than Trigger.dev
 *
 * This is the Trigger.dev registration. When Trigger.dev is not the configured
 * runtime, `AppBuildSweepCronService` (`apps/api/src/app-builds/`) runs the same
 * `runSweep()` from the API on the same `APP_BUILD_SWEEP_CRON`, gated on
 * `!config.trigger.shouldUseTrigger()`, so exactly one of the two runs the pass.
 *
 * ## Budget — one tick; failures are REPORTED, not retried
 *
 * `maxDuration` is 120 s, one tick. The worker's real bound is shorter — the
 * RPC's non-retried 45 s deadline — and the API-side pass keeps going after it
 * under its own lock, so a long tick can show as failed here while the pass
 * finishes; that is harmless because every pass is idempotent. A rejection is
 * RETURNED as `status: 'failed'`, never rethrown: the next tick, two minutes
 * later, is the retry.
 */

/** The task id — exported so the specs never copy the string. */
export const APP_BUILD_SWEEP_TASK_ID = 'app-build-sweep' as const;

/**
 * The schedule: the contracts constant the API's cron fallback reads too, so
 * the two can never drift (plan §7.4:1412-1413). `app-build-sweep.task.spec.ts`
 * pins it.
 */
export const APP_BUILD_SWEEP_TASK_CRON = APP_BUILD_SWEEP_CRON;

/**
 * The service seam this worker resolves, and the token it is provided under.
 *
 * A local token on purpose, exactly as `APP_BUILD_PREPARE_RUNNER_SEAM` is: it
 * lives in the **worker's** container, and the proxy is addressed by the
 * provider NAME the API's `remoteMap` uses.
 */
export const APP_BUILD_SWEEP_SEAM = Symbol('APP_BUILD_SWEEP_SEAM');

/** The one method this task calls. The API reads its own clock. */
export interface AppBuildSweepSeam {
    runSweep(): Promise<unknown>;
}

/** What one tick reports. */
export interface AppBuildSweepTaskResult {
    /** `swept` — the passes ran. `skipped` — the service ran none (named). `failed` — the call failed. */
    status: 'swept' | 'skipped' | 'failed';
    jobId: string;
    /** A named reason for anything that is not a plain tick. */
    reason: string | null;
    error: string | null;
    /** The service's own counters, when it answered with them. */
    summary: Record<string, unknown> | null;
}

/**
 * The narrowest worker composition that can host this task: the internal RPC
 * channel, plus the service behind it.
 */
@Module({
    imports: [TriggerInternalModule],
    providers: [
        {
            provide: APP_BUILD_SWEEP_SEAM,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppBuildSweepService'),
            inject: [TriggerInternalApiClient],
        },
    ],
})
export class AppBuildSweepWorkerModule {}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The service's summary, read defensively off the wire. A summary carries
 * `skipped` — `null` for a tick that ran, a string naming why it did not.
 * Anything else fails closed: a green tick nobody can read is the silent no-op
 * this programme forbids.
 */
function sweepOutcome(
    answer: unknown,
): Pick<AppBuildSweepTaskResult, 'status' | 'reason' | 'error' | 'summary'> {
    const value = answer as { skipped?: unknown } | null;
    if (value && typeof value === 'object' && 'skipped' in value) {
        const summary = value as Record<string, unknown>;
        if (value.skipped === null) {
            return { status: 'swept', reason: null, error: null, summary };
        }
        if (typeof value.skipped === 'string' && value.skipped.length > 0) {
            return { status: 'skipped', reason: value.skipped, error: null, summary };
        }
    }
    return {
        status: 'failed',
        reason: 'unrecognisedSweepResult',
        error: 'the sweep answered without a recognised summary',
        summary: null,
    };
}

/** The run body, exported — so a local worker and the specs drive this function. */
export async function runAppBuildSweepTask(): Promise<AppBuildSweepTaskResult> {
    return withWorkerContext(
        'AppBuildSweep',
        async (appContext): Promise<AppBuildSweepTaskResult> => {
            // `getOptionalProvider`, not `appContext.get`: the latter THROWS for an
            // absent provider, so the named refusal below could never be reached.
            const seam = getOptionalProvider<AppBuildSweepSeam>(appContext, APP_BUILD_SWEEP_SEAM);
            if (!seam?.runSweep) {
                logger.error(
                    'app-build-sweep: the sweep seam is not available in this worker context — nothing was swept.',
                );
                return {
                    status: 'skipped',
                    jobId: APP_BUILD_SWEEP_TASK_ID,
                    reason: 'runnerUnavailable',
                    error: null,
                    summary: null,
                };
            }

            try {
                const outcome = sweepOutcome(await seam.runSweep());
                // Counters only — the summary carries nothing else.
                const log =
                    outcome.status === 'swept'
                        ? logger.info
                        : outcome.status === 'skipped'
                          ? logger.warn
                          : logger.error;
                log('app-build-sweep finished', {
                    status: outcome.status,
                    ...(outcome.reason ? { reason: outcome.reason } : {}),
                    ...(outcome.error ? { error: outcome.error } : {}),
                    ...(outcome.summary ?? {}),
                });
                return { jobId: APP_BUILD_SWEEP_TASK_ID, ...outcome };
            } catch (error) {
                // The RPC rejected (a missing registration, the 45 s deadline, the
                // API down). Reported, never rethrown: the next tick is the retry.
                const failure = errorText(error);
                logger.error(`app-build-sweep: the tick failed — ${failure}`);
                return {
                    status: 'failed',
                    jobId: APP_BUILD_SWEEP_TASK_ID,
                    reason: 'sweepFailed',
                    error: failure,
                    summary: null,
                };
            }
        },
        AppBuildSweepWorkerModule,
    );
}

export const appBuildSweepTask = schedules.task({
    id: APP_BUILD_SWEEP_TASK_ID,
    cron: APP_BUILD_SWEEP_TASK_CRON,
    // One tick. See the header's "Budget".
    maxDuration: 120,
    run: async () => runAppBuildSweepTask(),
});
