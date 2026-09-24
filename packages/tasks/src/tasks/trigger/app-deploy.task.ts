import { logger, task } from '@trigger.dev/sdk';
import {
    AppDeployOrchestrator,
    type AppDeployOrchestratorResult,
} from '@ever-works/agent/app-runtime';
import { WorkDeploymentRepository } from '@ever-works/agent/database';
import { WORK_APP_RUNTIME_STATES } from '@ever-works/agent/app-launcher';
import { getOptionalProvider } from '@ever-works/agent/utils';
import {
    APP_RUNTIME_TASK_QUEUE,
    TriggerAppRuntimeModule,
    appClusterWorkerRefusal,
} from '../../trigger/worker/modules/trigger-app-runtime.module';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * APW-06 T32 (`tasks.md:556-573`) — **`app-deploy`**, the one-shot that runs a Deployment on the
 * isolated worker (plan §5.6, §6.2, §9.2:1245).
 *
 * ## What it is, and what it is not
 *
 * The API creates the `work_deployments` row and dispatches this task; every step of §5.6 — the
 * precondition pass, the render input, the plugin call, the state writes, the lock release, the
 * dequeue and the §5.6 step 9 upstream verdict — is `AppDeployOrchestrator.run`'s work. This file
 * is therefore thin by design: it boots {@link TriggerAppRuntimeModule} (which is what arms T20's
 * worker-context flag and therefore what allows *any* cluster call to happen), resolves the
 * orchestrator from that context, and reports what the run did.
 *
 * ## `maxDuration: 7200`, `retry.maxAttempts: 1`
 *
 * Two hours: a first deploy provisions a namespace, pulls an image, waits for a rollout and runs
 * the pre-deploy Jobs, and §5.5's public smoke has a 600 s window of its own *after* the rollout.
 * One attempt, because a deploy is not blindly repeatable at the task level — the plugin has
 * already applied objects and the pre-deploy Jobs have already run — so the orchestrator's own
 * outcome handling is the retry mechanism, not the runtime's.
 *
 * ## Why `onFailure` exists and what it can actually do
 *
 * `run` resolves for every outcome the orchestrator can produce *including a refusal*, so a red
 * run means the failure happened **around** it: the Nest context failing to boot, the proxy
 * rejecting, `maxDuration` expiring. Because there is no retry, nothing re-enters `run` to land the
 * row, so {@link onAppDeployFailure} marks it `ERROR (worker_failed)` through the API's own
 * `WorkDeploymentRepository` (a proxied `remoteMap` entry — the worker owns no `DataSource`) and
 * releases the deploy lock through `WORK_APP_RUNTIME_STATES` **when that store is bound**.
 *
 * 🛑 **The lock-release half is best-effort today, and it says so at run time**: the store token is
 * APW-11 T5's and its binding is APW-06 **T17**'s
 * (`WorkAppRuntimeStateRepository`, not in this tree), so `appContext.get` answers `undefined` and
 * the hook reports `lockRelease: 'unbound'` instead of pretending to have released anything. The
 * orchestrator releases the lock itself on every outcome it *does* reach (T25's
 * "no outcome leaves a held lock"), so this hook is the backstop for the cases it never reaches.
 */

/** The task id — exported so the local worker and the specs never copy the string. */
export const APP_DEPLOY_TASK_ID = 'app-deploy' as const;

/**
 * The payload of §9.2's `app-deploy` row: **ids and the FR-23 source only**, never a value.
 *
 * The shape mirrors `AppDeployOrchestratorRequest` (`app-deploy.orchestrator.ts:535-553`) field for
 * field, because the run hands it straight to `run`. T31's `app-deploy.types.ts` is the eventual
 * home of the dispatcher-side type; until it lands this is the contract, and the two must agree.
 */
export interface AppDeployTaskPayload {
    workId: string;
    deploymentId: string;
    /** `manual` · `build` · `domain-change` · `rollback` · `target-saved` … (§7.1's `appTrigger`). */
    trigger?: string | null;
    /** `null` under `build.strategy: image` / `none` (§5.8). */
    buildId?: string | null;
    /** §5.8: the commit an `image` Deployment reads its spec from. */
    specCommitSha?: string | null;
    /** Who asked; the notification producers need an owner. */
    userId?: string | null;
    /** The Work's head commit, for `no_green_build_for_head`. */
    headCommitSha?: string | null;
    /** FR-34: pre-deploy jobs are skipped on a manual rollback by default. */
    skipPreDeployJobs?: boolean | null;
    /** FR-34: this Deployment is a rollback, so §5.6 step 9 never runs for it. */
    isRollback?: boolean | null;
    preview?: { prNumber: number } | null;
}

/** What one run reports — the shape every App runtime task answers with. */
export interface AppDeployTaskResult {
    /** `ran` — the orchestrator resolved. `skipped` — a gate refused. `failed` — it threw. */
    status: 'ran' | 'skipped' | 'failed';
    jobId: string;
    workId: string | null;
    deploymentId: string | null;
    /** The stored `work_deployments.state`, when the orchestrator ran. */
    state: string | null;
    /** A named reason for anything that is not a plain run. */
    reason: string | null;
    error: string | null;
    result: AppDeployOrchestratorResult | null;
}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The run body, **exported** — not only registered.
 *
 * The local worker (`app-runtime-local-worker.ts`) drains *this* function, so the dev path and the
 * Trigger path cannot drift: there is one body, registered once and called once.
 */
export async function runAppDeployTask(
    payload: AppDeployTaskPayload,
): Promise<AppDeployTaskResult> {
    const workId = typeof payload?.workId === 'string' ? payload.workId : null;
    const deploymentId = typeof payload?.deploymentId === 'string' ? payload.deploymentId : null;

    const refusal = appClusterWorkerRefusal();
    if (refusal) {
        logger.error(`app-deploy: ${refusal.message}`, { workId, deploymentId });
        return {
            status: 'skipped',
            jobId: APP_DEPLOY_TASK_ID,
            workId,
            deploymentId,
            state: null,
            reason: refusal.code,
            error: null,
            result: null,
        };
    }

    if (!workId || !deploymentId) {
        // A payload the dispatcher could not have sent. Named, never guessed at.
        return {
            status: 'skipped',
            jobId: APP_DEPLOY_TASK_ID,
            workId,
            deploymentId,
            state: null,
            reason: 'invalid_payload',
            error: null,
            result: null,
        };
    }

    return withWorkerContext(
        'AppDeploy',
        async (appContext): Promise<AppDeployTaskResult> => {
            // `getOptionalProvider`, not `appContext.get`: the latter THROWS for an
            // absent provider, so the named-error branch below could never run — the
            // job failed with Nest's generic "does not exist" instead of `skipped`.
            const orchestrator = getOptionalProvider<AppDeployOrchestrator>(
                appContext,
                AppDeployOrchestrator,
            );
            if (!orchestrator?.run) {
                // Nothing to delegate to: the context booted without the orchestrator, which
                // means this module was replaced by something narrower. Say so by name.
                logger.error(
                    'app-deploy: AppDeployOrchestrator is not available in this worker context — ' +
                        'nothing was deployed.',
                    { workId, deploymentId },
                );
                return {
                    status: 'skipped',
                    jobId: APP_DEPLOY_TASK_ID,
                    workId,
                    deploymentId,
                    state: null,
                    reason: 'orchestratorUnavailable',
                    error: null,
                    result: null,
                };
            }

            try {
                const result = await orchestrator.run({
                    workId,
                    deploymentId,
                    trigger: payload?.trigger ?? null,
                    buildId: payload?.buildId ?? null,
                    specCommitSha: payload?.specCommitSha ?? null,
                    userId: payload?.userId ?? null,
                    headCommitSha: payload?.headCommitSha ?? null,
                    skipPreDeployJobs: payload?.skipPreDeployJobs ?? null,
                    isRollback: payload?.isRollback ?? null,
                    preview: payload?.preview ?? null,
                });

                logger.info('app-deploy finished', {
                    workId,
                    deploymentId,
                    state: result.state,
                    outcome: result.outcome,
                    code: result.code,
                    lockReleased: result.lockReleased,
                });

                return {
                    status: 'ran',
                    jobId: APP_DEPLOY_TASK_ID,
                    workId,
                    deploymentId,
                    state: result.state ?? null,
                    reason: result.reason ?? null,
                    error: null,
                    result,
                };
            } catch (error) {
                // Only a throw OUTSIDE the orchestrator's own handling reaches here — the
                // orchestrator resolves for every outcome it can name. `onFailure` lands the row.
                const failure = errorText(error);
                logger.error(`app-deploy: work ${workId} failed — ${failure}`, {
                    workId,
                    deploymentId,
                });
                return {
                    status: 'failed',
                    jobId: APP_DEPLOY_TASK_ID,
                    workId,
                    deploymentId,
                    state: null,
                    reason: 'deployFailed',
                    error: failure,
                    result: null,
                };
            }
        },
        TriggerAppRuntimeModule,
    );
}

/** The code the row carries when the runtime failed around the orchestrator (§7.1's `lastError`). */
export const APP_DEPLOY_WORKER_FAILED_CODE = 'worker_failed' as const;

/** What {@link onAppDeployFailure} managed to do — reported, never assumed. */
export interface AppDeployFailureOutcome {
    /** `true` ⇔ the `work_deployments` row was marked `ERROR (worker_failed)`. */
    rowMarked: boolean;
    /** `released` · `unbound` (T17 has not landed) · `failed`. */
    lockRelease: 'released' | 'unbound' | 'failed' | 'skipped';
}

/**
 * The recovery body, **exported** so the specs assert the outcome directly (`onFailure` itself
 * answers `void`, which is what the runtime hook type requires). Both halves are best-effort on
 * purpose: this runs *after* the task has already failed, sometimes because the machine is out of
 * memory, so a recovery path must not be able to fail for the same reason as the thing it is
 * recovering. Nothing here throws.
 */
export async function recoverFailedAppDeploy(
    payload?: AppDeployTaskPayload,
    error?: unknown,
): Promise<AppDeployFailureOutcome> {
    const outcome: AppDeployFailureOutcome = { rowMarked: false, lockRelease: 'skipped' };
    const workId = typeof payload?.workId === 'string' ? payload.workId : null;
    const deploymentId = typeof payload?.deploymentId === 'string' ? payload.deploymentId : null;

    if (!workId || !deploymentId) return outcome;

    const failure = errorText(error);

    try {
        return await withWorkerContext(
            'AppDeploy:Failure',
            async (appContext): Promise<AppDeployFailureOutcome> => {
                try {
                    const deployments = appContext.get(WorkDeploymentRepository, {
                        strict: false,
                    });
                    if (deployments?.markTerminal) {
                        await deployments.markTerminal(deploymentId, 'ERROR', {
                            lastError: `${APP_DEPLOY_WORKER_FAILED_CODE}: ${failure}`.slice(0, 500),
                        });
                        outcome.rowMarked = true;
                    }
                } catch (markError) {
                    logger.error(
                        `app-deploy onFailure: could not mark deployment ${deploymentId} — ${errorText(
                            markError,
                        )}`,
                        { workId, deploymentId },
                    );
                }

                try {
                    const states = getOptionalProvider<{
                        releaseDeployLock?: (
                            workId: string,
                            deploymentId: string,
                        ) => Promise<unknown>;
                    }>(appContext, WORK_APP_RUNTIME_STATES);
                    if (states?.releaseDeployLock) {
                        await states.releaseDeployLock(workId, deploymentId);
                        outcome.lockRelease = 'released';
                    } else {
                        // T17's binding has not landed; say so rather than imply a release.
                        outcome.lockRelease = 'unbound';
                    }
                } catch (lockError) {
                    outcome.lockRelease = 'failed';
                    logger.error(
                        `app-deploy onFailure: could not release the deploy lock for ${deploymentId} — ${errorText(
                            lockError,
                        )}`,
                        { workId, deploymentId },
                    );
                }

                return outcome;
            },
            TriggerAppRuntimeModule,
        );
    } catch {
        // Best-effort by design — the orchestrator's own lock release is the normal path, and a
        // stale lock decays (plan §5.6 step 7 / `DistributedTaskLockService`'s stale window).
        return outcome;
    }
}

/**
 * The registered hook. `onFailure` — the primary recovery path for a failure the run never got to
 * record: the Nest context failing to boot, a proxy rejecting, `maxDuration` expiring.
 */
export async function onAppDeployFailure({
    payload,
    error,
}: {
    payload?: AppDeployTaskPayload;
    error?: unknown;
}): Promise<void> {
    await recoverFailedAppDeploy(payload, error);
}

export const appDeployTask = task<'app-deploy', AppDeployTaskPayload>({
    id: APP_DEPLOY_TASK_ID,
    // Two hours — see the file header.
    maxDuration: 7200,
    // The orchestrator owns the outcome; a blind re-run would duplicate applied objects.
    retry: { maxAttempts: 1 },
    queue: APP_RUNTIME_TASK_QUEUE,
    onFailure: onAppDeployFailure,
    run: runAppDeployTask,
});
