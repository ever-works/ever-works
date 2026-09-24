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
 * 1. `apps/api/src/trigger/trigger-internal.controller.ts`'s `remoteMap`
 *    exposes `AppBuildPrepareRunner` — the API side of the RPC pair (landed; it
 *    was routed as a finding from this file). Were it missing, the proxy's call
 *    would reject and this run report `status: 'failed'`,
 *    `reason: 'prepareFailed'` with the RPC's own message.
 * 2. `APP_BUILD_PREPARE_DISPATCHER` (T18) is what puts this job on the queue at
 *    all. It is bound (`packages/agent/src/tasks/job-runtime.providers.ts`) and
 *    enqueues this job when a job runtime is registered and configured. When
 *    it resolves `null` — no runtime registered, Trigger not configured, or the
 *    enqueue failed — `AppBuildsService.dispatchPrepare` takes §7.1's
 *    documented fallback and runs `AppBuildPrepareRunner.run` **in the API
 *    process** once, with no retry of any kind — the local e2e stack's path.
 *
 * ## Budget — 300 s; runner failures are REPORTED, not retried
 *
 * `maxDuration` 300 s is the §7.2 lock's lease ("held ≤ 5 minutes"). It bounds
 * this WORKER run only, and the worker's real bound is shorter — the RPC's
 * non-retried 45 s deadline. The pass itself runs in the API behind the RPC and
 * keeps going after that deadline, its lock's 5-minute lease renewed every
 * 100 s by the heartbeat (up to a 24 h lifetime), so the API-side pass can
 * outlive this run.
 *
 * `plan.md:1627` (§9.2) asks for "Job retries with the runtime's backoff 3 times
 * over 10 minutes". This job deliberately does NOT deliver that: every runner
 * THROW is RETURNED as `status: 'failed'`, and Trigger.dev retries only a run
 * that throws. (Some failures never reach the task as failures at all: the
 * runner swallows a failed `startBuild` — reporting `prepared` — and turns a
 * thrown read of the Work, spec, plugin or build values into a named skip.)
 * Decided on 2026-09-24 after reading the runner, because a task-side rethrow
 * cannot be made safe here:
 *
 * - it cannot tell a retryable failure from a permanent one — every runner throw
 *   crosses the RPC as a detail-less 500, so a GitHub 5xx, a 401/403/404, a 422
 *   and a programming error all look the same;
 * - it can DUPLICATE a GitHub run — a database error after `startBuild`'s
 *   `workflow_dispatch` landed but before `dispatchedAt` was stamped would, on a
 *   retry, dispatch the still-undispatched Build again;
 * - and it would not help: `{ maxAttempts: 3 }` with the runtime's default
 *   backoff retries after ~1–2 s and ~2–4 s (not "over 10 minutes"), far too
 *   soon for a 5xx outage or a rate-limit window. A failure that arrives as a
 *   500 has already released the lock, so a retry would take it and re-run the
 *   pass (which is how the duplicate above happens); only after an RPC timeout
 *   or a lost API pod is the lock still held, and then a retry answers
 *   `skipped: locked`.
 *
 * Nor does "the runner writes nothing until `prepareRepository` has answered"
 * hold: Builds can be blocked `missingBuildValues`, and the provider can already
 * hold the workflow commit or pull request and some secrets, when a later step
 * throws.
 *
 * 🛑 **Routed finding — a requested Build whose prepare fails stays `queued`**
 * with `dispatchedAt` NULL until something prepares the Work again (another
 * prepare reason, or the owner's next Rebuild). Nothing re-drives it today: the
 * §7.6 listeners and the §7.4 sweep have not landed, and the planned sweep
 * dispatches watch, not prepare. And in the database-error-after-dispatch
 * window above, that next prepare dispatches the same Build AGAIN (Builds are
 * picked by `dispatchedAt IS NULL`). The fix belongs in the runner and the
 * service — classify provider failures into §9.2's `blocked` values, and claim
 * a Build before dispatching it — not in a blanket task-level retry.
 *
 * `retry: { maxAttempts: 3 }` therefore applies only to what escapes the run
 * body's `catch`: a worker context that cannot boot or close, and a worker
 * crash, eviction or stall. A retry then re-issues the RPC — safe, except in
 * the dispatch window above.
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
 * The runner's own verdict, read defensively off the wire (the result crosses
 * the RPC as data). `prepared` and `skipped` are what the runner returns today;
 * `failed` is in its result type and honoured if it ever arrives. Anything else
 * — no status, an unknown one — is NOT a success: it fails closed as
 * `unrecognisedRunnerResult`, since a green run nobody can read is the silent
 * no-op this programme forbids.
 */
function runnerOutcome(result: unknown): {
    status: AppBuildPrepareTaskResult['status'];
    reason: string | null;
    error: string | null;
} {
    const value = (result ?? {}) as { status?: unknown; reason?: unknown; error?: unknown };
    const text = (field: unknown) => (typeof field === 'string' && field.length > 0 ? field : null);
    if (value.status === 'prepared') return { status: 'prepared', reason: null, error: null };
    if (value.status === 'skipped') {
        return { status: 'skipped', reason: text(value.reason) ?? 'skipped', error: null };
    }
    if (value.status === 'failed') {
        return {
            status: 'failed',
            reason: text(value.reason) ?? 'prepareFailed',
            error: text(value.error),
        };
    }
    return {
        status: 'failed',
        reason: 'unrecognisedRunnerResult',
        error: `the runner answered without a recognised status (${JSON.stringify(value.status ?? null)})`,
    };
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
                // The runner names its own outcome. Reported as-is: a pass that
                // did nothing — `locked`, `pluginUnavailable`, … — is a `skipped`
                // run with the runner's reason, never a green `prepared`.
                const outcome = runnerOutcome(result);
                // `prepared` is info; a skip is a warning (a pass that did nothing
                // is worth seeing); a runner-reported failure is an error. The run
                // itself still COMPLETES in Trigger.dev — this job never throws.
                const log =
                    outcome.status === 'prepared'
                        ? logger.info
                        : outcome.status === 'skipped'
                          ? logger.warn
                          : logger.error;
                log('app-build-prepare finished', {
                    workId,
                    reason,
                    status: outcome.status,
                    ...(outcome.reason ? { runnerReason: outcome.reason } : {}),
                    ...(outcome.error ? { error: outcome.error } : {}),
                });
                return {
                    status: outcome.status,
                    jobId: APP_BUILD_PREPARE_TASK_ID,
                    workId,
                    reason: outcome.status === 'prepared' ? reason : outcome.reason,
                    error: outcome.error,
                    result,
                };
            } catch (error) {
                // The RPC rejected, or the runner threw a provider failure it did
                // not swallow. Both are reported; neither is hidden — and neither is
                // rethrown for a runtime retry: see "Budget" in the header.
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
    // Applies only to what escapes the run body's catch (boot or close
    // failures, worker crashes or evictions). Runner failures are returned, not
    // retried — see the header's "Budget" for why §9.2:1627's retry is not
    // delivered here.
    retry: { maxAttempts: 3 },
    run: runAppBuildPrepareTask,
});
