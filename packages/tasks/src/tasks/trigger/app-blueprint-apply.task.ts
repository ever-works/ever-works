import { Module } from '@nestjs/common';
import { logger, task } from '@trigger.dev/sdk';
import type { AppBlueprintApplyJobPayload } from '@ever-works/agent/app-works';
import { TriggerWorkerModule } from '../../trigger/worker/modules/trigger-worker.module';
import { TriggerInternalApiClient } from '../../trigger/worker/services/trigger-internal-api.client';
import { createRemoteProxy } from '../../trigger/worker/remote-proxy';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * APW-03 T28 (lane aw-blueprints) — `app-blueprint-apply` (plan §6.1: 300 s, retries 1).
 *
 * One Blueprint run of one App Work: **apply** a Blueprint chosen after the Work was
 * created, or **upgrade** to a newer Blueprint version. The run reads the Blueprint at
 * the applied and the new version, reads the Work's `.works/works.yml`, three-way merges
 * them (`app-spec-merge.ts` — a member value is never silently overwritten, conflicts are
 * listed) and proposes the result as ONE pull request. Every step is
 * `AppBlueprintUpgradeService.run`'s work, so this file is deliberately thin.
 *
 * ## Why the run happens in the API process
 *
 * The run writes the App spec state row and Activity, and a Trigger worker owns no
 * `DataSource`. The worker therefore reaches `AppBlueprintApplyRunner` — a one-method
 * facade over the service — through the internal RPC channel, registered by name in
 * `TriggerInternalController.remoteMap` (the `AppForkReadinessRunner` /
 * `AppBuildPrepareRunner` shape). With the name absent, the proxy's call rejects and this
 * run reports `failed` with the RPC's own message: a named failure, never a green run
 * that proposed nothing.
 *
 * ## Who queues it
 *
 * `APP_BLUEPRINT_APPLY_DISPATCHER`, bound in the agent `AppWorksModule` to
 * `TriggerService.dispatchAppBlueprintApply`. With no runtime the service runs the same
 * body in the API process itself, so this task's existence does not gate the feature.
 */

/** The task id — equal to `APP_BLUEPRINT_APPLY_JOB_ID` on the API side (pinned by a spec). */
export const APP_BLUEPRINT_APPLY_TASK_ID = 'app-blueprint-apply' as const;

/** The RPC name the API registers the runner under. */
export const APP_BLUEPRINT_APPLY_RUNNER_REMOTE_NAME = 'AppBlueprintApplyRunner' as const;

/** The one method this job calls. */
export interface AppBlueprintApplyRunnerSeam {
    run(payload: AppBlueprintApplyJobPayload): Promise<unknown>;
}

/** Nest token of the runner proxy inside this worker context. */
export const APP_BLUEPRINT_APPLY_RUNNER_SEAM = Symbol('APP_BLUEPRINT_APPLY_RUNNER_SEAM');

@Module({
    imports: [TriggerWorkerModule],
    providers: [
        {
            provide: APP_BLUEPRINT_APPLY_RUNNER_SEAM,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppBlueprintApplyRunner'),
            inject: [TriggerInternalApiClient],
        },
    ],
})
export class AppBlueprintApplyWorkerModule {}

/** What one run reports — `status` is the discriminant every App Works job uses. */
export interface AppBlueprintApplyTaskResult {
    readonly status: 'ran' | 'skipped' | 'failed';
    readonly jobId: string;
    readonly workId: string | null;
    readonly mode: string | null;
    /** The runner's own result (`proposed` · `unchanged` · `failed` · `skipped`), when it answered. */
    readonly result: unknown;
    readonly reason: string | null;
    readonly error: string | null;
}

/** The handler, runtime-neutral, so a spec drives it with a fake runner. */
export async function runAppBlueprintApplyTask(
    payload: AppBlueprintApplyJobPayload,
    runner: AppBlueprintApplyRunnerSeam | null | undefined,
): Promise<AppBlueprintApplyTaskResult> {
    const workId = typeof payload?.workId === 'string' ? payload.workId : null;
    const mode = typeof payload?.mode === 'string' ? payload.mode : null;
    const base = { jobId: APP_BLUEPRINT_APPLY_TASK_ID, workId, mode };
    if (!workId) {
        return { ...base, status: 'skipped', result: null, reason: 'invalidPayload', error: null };
    }
    if (!runner || typeof runner.run !== 'function') {
        return {
            ...base,
            status: 'skipped',
            result: null,
            reason: 'runnerUnavailable',
            error: null,
        };
    }
    try {
        const result = await runner.run(payload);
        return { ...base, status: 'ran', result, reason: null, error: null };
    } catch (error) {
        return {
            ...base,
            status: 'failed',
            result: null,
            reason: 'runFailed',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export const appBlueprintApplyTask = task<
    typeof APP_BLUEPRINT_APPLY_TASK_ID,
    AppBlueprintApplyJobPayload
>({
    id: APP_BLUEPRINT_APPLY_TASK_ID,
    // Plan §6.1 — 300 s, retries 1. A retry is safe: the run updates the one open pull
    // request on its branch and commits only when the file differs.
    maxDuration: 300,
    retry: { maxAttempts: 1 },
    run: async (payload): Promise<AppBlueprintApplyTaskResult> =>
        withWorkerContext(
            'AppBlueprintApply',
            async (appContext): Promise<AppBlueprintApplyTaskResult> => {
                let runner: AppBlueprintApplyRunnerSeam | null = null;
                try {
                    runner = appContext.get<AppBlueprintApplyRunnerSeam>(
                        APP_BLUEPRINT_APPLY_RUNNER_SEAM,
                    );
                } catch {
                    runner = null;
                }
                const outcome = await runAppBlueprintApplyTask(payload, runner);
                if (outcome.status === 'ran') {
                    logger.info('app-blueprint-apply finished', {
                        workId: outcome.workId,
                        mode: outcome.mode,
                        result: outcome.result,
                    });
                } else {
                    logger.error(
                        `app-blueprint-apply: work ${outcome.workId ?? '?'} ${outcome.status}`,
                        {
                            reason: outcome.reason,
                            error: outcome.error,
                        },
                    );
                }
                return outcome;
            },
            AppBlueprintApplyWorkerModule,
        ),
});
