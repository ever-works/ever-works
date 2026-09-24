import { Module } from '@nestjs/common';
import { logger, task } from '@trigger.dev/sdk';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { TriggerInternalApiClient } from '../../trigger/worker/services/trigger-internal-api.client';
import { createRemoteProxy } from '../../trigger/worker/remote-proxy';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { getOptionalProvider } from '@ever-works/agent/utils';

/**
 * APW-05 T19 — `app-build-prepare` (plan §7.2, §7.1).
 *
 * One dispatch of the job that turns a build REQUEST into a build PREPARATION:
 * it reads the App Work, its effective App spec and its preparation row, gates
 * the strategy, the build values and the runner, calls
 * `IBuildPlugin.prepareRepository` (the workflow file, one commit or one pull
 * request, plus the `EW_` secret sync), writes the §3.1b row, blocks or
 * dispatches the requested Builds, retries one blocked Build (step 7) and
 * repeats while `prepareSeq` keeps moving.
 *
 * Every one of those steps is `AppBuildPrepareRunner.run`'s work
 * (`@ever-works/agent`'s `app-builds` barrel, T19), so this file is deliberately
 * thin: it registers the job id, reports what the run did, and resolves the
 * runner.
 *
 * ## Why the runner is resolved over the internal RPC channel
 *
 * The prepare writes `work_builds` and `work_build_preparations`, takes
 * `DistributedTaskLockService` (a `cache_entries` row) and hands the result to
 * `AppBuildsService`, whose `publish` writes the Activity row and emits the
 * `app.build.*` event the API's listeners are subscribed to. A Trigger worker
 * owns **no `DataSource`** (`app-spec-evaluate.task.ts:34-45` states the same
 * rule for the sibling job), so running the runner inside the worker would write
 * nothing and tell nobody. It is therefore provided as a **remote proxy** over
 * the internal channel, exactly as APW-03's `AppSpecService` is.
 *
 * 🛑 **The two registrations this file does not own.**
 *
 * 1. `apps/api/src/trigger/trigger-internal.controller.ts`'s `remoteMap` must
 *    expose `AppBuildPrepareRunner` (and `trigger-internal.module.ts` must be
 *    able to resolve it) — the API side of the RPC pair. It is not in this
 *    task's file list; **routed as a finding**, with the failure mode named: with
 *    it unbound the proxy's call rejects and this run reports
 *    `status: 'failed'`, `reason: 'prepareFailed'` with the RPC's own message
 *    — a named, visible failure, never a green run that prepared nothing.
 * 2. `APP_BUILD_PREPARE_DISPATCHER` (T18) is what puts this job on the queue at
 *    all. Until it is bound, `AppBuildsService.dispatchPrepare` takes §7.1's
 *    documented fallback and runs `AppBuildPrepareRunner.run` **in the API
 *    process** — which is the path the local e2e stack takes today, and the
 *    reason this task's existence gates no behaviour.
 *
 * ## Budget — 300 s, up to 3 attempts
 *
 * Five minutes is the §7.2 lock's own TTL ("held ≤ 5 minutes"), so a run can
 * never outlive the lock it holds; a prepare is a handful of provider calls and
 * database writes, and a run still going at five minutes has already lost its
 * lock. `plan.md:1627` gives the retry shape: "Job retries with the runtime's
 * backoff 3 times over 10 minutes; a requested Build stays `queued`" — which
 * holds because the runner writes nothing until `prepareRepository` has
 * answered.
 *
 * ## The payload is declared here, and T18 owns its eventual home
 *
 * T18 creates `packages/agent/src/tasks/app-build-prepare.types.ts` beside the
 * dispatcher, and `packages/agent/src/tasks/index.ts` re-exports the payload
 * type the trigger service passes. Until then this interface is the contract, and
 * the two must agree field for field — the same posture
 * `app-deploy.task.ts:56-62` records for `AppDeployTaskPayload` and T31.
 */

/** The task id — exported so the dispatch site and the specs never copy the string. */
export const APP_BUILD_PREPARE_TASK_ID = 'app-build-prepare' as const;

/**
 * The payload of §7.1's `app-build-prepare` row: **ids and a reason only**, never
 * a value, never a repository coordinate.
 *
 * `buildId` is optional and deliberately advisory — the runner numbers the
 * Builds it acts on from the database (`plan.md:1374-1375`), so a coalesced
 * dispatch that arrives without it loses nothing.
 */
export interface AppBuildPrepareTaskPayload {
    workId: string;
    buildId?: string;
    /** §7.1's nine reasons: `specApplied` · `envChanged` · `rebuild` · `verification` · `pullTokenSaved` · `workflowMerged` · `settingsChanged` · `actionsEnabled` · `coalesced`. */
    reason: string;
}

/** What one run reports — the shape every App Works job answers with. */
export interface AppBuildPrepareTaskResult {
    /** `prepared` — the runner ran. `skipped` — a gate refused. `failed` — it threw. */
    status: 'prepared' | 'skipped' | 'failed';
    jobId: string;
    workId: string | null;
    /** A named reason for anything that is not a plain prepare. */
    reason: string | null;
    error: string | null;
    /** The runner's own result, when it ran. */
    result: unknown;
}

/**
 * The runner seam this worker resolves, and the token it is provided under.
 *
 * A local token on purpose: it lives in the **worker's** container and is never
 * compared with the API's `APP_BUILD_PREPARE_RUNNER` (a different process, a
 * different graph), and the proxy is addressed by the provider NAME the API's
 * `remoteMap` uses. Importing the API's token here would drag
 * `@ever-works/agent/app-builds` — and therefore a built `dist` of the agent
 * package — into this worker's module graph for a symbol that cannot be shared
 * across the hop anyway.
 */
export const APP_BUILD_PREPARE_RUNNER_SEAM = Symbol('APP_BUILD_PREPARE_RUNNER_SEAM');

/** The one method this job calls on the runner. */
export interface AppBuildPrepareRunnerSeam {
    run(payload: AppBuildPrepareTaskPayload): Promise<unknown>;
}

/**
 * The narrowest worker composition that can host this job: the internal RPC
 * channel, plus the runner behind it.
 *
 * `TriggerInternalModule` is imported for `TriggerInternalApiClient` (its only
 * export this module needs) — not `TriggerWorkerModule`, whose graph the prepare
 * has no use for: it resolves no plugin, reads no worktree and runs no agent.
 */
@Module({
    imports: [TriggerInternalModule],
    providers: [
        {
            provide: APP_BUILD_PREPARE_RUNNER_SEAM,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppBuildPrepareRunner'),
            inject: [TriggerInternalApiClient],
        },
    ],
})
export class AppBuildPrepareWorkerModule {}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The run body, **exported** — not only registered, so a local worker can drain
 * *this* function and the dev path and the Trigger path cannot drift.
 */
export async function runAppBuildPrepareTask(
    payload: AppBuildPrepareTaskPayload,
): Promise<AppBuildPrepareTaskResult> {
    const workId = typeof payload?.workId === 'string' ? payload.workId : null;
    const reason = typeof payload?.reason === 'string' ? payload.reason : null;

    if (!workId) {
        // A payload the dispatcher could not have sent. Named, never guessed at.
        return {
            status: 'skipped',
            jobId: APP_BUILD_PREPARE_TASK_ID,
            workId: null,
            reason: 'invalid_payload',
            error: null,
            result: null,
        };
    }

    return withWorkerContext(
        'AppBuildPrepare',
        async (appContext): Promise<AppBuildPrepareTaskResult> => {
            // `getOptionalProvider`, not `appContext.get`: the latter THROWS for an
            // absent provider, so the named refusal below could never be reached.
            const runner = getOptionalProvider<AppBuildPrepareRunnerSeam>(
                appContext,
                APP_BUILD_PREPARE_RUNNER_SEAM,
            );
            if (!runner?.run) {
                logger.error(
                    'app-build-prepare: the runner seam is not available in this worker context — ' +
                        'nothing was prepared.',
                    { workId, reason },
                );
                return {
                    status: 'skipped',
                    jobId: APP_BUILD_PREPARE_TASK_ID,
                    workId,
                    reason: 'runnerUnavailable',
                    error: null,
                    result: null,
                };
            }

            try {
                const result = await runner.run({ workId, reason: reason ?? 'specApplied' });
                logger.info('app-build-prepare finished', { workId, reason });
                return {
                    status: 'prepared',
                    jobId: APP_BUILD_PREPARE_TASK_ID,
                    workId,
                    reason,
                    error: null,
                    result,
                };
            } catch (error) {
                // The RPC rejected, or the runner threw a provider failure it
                // deliberately did not swallow (§9.2's retry is the runtime's).
                // Both are reported; neither is hidden.
                const failure = errorText(error);
                logger.error(`app-build-prepare: work ${workId} failed — ${failure}`, {
                    workId,
                    reason,
                });
                return {
                    status: 'failed',
                    jobId: APP_BUILD_PREPARE_TASK_ID,
                    workId,
                    reason: 'prepareFailed',
                    error: failure,
                    result: null,
                };
            }
        },
        AppBuildPrepareWorkerModule,
    );
}

export const appBuildPrepareTask = task<'app-build-prepare', AppBuildPrepareTaskPayload>({
    id: APP_BUILD_PREPARE_TASK_ID,
    // Five minutes — the §7.2 lock's own TTL. See the file header.
    maxDuration: 300,
    // Up to three attempts with the runtime's backoff (§9.2:1627); a requested
    // Build stays queued because nothing is written until the provider answers.
    retry: { maxAttempts: 3 },
    run: runAppBuildPrepareTask,
});
