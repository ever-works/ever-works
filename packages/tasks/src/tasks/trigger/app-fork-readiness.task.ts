import { Module } from '@nestjs/common';
import { logger, task } from '@trigger.dev/sdk';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { TriggerInternalApiClient } from '../../trigger/worker/services/trigger-internal-api.client';
import { createRemoteProxy } from '../../trigger/worker/remote-proxy';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { getOptionalProvider } from '@ever-works/agent/utils';

/**
 * C10 — `app-fork-readiness` (APW-02 plan §6.2, `plan.md:664-670`).
 *
 * One dispatch of the job that turns a FORK REQUEST into a READY repository: it
 * stamps the attempt, pushes the private copy when the relation is `private-copy`
 * (FR-21), polls the Work Repository on FR-18's 2 / 4 / 8 / 15 s schedule until
 * its default branch has a commit (or the credential dies, or the deadline
 * passes), runs Actions hygiene for a fork or a copy (FR-22/FR-25) and calls the
 * setup hand-off once (FR-24a) — `AppForkReadinessService.run`'s work
 * (`@ever-works/agent`'s `app-works` barrel, T24), so this file is deliberately
 * thin: it registers the job id, resolves the runner world, and reports what the
 * run did.
 *
 * ## Why the run is resolved over the internal RPC channel
 *
 * The readiness poll WRITES the state row — `beginAttempt`, `probeReadiness`,
 * `recordCopyPushed`, `timeout`, `markReady` all go through
 * `AppUpstreamStateService`, which the API process owns beside the `DataSource`
 * (plan §2.4). A Trigger worker owns no `DataSource`, so a run started here would
 * have nothing to stamp the attempt on and nowhere to record the outcome.
 * It is therefore resolved as a **remote proxy**, exactly as APW-03's
 * `AppSpecService` and T19/T20's build runners are.
 *
 * The seam is `AppForkReadinessRunner`, not `AppForkReadinessService`, and that is
 * the one design point this job adds to its siblings': `run(payload, { sleep })`
 * takes a **function**, and `createRemoteProxy` serialises arguments with SuperJSON
 * (`remote-proxy.ts:93-96`), which has no transformer for a function. So the sleep
 * is supplied on the API side (a real timer) and the only thing that crosses the hop
 * is the payload. `apps/api`'s `AppWorksModule` provides both the service and that
 * runner; `TriggerInternalController`'s `remoteMap` publishes it under the name
 * below.
 *
 * 🛑 **The two registrations this file does not own — one of them C10's own gap.**
 *
 * 1. `apps/api/src/trigger/trigger-internal.controller.ts`'s `remoteMap` must expose
 *    `AppForkReadinessRunner` (and the API's `AppWorksModule` must be able to resolve
 *    it). It is the API side of this RPC pair; with it absent the proxy's call
 *    rejects with the named `Unknown remote target: AppForkReadinessRunner` and this
 *    run reports `status: 'failed'`, `reason: 'readinessFailed'` with the RPC's own
 *    message — visible, never a green run that readied nothing.
 * 2. `APP_FORK_READINESS_DISPATCHER` is what puts this job on the queue at all. C10
 *    measured it as **unbound anywhere**, so `AppWorkCreateService.dispatchReadiness`
 *    and `AppUpstreamStateService.retryReadiness` both logged "no readiness
 *    dispatcher is bound" and the row kept `readinessReason = 'dispatch_unavailable'`
 *    for the whole window. The dispatcher is now bound in the **agent**
 *    `AppWorksModule` (`buildAppForkReadinessDispatcherProvider`), because those two
 *    call sites are declared there — see that module's C10 section for the visibility
 *    rule that decides it.
 *
 * ## Budget — 1 200 s, and no retry
 *
 * `plan.md:666` fixes `maxDuration: 1_200` (20 minutes) against FR-18's 15-minute
 * deadline, so a run can never be killed by the platform while it is still inside
 * its own timeout. The plan names no retry shape for this job and none is added:
 * every ending this run has is already recorded on the row (`timed_out`,
 * `access_revoked`, `failed`) and re-entering the poll is what **Try again**
 * (FR-19) and APW-02's stale re-dispatch do deliberately. A task-level retry would
 * silently restart a fifteen-minute wait the member can already see and act on.
 *
 * ## The payload is the plan's, and T31 owns its eventual home
 *
 * `plan.md:655` fixes the payload (`{ workId, attempt, reason?, providerId?,
 * credentialVersion? }`) on `APP_FORK_READINESS_DISPATCHER`, whose token T23
 * declared provisionally in `app-upstream-state.service.ts` and which this job id
 * is registered beside. The interface below mirrors that shape field for field, and
 * `app-fork-readiness.task.spec.ts` pins the id and the seam name so this file and
 * the API's `remoteMap`/`AppForkReadinessRunner` cannot drift apart in silence.
 */

/** The task id — the same string `APP_FORK_READINESS_JOB_ID` names on the API side. */
export const APP_FORK_READINESS_TASK_ID = 'app-fork-readiness' as const;

/**
 * The payload of plan §6.1:655's `app-fork-readiness` row: **ids and a reason
 * only**, never a repository coordinate and never a credential.
 *
 * `attempt` is the readiness attempt the row is stamped with, and `reason` is the
 * plan's closed set — `initial` (the create path), `retry` (**Try again**, FR-19),
 * `redispatch` (APW-02's sweeper), `setup_merged` (FR-24a's follow-through). A
 * missing `reason` runs as `initial`; the service, not this file, decides what
 * each one skips.
 */
export interface AppForkReadinessTaskPayload {
    workId: string;
    attempt?: number;
    reason?: 'initial' | 'retry' | 'redispatch' | 'setup_merged';
    providerId?: string;
    credentialVersion?: number;
}

/** What one run reports — the shape every App Works job answers with. */
export interface AppForkReadinessTaskResult {
    /** `ran` — the runner answered. `skipped` — a gate refused. `failed` — it threw. */
    status: 'ran' | 'skipped' | 'failed';
    jobId: string;
    workId: string | null;
    /** The service's own outcome (`ready`, `timed_out`, `already_ready`, …), when it answered. */
    outcome: string | null;
    /** A named reason for anything that is not a plain run. */
    reason: string | null;
    error: string | null;
    /** The runner's own result, when it ran. */
    result: unknown;
}

/**
 * The runner seam this worker resolves, and the token it is provided under.
 *
 * A local token on purpose, exactly as T19's and T20's are: it lives in the
 * **worker's** container and is never compared with anything in the API (a
 * different process, a different graph), and the proxy is addressed by the
 * provider NAME the API's `remoteMap` uses.
 */
export const APP_FORK_READINESS_RUNNER_SEAM = Symbol('APP_FORK_READINESS_RUNNER_SEAM');

/** The one method this job calls on the runner. */
export interface AppForkReadinessRunnerSeam {
    run(payload: AppForkReadinessTaskPayload): Promise<unknown>;
}

/**
 * The narrowest worker composition that can host this job: the internal RPC
 * channel, plus the runner behind it.
 *
 * `TriggerInternalModule` is imported for `TriggerInternalApiClient` (its only
 * export this module needs) — not `TriggerWorkerModule`, whose graph a readiness
 * poll has no use for.
 */
@Module({
    imports: [TriggerInternalModule],
    providers: [
        {
            provide: APP_FORK_READINESS_RUNNER_SEAM,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppForkReadinessRunner'),
            inject: [TriggerInternalApiClient],
        },
    ],
})
export class AppForkReadinessWorkerModule {}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The run body, **exported** — not only registered, so a local worker can drain
 * *this* function and the dev path and the Trigger path cannot drift.
 */
export async function runAppForkReadinessTask(
    payload: AppForkReadinessTaskPayload,
): Promise<AppForkReadinessTaskResult> {
    const workId = typeof payload?.workId === 'string' ? payload.workId : null;
    const reason = typeof payload?.reason === 'string' ? payload.reason : null;

    if (!workId) {
        // A payload the dispatcher could not have sent. Named, never guessed at.
        return {
            status: 'skipped',
            jobId: APP_FORK_READINESS_TASK_ID,
            workId: null,
            outcome: null,
            reason: 'invalid_payload',
            error: null,
            result: null,
        };
    }

    return withWorkerContext(
        'AppForkReadiness',
        async (appContext): Promise<AppForkReadinessTaskResult> => {
            // `getOptionalProvider`, not `appContext.get`: the latter THROWS for an
            // absent provider, so the named refusal below could never be reached.
            const runner = getOptionalProvider<AppForkReadinessRunnerSeam>(
                appContext,
                APP_FORK_READINESS_RUNNER_SEAM,
            );
            if (!runner?.run) {
                logger.error(
                    'app-fork-readiness: the runner seam is not available in this worker context — ' +
                        'the Work was not readied.',
                    { workId, reason },
                );
                return {
                    status: 'skipped',
                    jobId: APP_FORK_READINESS_TASK_ID,
                    workId,
                    outcome: null,
                    reason: 'runnerUnavailable',
                    error: null,
                    result: null,
                };
            }

            try {
                const result = (await runner.run({
                    workId,
                    attempt: typeof payload.attempt === 'number' ? payload.attempt : 1,
                    ...(reason ? { reason: payload.reason } : {}),
                    ...(payload.providerId ? { providerId: payload.providerId } : {}),
                    ...(typeof payload.credentialVersion === 'number'
                        ? { credentialVersion: payload.credentialVersion }
                        : {}),
                })) as { outcome?: string; reason?: string } | null;

                logger.info('app-fork-readiness finished', { workId, reason });
                return {
                    status: 'ran',
                    jobId: APP_FORK_READINESS_TASK_ID,
                    workId,
                    // The service's own answer, reported rather than reinterpreted: a
                    // `timed_out` or a `failed` attempt that reached the row IS this job
                    // completing (FR-18/FR-20's endings are outcomes, not job failures).
                    outcome: typeof result?.outcome === 'string' ? result.outcome : null,
                    reason: typeof result?.reason === 'string' ? result.reason : null,
                    error: null,
                    result,
                };
            } catch (error) {
                // The RPC rejected (the API's `remoteMap` has no
                // `AppForkReadinessRunner`, or the API restarted mid-poll), or the
                // service threw. Both are reported; neither is hidden.
                const failure = errorText(error);
                logger.error(`app-fork-readiness: work ${workId} failed — ${failure}`, {
                    workId,
                    reason,
                });
                return {
                    status: 'failed',
                    jobId: APP_FORK_READINESS_TASK_ID,
                    workId,
                    outcome: null,
                    reason: 'readinessFailed',
                    error: failure,
                    result: null,
                };
            }
        },
        AppForkReadinessWorkerModule,
    );
}

export const appForkReadinessTask = task<'app-fork-readiness', AppForkReadinessTaskPayload>({
    id: APP_FORK_READINESS_TASK_ID,
    // §6.2:666 — twenty minutes, against FR-18's fifteen-minute deadline. See the
    // file header for why no retry is declared beside it.
    maxDuration: 1_200,
    run: runAppForkReadinessTask,
});
