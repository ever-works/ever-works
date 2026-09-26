import { logger, task } from '@trigger.dev/sdk';
import { AppSmokeService } from '@ever-works/agent/app-runtime';
import {
    APP_RUNTIME_TASK_QUEUE,
    TriggerAppRuntimeModule,
    appClusterWorkerRefusal,
} from '../../trigger/worker/modules/trigger-app-runtime.module';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { getOptionalProvider } from '@ever-works/agent/utils';

/**
 * APW-06 T32 (`tasks.md:556-573`) — **`app-smoke`**, the one-shot behind FR-36/FR-37's on-demand
 * smoke run (plan §5.7, §9.2:1246, §9.10:1597-1599).
 *
 * ## What it delegates to
 *
 * T32 says this task "delegates to the service", and **T70 landed** (APW-06
 * `packages/agent/src/app-runtime/app-smoke.service.ts`): this file boots
 * {@link TriggerAppRuntimeModule} — which is what arms T20's worker-context flag, without which no
 * cluster call in this process is legal — resolves `AppSmokeService` from that context and calls
 * `run({ workId, deploymentId, trigger, userId })`. §5.7's whole body is the service's: the current
 * Deployment, the in-cluster run through `runAppJob` with `runner: 'smoke'`, the public half
 * through T23's `AppPublicSmokeService`, `smokeResult` on that Deployment, `app.smoke.passed|failed`
 * — and **no rollback**, because an on-demand run against a live app has nothing to roll back to.
 *
 * This file keeps three things, and only three: the **isolation refusal** (`worker_not_isolated`),
 * the **missing-delegation refusal** (`smoke_service_unavailable`, now a fallback for a context
 * that boots without the service rather than the norm), and the registration itself.
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
    /** `true` ⇔ both halves passed. A smoke run that failed is still a run that happened. */
    passed: boolean;
    /** The service's own answer, verbatim — check names and codes only, never a log tail. */
    result: unknown;
}

/**
 * The file T70 landed, kept for the one case that still names it: a context that boots without the
 * service.
 */
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
            passed: false,
            result: null,
        };
    }

    if (!workId) {
        return {
            status: 'skipped',
            jobId: APP_SMOKE_TASK_ID,
            workId,
            deploymentId,
            reason: 'invalid_payload',
            missing: null,
            error: null,
            passed: false,
            result: null,
        };
    }

    return withWorkerContext(
        'AppSmoke',
        async (appContext): Promise<AppSmokeTaskResult> => {
            // `getOptionalProvider`, not `appContext.get`: the latter THROWS for an
            // absent provider, so the named error below could never be reached.
            const service = getOptionalProvider<AppSmokeService>(appContext, AppSmokeService);

            if (!service?.run) {
                logger.error(
                    `app-smoke: AppSmokeService (plan §5.7) is not resolvable from this worker ` +
                        `context — ${APP_SMOKE_SERVICE_PATH} is APW-06 T70's file and it is a ` +
                        'provider of TriggerAppRuntimeModule, so this context is not the one the ' +
                        'module builds. No smoke check ran and nothing was dialled.',
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
                    passed: false,
                    result: null,
                };
            }

            const result = await service.run({
                workId,
                deploymentId,
                trigger: typeof payload?.trigger === 'string' ? payload.trigger : null,
                userId: typeof payload?.userId === 'string' ? payload.userId : null,
            });

            if (result.state === 'refused') {
                logger.warn(`app-smoke: refused (${result.code}) for work ${workId}.`, {
                    workId,
                    deploymentId,
                });
            } else {
                logger.info(
                    `app-smoke: ${result.passed ? 'passed' : 'failed'} for work ${workId}.`,
                    {
                        workId,
                        deploymentId,
                        inCluster: result.record?.inCluster?.length ?? 0,
                        public: result.record?.public?.length ?? 0,
                    },
                );
            }

            return {
                status: result.state === 'refused' ? 'skipped' : 'ran',
                jobId: APP_SMOKE_TASK_ID,
                workId,
                deploymentId: result.deploymentId ?? deploymentId,
                reason: result.state === 'refused' ? result.code : null,
                missing: null,
                error: null,
                passed: result.passed === true,
                result,
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
