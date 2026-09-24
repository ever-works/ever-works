import { Module } from '@nestjs/common';
import { logger, task } from '@trigger.dev/sdk';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { TriggerInternalApiClient } from '../../trigger/worker/services/trigger-internal-api.client';
import { createRemoteProxy } from '../../trigger/worker/remote-proxy';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { getOptionalProvider } from '@ever-works/agent/utils';

/**
 * APW-05 T20 — `app-build-watch` (plan §7.3, §7.1).
 *
 * One dispatch of the job that OBSERVES one Build: it claims
 * `work_builds.watchLeaseUntil` for two minutes, resolves the App Work and its
 * build plugin, calls `IBuildPlugin.getBuild(ref, auth, redact)`, re-stamps the
 * three §3.1b values when the run's first `startedAt` is recorded
 * (`APW05-G03`), hands the snapshot to `AppBuildsService.applySnapshot` — whose
 * terminal transition finalises the Build, computes the deployable verdict of
 * §5.1, records the receipt and publishes the terminal event through §7.8's ONE
 * writer — deletes a verification Build's per-run prompted-value secret (§4.10)
 * and releases the lease.
 *
 * Every one of those steps is `AppBuildWatchRunner.run`'s work
 * (`@ever-works/agent`'s `app-builds` barrel, T20), so this file is deliberately
 * thin: it registers the job id, reports what the run did, and resolves the
 * runner.
 *
 * ## Why the runner is resolved over the internal RPC channel
 *
 * The watch reads `work_builds` and `work_build_preparations`, and it hands the
 * snapshot to `AppBuildsService`, whose `publish` writes the Activity row and
 * emits the `app.build.*` event the API's listeners are subscribed to. A Trigger
 * worker owns **no `DataSource`** (`app-spec-evaluate.task.ts:34-45` states the
 * same rule for the sibling job), so running the runner inside the worker would
 * write nothing and tell nobody. It is therefore provided as a **remote proxy**
 * over the internal channel, exactly as APW-03's `AppSpecService` and T19's
 * `AppBuildPrepareRunner` are.
 *
 * 🛑 **The two registrations this file does not own.**
 *
 * 1. `apps/api/src/trigger/trigger-internal.controller.ts`'s `remoteMap` must
 *    expose `AppBuildWatchRunner` (and `trigger-internal.module.ts` must be able
 *    to resolve it) — the API side of the RPC pair. It is not in this task's file
 *    list; **routed as a finding**, with the failure mode named: with it unbound
 *    the proxy's call rejects with `Unknown remote target: AppBuildWatchRunner`
 *    and this run reports `status: 'failed'`, `reason: 'watchFailed'` with the
 *    RPC's own message — a named, visible failure, never a green run that
 *    observed nothing. The in-process fallback of §7.1 keeps working meanwhile,
 *    because it never crosses the channel.
 * 2. `APP_BUILD_WATCH_RUNNER` (T17's token) must be bound for §7.1's fallback to
 *    have anything to run. `packages/agent/src/app-builds/app-builds.module.ts`
 *    binds `APP_BUILD_PREPARE_RUNNER` through a `ModuleRef` factory for exactly
 *    that reason and does NOT yet bind the watch token — that file is outside
 *    this task's list, so it is **routed as a finding** too. Until it is bound,
 *    `AppBuildsService.dispatchWatch` returns `false`, runs nothing, and logs the
 *    §7.1 fallback; the sweep of §7.4 is what covers Builds meanwhile.
 *
 * ## Budget — 120 s, up to 2 attempts
 *
 * §7.3:1386-1388's lease is `:now + 2 minutes`, so a run may not outlive the
 * lease it holds: another worker would take the same Build at that point, and
 * the two would race over a claim that is idempotent by construction but not
 * worth racing. The observation itself is one provider read plus a handful of
 * database writes; a run still going at two minutes has already lost its lease,
 * and §7.4's two-minute sweep is the retry that matters — it re-observes every
 * silent non-terminal Build regardless of what happened here, which is also why
 * a `concurrencyLimited` refusal loses nothing.
 *
 * ## The payload is declared here, and T18 owns its home
 *
 * `packages/agent/src/tasks/app-build-watch.types.ts` (T18) declares
 * `AppBuildWatchPayload` and `APP_BUILD_WATCH_TASK_ID`, and
 * `packages/tasks/src/trigger/trigger.service.ts:1234` enqueues under that id —
 * so this file's `task({ id: APP_BUILD_WATCH_TASK_ID, … })` is what makes the id
 * resolve at all (`app-build-watch.types.ts:18-26`). The constant is declared
 * here rather than imported so the Trigger worker's module graph does not pull
 * the agent barrel in for one string; the two are the same literal, and T20's
 * spec (`app-build-watch.runner.spec.ts`, "registers the same id in the Trigger
 * task module") reads this file and fails if they ever drift.
 */

/** The task id — the same string `app-build-watch.types.ts` and `trigger.service.ts` use. */
export const APP_BUILD_WATCH_TASK_ID = 'app-build-watch' as const;

/**
 * The payload of §7.1's `app-build-watch` row: **a Build id and a reason only**,
 * never a value, never a repository coordinate, never a status.
 *
 * The runner re-reads the row, the preparation row and the provider at run time,
 * so a queue message carries no state that could go stale between enqueue and
 * run — which is what makes a duplicated or late delivery harmless (§7.3).
 */
export interface AppBuildWatchTaskPayload {
    buildId: string;
    /** §7.1's three reasons: `event` (a webhook delivery) · `dispatched` · `sweep` (§7.4). */
    reason: string;
}

/** What one run reports — the shape every App Works job answers with. */
export interface AppBuildWatchTaskResult {
    /** `observed` — the runner ran. `skipped` — a gate refused. `failed` — it threw. */
    status: 'observed' | 'skipped' | 'failed';
    jobId: string;
    buildId: string | null;
    /** A named reason for anything that is not a plain observation. */
    reason: string | null;
    error: string | null;
    /** The runner's own result, when it ran. */
    result: unknown;
}

/**
 * The runner seam this worker resolves, and the token it is provided under.
 *
 * A local token on purpose: it lives in the **worker's** container and is never
 * compared with the API's `APP_BUILD_WATCH_RUNNER` (a different process, a
 * different graph), and the proxy is addressed by the provider NAME the API's
 * `remoteMap` uses (see the header).
 */
export const APP_BUILD_WATCH_RUNNER_SEAM = Symbol('APP_BUILD_WATCH_RUNNER_SEAM');

/** The one method this job calls on the runner. */
export interface AppBuildWatchRunnerSeam {
    run(payload: AppBuildWatchTaskPayload): Promise<unknown>;
}

/**
 * The narrowest worker composition that can host this job: the internal RPC
 * channel, plus the runner behind it.
 *
 * `TriggerInternalModule` is imported for `TriggerInternalApiClient` (its only
 * export this module needs) — not `TriggerWorkerModule`, whose graph an
 * observation has no use for: it resolves no plugin, reads no worktree and runs
 * no agent.
 */
@Module({
    imports: [TriggerInternalModule],
    providers: [
        {
            provide: APP_BUILD_WATCH_RUNNER_SEAM,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppBuildWatchRunner'),
            inject: [TriggerInternalApiClient],
        },
    ],
})
export class AppBuildWatchWorkerModule {}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The run body, **exported** — not only registered, so a local worker can drain
 * *this* function and the dev path and the Trigger path cannot drift.
 */
export async function runAppBuildWatchTask(
    payload: AppBuildWatchTaskPayload,
): Promise<AppBuildWatchTaskResult> {
    const buildId = typeof payload?.buildId === 'string' ? payload.buildId : null;
    const reason = typeof payload?.reason === 'string' ? payload.reason : null;

    if (!buildId) {
        // A payload the dispatcher could not have sent. Named, never guessed at.
        return {
            status: 'skipped',
            jobId: APP_BUILD_WATCH_TASK_ID,
            buildId: null,
            reason: 'invalid_payload',
            error: null,
            result: null,
        };
    }

    return withWorkerContext(
        'AppBuildWatch',
        async (appContext): Promise<AppBuildWatchTaskResult> => {
            // `getOptionalProvider`, not `appContext.get`: the latter THROWS for an
            // absent provider, so the named refusal below could never be reached.
            const runner = getOptionalProvider<AppBuildWatchRunnerSeam>(
                appContext,
                APP_BUILD_WATCH_RUNNER_SEAM,
            );
            if (!runner?.run) {
                logger.error(
                    'app-build-watch: the runner seam is not available in this worker context — ' +
                        'nothing was observed.',
                    { buildId, reason },
                );
                return {
                    status: 'skipped',
                    jobId: APP_BUILD_WATCH_TASK_ID,
                    buildId,
                    reason: 'runnerUnavailable',
                    error: null,
                    result: null,
                };
            }

            try {
                const result = await runner.run({ buildId, reason: reason ?? 'event' });
                logger.info('app-build-watch finished', { buildId, reason });
                return {
                    status: 'observed',
                    jobId: APP_BUILD_WATCH_TASK_ID,
                    buildId,
                    reason,
                    error: null,
                    result,
                };
            } catch (error) {
                // The RPC rejected (the API's `remoteMap` has no
                // `AppBuildWatchRunner` — see the header), or the provider threw.
                // Both are reported; neither is hidden.
                const failure = errorText(error);
                logger.error(`app-build-watch: build ${buildId} failed — ${failure}`, {
                    buildId,
                    reason,
                });
                return {
                    status: 'failed',
                    jobId: APP_BUILD_WATCH_TASK_ID,
                    buildId,
                    reason: 'watchFailed',
                    error: failure,
                    result: null,
                };
            }
        },
        AppBuildWatchWorkerModule,
    );
}

export const appBuildWatchTask = task<'app-build-watch', AppBuildWatchTaskPayload>({
    id: APP_BUILD_WATCH_TASK_ID,
    // Two minutes — §7.3's lease. See the file header.
    maxDuration: 120,
    // §9.2's retry shape, as the sibling job has it. A retry that arrives while
    // the lease is live exits as `leaseHeld`; §7.4's sweep is the real backstop.
    retry: { maxAttempts: 2 },
    run: runAppBuildWatchTask,
});
