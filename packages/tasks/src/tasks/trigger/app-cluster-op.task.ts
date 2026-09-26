import { logger, task } from '@trigger.dev/sdk';
import { AppClusterOpRouter } from '@ever-works/agent/app-runtime';
import {
    APP_RUNTIME_TASK_QUEUE,
    TriggerAppRuntimeModule,
    appClusterWorkerRefusal,
} from '../../trigger/worker/modules/trigger-app-runtime.module';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { getOptionalProvider } from '@ever-works/agent/utils';

/**
 * APW-06 T32 (`tasks.md:556-573`) — **`app-cluster-op`**, the one-shot that carries every §9.2 op
 * (plan §9.2:1247, §9.10, §6.2).
 *
 * ## What it delegates to
 *
 * T32 says this task "delegates to the router (T70)", and **T70 landed** (APW-06
 * `packages/agent/src/app-runtime/app-cluster-op.router.ts`): this file boots
 * {@link TriggerAppRuntimeModule} — which is what arms T20's worker-context flag, without which no
 * cluster call in this process is legal — resolves `AppClusterOpRouter` from that context and hands
 * it the payload. The router routes by `op`; T48, T58, T60 and T69 register their ops on it, and
 * this file keeps **no op logic at all** (which is what §9.10 asks for: "so no op lives in the task
 * file").
 *
 * Three things this file still owns, and why:
 *
 * 1. the **isolation refusal** (`worker_not_isolated`) — a message enqueued before the flag was
 *    flipped, or by an older deployment, must still not dial a cluster;
 * 2. the **op allow-list** (`unknown_op`) — the same fifteen ids §9.2 registers, checked *before*
 *    the router lookup so a dispatcher typo is a named refusal on the first run;
 * 3. the **`op_router_unavailable` fallback** — when the context boots without the router (a module
 *    replaced by something narrower, or a stale build), the run reports the file it is waiting on
 *    instead of reporting an op that never ran. That path is now a *fallback*, not the norm: the
 *    router is a provider of `TriggerAppRuntimeModule`.
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

/**
 * The file T70 landed, kept here for the one case that still names it: a context that boots without
 * the router. A run log then points at the file instead of describing the gap.
 */
export const APP_CLUSTER_OP_ROUTER_PATH =
    'packages/agent/src/app-runtime/app-cluster-op.router.ts' as const;

/**
 * Every op §9.2 registers on the router, in the dispatcher's own order.
 *
 * A run that carries an op outside this list is refused as `unknown_op` **before** the router
 * lookup, so a dispatcher typo is a named refusal on the first run rather than an op the router
 * silently ignores.
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
    /** Which service the router routed to: `registered` · `lifecycle-ops` · `deletion` · `verification` · `unowned`. */
    route: string | null;
    /** The router's own state for the op: `done` · `failed` · `refused` · `deferred`. */
    state: string | null;
    /** The handler's answer, verbatim — never a value, a token or a log tail. */
    result: unknown;
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
        route: null,
        state: null,
        result: null,
    };

    const refusal = appClusterWorkerRefusal();
    if (refusal) {
        logger.error(`app-cluster-op: ${refusal.message}`, {
            jobId: base.jobId,
            op,
            workId,
            requestId,
        });
        return { ...base, status: 'skipped', reason: refusal.code, missing: null, error: null };
    }

    if (!op || !APP_CLUSTER_OPS.includes(op as AppClusterOp)) {
        // A typo is refused here rather than routed nowhere. §9.10's router owns the op set; this
        // check is the same set, so the two cannot disagree about what exists.
        logger.error(`app-cluster-op: unknown op "${String(payload?.op)}" — nothing was routed.`, {
            jobId: base.jobId,
            op,
            workId,
            requestId,
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
        async (appContext): Promise<AppClusterOpTaskResult> => {
            // `getOptionalProvider`, not `appContext.get`: the latter THROWS for an
            // absent provider, so the named error below could never be reached.
            const router = getOptionalProvider<AppClusterOpRouter>(appContext, AppClusterOpRouter);

            if (!router?.handle) {
                logger.error(
                    `app-cluster-op: AppClusterOpRouter (plan §9.10) is not resolvable from this ` +
                        `worker context — ${APP_CLUSTER_OP_ROUTER_PATH} is APW-06 T70's file and it ` +
                        `is a provider of TriggerAppRuntimeModule, so this context is not the one ` +
                        `the module builds. Op "${op}" was not routed and nothing was dialled.`,
                    { jobId: base.jobId, op, workId, requestId },
                );

                return {
                    ...base,
                    status: 'skipped',
                    reason: 'op_router_unavailable',
                    missing: APP_CLUSTER_OP_ROUTER_PATH,
                    error: null,
                };
            }

            const routed = await router.handle({
                ...(payload ?? {}),
                op,
                workId,
                requestId,
                userId: typeof payload?.userId === 'string' ? payload.userId : null,
            });

            if (routed.state === 'refused') {
                logger.warn(
                    `app-cluster-op: ${op} was refused (${routed.code}) by ${routed.route}.`,
                    {
                        jobId: base.jobId,
                        op,
                        workId,
                        requestId,
                        missing: routed.missing,
                    },
                );
            } else {
                logger.info(`app-cluster-op: ${op} ${routed.state} via ${routed.route}.`, {
                    jobId: base.jobId,
                    op,
                    workId,
                    requestId,
                    code: routed.code,
                });
            }

            return {
                ...base,
                status: routed.state === 'refused' ? 'skipped' : 'ran',
                // A refusal's code is the run's reason; a failure's code is the run's error. Both are
                // named, and neither is invented when the handler answered cleanly.
                reason: routed.state === 'refused' ? routed.code : null,
                missing: routed.missing,
                error: routed.state === 'failed' ? routed.code : null,
                route: routed.route,
                state: routed.state,
                result: routed.result,
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
