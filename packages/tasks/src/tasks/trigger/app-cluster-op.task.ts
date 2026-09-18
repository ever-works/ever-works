import { logger, task } from '@trigger.dev/sdk';
import {
    APP_RUNTIME_TASK_QUEUE,
    TriggerAppRuntimeModule,
    appClusterWorkerRefusal,
} from '../../trigger/worker/modules/trigger-app-runtime.module';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * APW-06 T32 (`tasks.md:556-573`) — **`app-cluster-op`**, the one-shot that carries every §9.2 op
 * (plan §9.2:1247, §9.10, §6.2).
 *
 * ## What it delegates to — and the delegation that is NOT in this tree yet
 *
 * T32 says this task "delegates to the router (T70)", and T70 names it:
 * `packages/agent/src/app-runtime/app-cluster-op.router.ts` — `AppClusterOpRouter.handle(payload)`,
 * which routes by `op` and to which T48, T58, T60 and T69 register their handlers. **That file does
 * not exist in this tree** (T70 has not landed), so there is no router to resolve and no `handle`
 * to call. This task therefore does the two things it *can* do honestly:
 *
 * 1. It registers on the same id, queue and budget T32 specifies — including the
 *    `verification-deploy` override of §9.2 — and boots {@link TriggerAppRuntimeModule}, which is
 *    what arms T20's worker-context flag, so the moment T70 lands a resolution of
 *    `AppClusterOpRouter` from this very context starts working;
 * 2. It **refuses by name** — `op_router_unavailable`, with the missing file path in the result and
 *    in the run log — rather than reporting an op that never ran.
 *
 * 🛑 **Nothing here is a stub of T70.** The op *handlers* that do exist are provided locally by
 * `TriggerAppRuntimeModule` (`AppRuntimeDeletionService.handleDeleteAppWork` — T58;
 * `AppVerificationTargetService.handleVerificationDeploy` / `handleVerificationStatus` /
 * `handleVerificationDestroy` — T60), so T70's router finds them the moment it lands. A second,
 * partial router written *inside this task file* would be a rival to §9.10's, and T48/T58/T60/T69
 * register into T70's — not into a copy of it. The remainder is reported, with its path.
 *
 * ## `maxDuration: 900`, overridden to 3 600 for `verification-deploy`
 *
 * §9.2: "`maxDuration: 900`, overridden to 3 600 for `verification-deploy`". The override is a
 * **trigger-time** option (`TriggerOptions.maxDuration` — "This will override the task's
 * maxDuration"), which is the dispatcher's call, not the task's:
 * `TriggerService.dispatchAppClusterOp` passes `{ maxDuration: APP_CLUSTER_OP_VERIFICATION_MAX_DURATION }`
 * for that op. The value is exported here so the dispatcher and this registration cannot disagree.
 */

/** The task id — exported so the local worker and the specs never copy the string. */
export const APP_CLUSTER_OP_TASK_ID = 'app-cluster-op' as const;

/** §9.2's nine-hundred-second registration budget. */
export const APP_CLUSTER_OP_MAX_DURATION_SECONDS = 900 as const;

/**
 * §9.2's per-op override for `verification-deploy`, passed by the dispatcher at trigger time.
 * 3 600 s: a verification deploys a whole namespace, waits for its rollout and then observes it.
 */
export const APP_CLUSTER_OP_VERIFICATION_MAX_DURATION = 3600 as const;

/** The file T70 lands; named here so a run log points at the gap instead of describing it. */
export const APP_CLUSTER_OP_ROUTER_PATH =
    'packages/agent/src/app-runtime/app-cluster-op.router.ts' as const;

/**
 * Every op §9.2 registers on the router, in the dispatcher's own order.
 *
 * A run that carries an op outside this list is refused as `unknown_op` **before** the router
 * lookup, so a dispatcher typo is a named refusal on the first run rather than an op the router
 * silently ignores once T70 lands.
 */
export const APP_CLUSTER_OPS = [
    'status-refresh',
    'logs',
    'pause',
    'resume',
    'remove',
    'cancel-deploy',
    'job-run',
    'cluster-check',
    'prepare-namespace',
    'ingress-reconcile',
    'dns-reconcile',
    'delete-app-work',
    'verification-deploy',
    'verification-status',
    'verification-destroy',
] as const;

export type AppClusterOp = (typeof APP_CLUSTER_OPS)[number];

/** §9.2's payload: the op, the Work, and the op's own fields — ids, never a value. */
export interface AppClusterOpTaskPayload {
    op: string;
    workId: string;
    requestId?: string | null;
    userId?: string | null;
    [key: string]: unknown;
}

/** What one run reports. */
export interface AppClusterOpTaskResult {
    status: 'ran' | 'skipped';
    jobId: string;
    op: string | null;
    workId: string | null;
    requestId: string | null;
    /** A named reason for anything that is not a plain run. */
    reason: string | null;
    /** The owner file a refusal is waiting on, when the refusal is a missing delegation. */
    missing: string | null;
    error: string | null;
}

/** The run body, exported — the local worker drains *this* function (see `app-deploy.task.ts`). */
export async function runAppClusterOpTask(
    payload: AppClusterOpTaskPayload,
): Promise<AppClusterOpTaskResult> {
    const op = typeof payload?.op === 'string' ? payload.op : null;
    const workId = typeof payload?.workId === 'string' ? payload.workId : null;
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null;

    const base = {
        jobId: APP_CLUSTER_OP_TASK_ID,
        op,
        workId,
        requestId,
    };

    const refusal = appClusterWorkerRefusal();
    if (refusal) {
        logger.error(`app-cluster-op: ${refusal.message}`, { ...base });
        return { ...base, status: 'skipped', reason: refusal.code, missing: null, error: null };
    }

    if (!op || !APP_CLUSTER_OPS.includes(op as AppClusterOp)) {
        // A typo is refused here rather than routed nowhere. §9.10's router owns the op set; this
        // check is the same set, so the two cannot disagree about what exists.
        logger.error(`app-cluster-op: unknown op "${String(payload?.op)}" — nothing was routed.`, {
            ...base,
        });
        return { ...base, status: 'skipped', reason: 'unknown_op', missing: null, error: null };
    }

    if (!workId) {
        return {
            ...base,
            status: 'skipped',
            reason: 'invalid_payload',
            missing: null,
            error: null,
        };
    }

    return withWorkerContext(
        'AppClusterOp',
        async (): Promise<AppClusterOpTaskResult> => {
            logger.error(
                `app-cluster-op: AppClusterOpRouter (plan §9.10) is not in this tree — ` +
                    `${APP_CLUSTER_OP_ROUTER_PATH} is APW-06 T70's file and it has not landed, so ` +
                    `op "${op}" was not routed. Nothing was dialled.`,
                { ...base },
            );

            return {
                ...base,
                status: 'skipped',
                reason: 'op_router_unavailable',
                missing: APP_CLUSTER_OP_ROUTER_PATH,
                error: null,
            };
        },
        TriggerAppRuntimeModule,
    );
}

export const appClusterOpTask = task<'app-cluster-op', AppClusterOpTaskPayload>({
    id: APP_CLUSTER_OP_TASK_ID,
    // §9.2's registration budget; `verification-deploy` overrides it at trigger time.
    maxDuration: APP_CLUSTER_OP_MAX_DURATION_SECONDS,
    retry: { maxAttempts: 1 },
    queue: APP_RUNTIME_TASK_QUEUE,
    run: runAppClusterOpTask,
});
