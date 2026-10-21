/**
 * App Works follow-up (e), 2026-10-21 — **the `app-cluster-io` queue is the only place the managed
 * cluster credential exists**.
 *
 * Every App Work cluster connection runs on the dedicated, concurrency-limited `app-cluster-io`
 * queue (`APP_RUNTIME_TASK_QUEUE`, plan §6.2:942). But a Trigger.dev environment's variables are
 * the same for every task in it, so `EVER_WORKS_APPS_MANAGED_KUBECONFIG` — the managed target's
 * control-namespace credential — was readable by every OTHER task too: an agent run, a KB embed, a
 * notification delivery, and any subprocess they spawn with the inherited environment (prod
 * hardening log, 2026-10-18: "Residual risk: every Trigger task gets … the managed kubeconfig
 * env").
 *
 * {@link withAppClusterIoIsolation} closes that for the duration of a run: for a run that is NOT on
 * the `app-cluster-io` queue (and is not one of its known task ids, so a queue that is reported
 * under another name can never strip the credential from the tasks that need it), the cluster-only
 * variables are removed from `process.env` before the task body runs and put back afterwards (so
 * a reused process is unchanged for the next run). The value is never logged.
 *
 * The cluster tasks are unaffected; `ConfigAppsTierPolicy` already refuses to read the credential
 * outside the isolated App runtime worker context, so no other task had a legitimate read.
 */

/** The dedicated queue every App cluster task declares (`APP_RUNTIME_TASK_QUEUE.name`). */
export const APP_CLUSTER_IO_QUEUE_NAME = 'app-cluster-io';

/** The task ids registered on that queue — the belt beside the queue name. */
export const APP_CLUSTER_IO_TASK_IDS: readonly string[] = [
    'app-deploy',
    'app-cluster-op',
    'app-health-poll',
    'app-smoke',
    'app-dependency-provision',
];

/** The variables only an `app-cluster-io` run may see. */
export const APP_CLUSTER_IO_ONLY_ENV: readonly string[] = ['EVER_WORKS_APPS_MANAGED_KUBECONFIG'];

/** True when this run is an App cluster run (by its queue, or by its task id). */
export function isAppClusterIoRun(queueName: unknown, taskId: unknown): boolean {
    const queue = typeof queueName === 'string' ? queueName.trim() : '';
    const task = typeof taskId === 'string' ? taskId.trim() : '';
    return queue === APP_CLUSTER_IO_QUEUE_NAME || APP_CLUSTER_IO_TASK_IDS.includes(task);
}

/**
 * Remove the cluster-only variables from `env` for a run that is not an App cluster run; answer
 * the removed entries so the caller can restore them. An App cluster run removes nothing.
 */
export function stashAppClusterOnlyEnv(
    queueName: unknown,
    taskId: unknown,
    env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    if (isAppClusterIoRun(queueName, taskId)) {
        return {};
    }
    const stashed: Record<string, string> = {};
    for (const name of APP_CLUSTER_IO_ONLY_ENV) {
        const value = env[name];
        if (typeof value === 'string') {
            stashed[name] = value;
            delete env[name];
        }
    }
    return stashed;
}

/** Put back what {@link stashAppClusterOnlyEnv} removed, without overwriting a value set since. */
export function restoreAppClusterOnlyEnv(
    stashed: Record<string, string>,
    env: NodeJS.ProcessEnv = process.env,
): void {
    for (const [name, value] of Object.entries(stashed ?? {})) {
        if (env[name] === undefined) {
            env[name] = value;
        }
    }
}

/**
 * Run `next` with the cluster-only variables hidden from a non-cluster run, and restored after it
 * whether it succeeded or threw. The shape of a Trigger.dev global middleware's body.
 */
export async function withAppClusterIoIsolation(
    run: { queueName?: unknown; taskId?: unknown },
    next: () => Promise<void>,
    env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    const stashed = stashAppClusterOnlyEnv(run?.queueName, run?.taskId, env);
    try {
        await next();
    } finally {
        restoreAppClusterOnlyEnv(stashed, env);
    }
}
