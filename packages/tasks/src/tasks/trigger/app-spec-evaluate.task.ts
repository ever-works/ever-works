import { Module } from '@nestjs/common';
import { logger, task } from '@trigger.dev/sdk';
import { AppSpecService } from '@ever-works/agent/app-spec';
import {
    APP_SPEC_EVALUATE_JOB_ID,
    runAppSpecEvaluateJob,
    type AppSpecEvaluatePayload,
} from '@ever-works/agent/tasks';
import { TriggerWorkerModule } from '../../trigger/worker/modules/trigger-worker.module';
import { TriggerInternalApiClient } from '../../trigger/worker/services/trigger-internal-api.client';
import { createRemoteProxy } from '../../trigger/worker/remote-proxy';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * APW-03 T13 — `app-spec-evaluate` (plan §6.1:650-662, tasks.md:307-320).
 *
 * One full evaluation of one App Work's App spec: claim the per-Work lock, read
 * the tracked branch's head and `.works/works.yml`, validate, write under
 * `evaluatedSeq < :seq`, record Activity on a head-hash change and emit
 * `AppSpecAppliedEvent` on an effective-hash change. Every one of those steps is
 * `AppSpecService.evaluate`'s work, so this file is deliberately thin: it
 * registers the job id, delegates to the runtime-neutral handler
 * (`runAppSpecEvaluateJob`, `packages/agent/src/tasks/app-works-jobs.ts`) and
 * reports what the run did.
 *
 * ## Budget — 60 s, retries 2 (plan §6.1:650)
 *
 * An evaluation is one `getLatestCommit`, one `getFileContent` and one guarded
 * UPDATE. Sixty seconds is generous for that and small enough that a run which
 * has not finished is already lost; two retries cover a provider blip, and each
 * retry is a no-op when the first one's write landed (the guard and the
 * effective-hash comparison make the job idempotent by construction).
 *
 * ## Why this runs in the API process, and why the proxy is the only composition here
 *
 * FR-90: "the evaluation, its database writes and its in-process events MUST
 * happen in the API process, so the events other epics listen for are actually
 * delivered". A Trigger worker has no `DataSource` (APW-06 plan §6.4:966-991's
 * rule) and no `EventEmitter2` the API's listeners are subscribed to, so
 * evaluating inside the worker could not publish `app.spec.applied` to APW-05,
 * 06, 07 or 08 — it would write rows and tell nobody. `AppSpecService` is
 * therefore provided here as a **remote proxy** over the internal RPC channel,
 * the same shape `TriggerInternalModule` uses for `TasksService`,
 * `TaskWorkspaceService` and AW-20's `RosterProvisioningService`.
 *
 * 🛑 **The two API-side registrations this task does not own — both LANDED** (they
 * were routed to the APW-02 T27/T28 owner, who added them):
 *
 * 1. `apps/api/src/trigger/trigger-internal.controller.ts` exposes
 *    `AppSpecService` in its `remoteMap` (with `evaluate`) and
 *    `apps/api/src/trigger/trigger-internal.module.ts` provides it — the
 *    "service's registration for remote calls" half of FR-90. With it unbound the
 *    proxy's call would reject and this run would report `evaluationFailed` with
 *    the RPC's own message: a named, visible failure, never a green run that
 *    evaluated nothing.
 * 2. The API-side module wiring (`apps/api/src/works/works.module.ts` importing
 *    `AppSpecModule`) is T15's task; this file neither needs nor touches it.
 *
 * With no job runtime registered at all, `AppSpecService.requestEvaluation`
 * answers a `null` dispatch by running this same handler in-process
 * (plan §6.1:661-662) — which is the path the API takes today, and the reason
 * this task's existence does not gate the epic.
 */

/**
 * The narrowest worker composition that can host this job: the standard worker
 * graph, plus the one thing the job resolves.
 *
 * `AppSpecService` is bound to a remote proxy rather than to the class, exactly
 * as `TriggerInternalModule` does for the API-side services it consumes
 * (`TaskWorkspaceService`, `FleetJobService`, `RosterProvisioningService`, …):
 * the worker only needs the RPC handle, and a worker that imported the class
 * would still have no `WorkAppSpecStateRepository` to construct it with.
 */
@Module({
    imports: [TriggerWorkerModule],
    providers: [
        {
            provide: AppSpecService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppSpecService'),
            inject: [TriggerInternalApiClient],
        },
    ],
})
class AppSpecEvaluateWorkerModule {}

/**
 * What one run reports. `status` is the discriminant every other App Works job
 * uses (`skipped` · `evaluated` · `failed`), so a run log can be filtered the
 * same way across the epic.
 */
export interface AppSpecEvaluateTaskResult {
    readonly status: 'evaluated' | 'skipped' | 'failed';
    readonly jobId: string;
    readonly workId: string | null;
    readonly trigger: string | null;
    /** The service's own outcome, when it ran. */
    readonly evaluation: unknown;
    /** A named reason for anything that is not a plain evaluation. */
    readonly reason: string | null;
    readonly error: string | null;
}

export const appSpecEvaluateTask = task<'app-spec-evaluate', AppSpecEvaluatePayload>({
    id: APP_SPEC_EVALUATE_JOB_ID,
    // Plan §6.1:650 — 60 s, retries 2.
    maxDuration: 60,
    retry: { maxAttempts: 2 },
    run: async (payload): Promise<AppSpecEvaluateTaskResult> =>
        withWorkerContext(
            'AppSpecEvaluate',
            async (appContext): Promise<AppSpecEvaluateTaskResult> => {
                const workId = typeof payload?.workId === 'string' ? payload.workId : null;
                const trigger = typeof payload?.trigger === 'string' ? payload.trigger : null;

                let service: AppSpecService;
                try {
                    service = appContext.get(AppSpecService);
                } catch (error) {
                    // No proxy in this container: the API-side registration is the
                    // missing piece, and saying so is the whole value of this branch.
                    const failure = errorText(error);
                    logger.error(
                        'app-spec-evaluate: AppSpecService is not available in this worker — the API-side ' +
                            'registration (trigger-internal remoteMap) is missing, so nothing was evaluated.',
                        { workId, trigger, error: failure },
                    );
                    return {
                        status: 'skipped',
                        jobId: APP_SPEC_EVALUATE_JOB_ID,
                        workId,
                        trigger,
                        evaluation: null,
                        reason: 'serviceUnavailable',
                        error: failure,
                    };
                }

                try {
                    const evaluation = await runAppSpecEvaluateJob<unknown>(payload, service);
                    logger.info('app-spec-evaluate finished', { workId, trigger });
                    return {
                        status: 'evaluated',
                        jobId: APP_SPEC_EVALUATE_JOB_ID,
                        workId,
                        trigger,
                        evaluation,
                        reason: null,
                        error: null,
                    };
                } catch (error) {
                    // A payload the handler refused, or an RPC that rejected: both
                    // are reported, neither is swallowed. The runtime's own retry
                    // policy is what runs this again.
                    const failure = errorText(error);
                    logger.error(`app-spec-evaluate: work ${workId ?? '?'} failed — ${failure}`, {
                        workId,
                        trigger,
                    });
                    return {
                        status: 'failed',
                        jobId: APP_SPEC_EVALUATE_JOB_ID,
                        workId,
                        trigger,
                        evaluation: null,
                        reason: 'evaluationFailed',
                        error: failure,
                    };
                }
            },
            AppSpecEvaluateWorkerModule,
        ),
});

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
