import { logger, task } from '@trigger.dev/sdk';
import {
    APP_RUNTIME_TASK_QUEUE,
    TriggerAppRuntimeModule,
    appClusterWorkerRefusal,
} from '../../trigger/worker/modules/trigger-app-runtime.module';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * APW-06 T32 (`tasks.md:556-573`) — **`app-smoke`**, the one-shot behind FR-36/FR-37's on-demand
 * smoke run (plan §5.7, §9.2:1246, §9.10).
 *
 * ## What it delegates to — and the delegation that is NOT in this tree yet
 *
 * T32 says this task "delegates to the service", and T70 names that service:
 * `packages/agent/src/app-runtime/app-smoke.service.ts` — `AppSmokeService`, plan §5.7 — which T70
 * also lists as one of `TriggerAppRuntimeModule`'s local providers. **That file does not exist in
 * this tree** (T70 has not landed), so there is no class to resolve and no method to call. This
 * task therefore does the two things it *can* do honestly:
 *
 * 1. It registers on the same id, queue and budget T32 specifies, and boots
 *    {@link TriggerAppRuntimeModule} — which is what arms T20's worker-context flag, so the moment
 *    T70 lands a resolution of `AppSmokeService` from this very context starts working;
 * 2. It **refuses by name** — `smoke_service_unavailable`, with the missing file path in the result
 *    and in the run log — rather than reporting a green smoke run that never happened.
 *
 * 🛑 **Nothing here is a stub of T70.** There is no second smoke implementation in this file: a
 * re-implementation would be a rival to §5.7's service that T70 then has to reconcile, and a
 * "successful" run that ran no check is exactly the silent no-op this programme's rule forbids.
 * The remainder is reported, with its path, not papered over.
 *
 * ## `maxDuration: 900`
 *
 * §5.5's public smoke has a 600 s window of its own and the in-cluster checks are bounded by the
 * rollout they follow, so fifteen minutes covers a full pass with room for the retry cadence.
 */

/** The task id — exported so the local worker and the specs never copy the string. */
export const APP_SMOKE_TASK_ID = 'app-smoke' as const;

/** §9.2's `app-smoke` payload: ids only. */
export interface AppSmokeTaskPayload {
    workId: string;
    deploymentId?: string | null;
    /** `manual` · `deploy` · `health-poll` … — reported, never branched on here. */
    trigger?: string | null;
    userId?: string | null;
}

/** What one run reports. */
export interface AppSmokeTaskResult {
    status: 'ran' | 'skipped';
    jobId: string;
    workId: string | null;
    deploymentId: string | null;
    /** A named reason for anything that is not a plain run. */
    reason: string | null;
    /** The owner file a refusal is waiting on, when the refusal is a missing delegation. */
    missing: string | null;
    error: string | null;
}

/** The file T70 lands; named here so a run log points at the gap instead of describing it. */
export const APP_SMOKE_SERVICE_PATH =
    'packages/agent/src/app-runtime/app-smoke.service.ts' as const;

/** The run body, exported — the local worker drains *this* function (see `app-deploy.task.ts`). */
export async function runAppSmokeTask(payload: AppSmokeTaskPayload): Promise<AppSmokeTaskResult> {
    const workId = typeof payload?.workId === 'string' ? payload.workId : null;
    const deploymentId = typeof payload?.deploymentId === 'string' ? payload.deploymentId : null;

    const refusal = appClusterWorkerRefusal();
    if (refusal) {
        logger.error(`app-smoke: ${refusal.message}`, { workId, deploymentId });
        return {
            status: 'skipped',
            jobId: APP_SMOKE_TASK_ID,
            workId,
            deploymentId,
            reason: refusal.code,
            missing: null,
            error: null,
        };
    }

    return withWorkerContext(
        'AppSmoke',
        async (): Promise<AppSmokeTaskResult> => {
            logger.error(
                `app-smoke: AppSmokeService (plan §5.7) is not in this tree — ` +
                    `${APP_SMOKE_SERVICE_PATH} is APW-06 T70's file and it has not landed, so no ` +
                    'smoke check ran. Nothing was dialled.',
                { workId, deploymentId },
            );

            return {
                status: 'skipped',
                jobId: APP_SMOKE_TASK_ID,
                workId,
                deploymentId,
                reason: 'smoke_service_unavailable',
                missing: APP_SMOKE_SERVICE_PATH,
                error: null,
            };
        },
        TriggerAppRuntimeModule,
    );
}

export const appSmokeTask = task<'app-smoke', AppSmokeTaskPayload>({
    id: APP_SMOKE_TASK_ID,
    maxDuration: 900,
    retry: { maxAttempts: 1 },
    queue: APP_RUNTIME_TASK_QUEUE,
    run: runAppSmokeTask,
});
